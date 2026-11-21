// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestToken} from "../src/TestToken.sol";
import {MirrorFeedHub} from "../src/MirrorFeedHub.sol";
import {SwapDesk} from "../src/SwapDesk.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashFactory} from "../src/LeashFactory.sol";
import {PoolAligner} from "../src/PoolAligner.sol";
import {PriceMath} from "../src/PriceMath.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {
    IUniswapV3Factory,
    IUniswapV3Pool,
    ISwapRouter02,
    INonfungiblePositionManager
} from "../src/interfaces/IUniswapV3.sol";

/// @notice Runs against an HSK Chain testnet fork, so swaps go through the real HSKSwap factory, pools and router.
contract LeashHskTest is Test {
    address internal constant HSKSWAP_FACTORY = 0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0;
    address internal constant HSKSWAP_NPM = 0x73dEc6bfa6751509b08480bd97f54b874E3b20e8;
    address internal constant HSKSWAP_ROUTER = 0xa6914E66690c6794244B5f66a09eAEbf66254237;
    address internal constant APRO_HSK = 0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b;
    address internal constant APRO_BTC = 0x204ED500ab56A2E19B051561258E3A45c850360F;
    address internal constant MAINNET_WETH_POOL = 0xb92b79ed6b370D5cFee2E14B1D0983C258304C16;
    uint24 internal constant FEE = 3000;
    int24 internal constant MAX_TICK = 887_220;

    TestToken internal usdt;
    TestToken internal hsk;
    TestToken internal wbtc;
    TestToken internal weth;
    MirrorFeedHub internal hub;
    SwapDesk internal desk;
    LeashFactory internal factory;
    PoolAligner internal aligner;

    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");

    mapping(uint256 feedId => uint80) internal rounds;

    function setUp() public {
        vm.createSelectFork("https://testnet.hsk.xyz");
        usdt = new TestToken("Leash Test USDT", "tUSDT", 6);
        hsk = new TestToken("Leash Test HSK", "tHSK", 18);
        wbtc = new TestToken("Leash Test WBTC", "tWBTC", 8);
        weth = new TestToken("Leash Test WETH", "tWETH", 18);

        hub = new MirrorFeedHub(address(this));
        (, address hskFeed) = hub.addFeed(APRO_HSK, 8, "HSK / USD");
        (, address btcFeed) = hub.addFeed(APRO_BTC, 8, "BTC / USD");
        (, address ethFeed) = hub.addFeed(MAINNET_WETH_POOL, 8, "ETH / USD");
        _relay(0, 0.08e8);
        _relay(1, 55_000e8);
        _relay(2, 3_000e8);

        desk = new SwapDesk(
            IERC20(address(usdt)), IUniswapV3Factory(HSKSWAP_FACTORY), ISwapRouter02(HSKSWAP_ROUTER), 200, 1 days
        );
        _createPool(hsk, 0.08e8);
        _createPool(wbtc, 55_000e8);
        _createPool(weth, 3_000e8);
        desk.list(address(hsk), AggregatorV3Interface(hskFeed), FEE);
        desk.list(address(wbtc), AggregatorV3Interface(btcFeed), FEE);
        desk.list(address(weth), AggregatorV3Interface(ethFeed), FEE);

        aligner = new PoolAligner(desk, keeper);
        usdt.setMinter(address(aligner), true);
        hsk.setMinter(address(aligner), true);
        wbtc.setMinter(address(aligner), true);
        weth.setMinter(address(aligner), true);

        factory = new LeashFactory(desk);
        usdt.mint(owner, 1_000_000e6);
    }

    /*//////////////////////////////////////////////////////////////
                                 TESTS
    //////////////////////////////////////////////////////////////*/

    function test_PriceMathRoundTrip() public view {
        assertApproxEqRel(desk.poolPrice(address(hsk)), 0.08e8, 1e14);
        assertApproxEqRel(desk.poolPrice(address(wbtc)), 55_000e8, 1e14);
        assertApproxEqRel(desk.poolPrice(address(weth)), 3_000e8, 1e14);
    }

    function test_BuyAndSellThroughHskSwap() public {
        LeashVault vault = _vault(_mandate(0, 0), 100_000e6);
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](2);
        trades[0] = LeashVault.Trade(address(wbtc), true, 30_000e6, 0);
        trades[1] = LeashVault.Trade(address(hsk), true, 20_000e6, 0);
        vm.prank(agent);
        vault.rebalance(trades, keccak256("r1"), "ipfs://r1");

        assertApproxEqRel(wbtc.balanceOf(address(vault)), uint256(30_000e6) * 1e8 / 55_000e6, 0.01e18);
        assertApproxEqRel(hsk.balanceOf(address(vault)), uint256(20_000e6) * 1e18 / 0.08e6, 0.01e18);
        assertApproxEqRel(vault.entryPrice(address(wbtc)), 55_000e8, 0.01e18);
        assertApproxEqRel(vault.nav(), 100_000e6, 0.01e18);
        assertEq(vault.epoch(), 1);

        vm.warp(block.timestamp + 2 hours);
        _relay(0, 0.08e8);
        _relay(1, 55_000e8);
        _relay(2, 3_000e8);
        trades = new LeashVault.Trade[](1);
        trades[0] = LeashVault.Trade(address(wbtc), false, wbtc.balanceOf(address(vault)), 0);
        vm.prank(agent);
        vault.rebalance(trades, keccak256("r2"), "ipfs://r2");
        assertEq(wbtc.balanceOf(address(vault)), 0);
        assertEq(vault.entryPrice(address(wbtc)), 0);
    }

    function test_StopLossSellsAndBlocksReentry() public {
        LeashVault vault = _vault(_mandate(500, 0), 100_000e6);
        _buy(vault, address(wbtc), 30_000e6);

        // BTC -4%: not yet.
        _move(1, 52_800e8);
        (LeashVault.ExitReason reason,,) = vault.exitStatus(address(wbtc));
        assertEq(uint8(reason), uint8(LeashVault.ExitReason.None));
        vm.expectRevert(abi.encodeWithSelector(LeashVault.RiskRuleNotTriggered.selector, address(wbtc)));
        vault.stopOut(address(wbtc));

        // BTC -8%: anyone may stop it out.
        _move(1, 50_600e8);
        (reason,,) = vault.exitStatus(address(wbtc));
        assertEq(uint8(reason), uint8(LeashVault.ExitReason.StopLoss));
        vm.prank(stranger);
        uint256 out = vault.stopOut(address(wbtc));
        assertGt(out, 25_000e6);
        assertEq(wbtc.balanceOf(address(vault)), 0);
        assertGt(vault.buyBlockedUntil(address(wbtc)), block.timestamp);

        // Cooldown (30 min) is over, but the stop-out blocks buying BTC again for an hour.
        vm.warp(block.timestamp + 45 minutes);
        _refresh();
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](1);
        trades[0] = LeashVault.Trade(address(wbtc), true, 10_000e6, 0);
        uint256 until = vault.buyBlockedUntil(address(wbtc));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(LeashVault.BuyBlocked.selector, address(wbtc), until));
        vault.rebalance(trades, bytes32(0), "");

        vm.warp(until);
        _refresh();
        vm.prank(agent);
        vault.rebalance(trades, bytes32(0), "");
        assertGt(wbtc.balanceOf(address(vault)), 0);
    }

    function test_DrawdownBreakerOnlyAllowsSelling() public {
        LeashVault vault = _vault(_mandate(0, 1_000), 100_000e6);
        _buy(vault, address(wbtc), 40_000e6);
        _buy(vault, address(weth), 40_000e6);

        _move(1, 41_250e8); // BTC -25%
        _move(2, 2_250e8); // ETH -25%
        assertTrue(vault.breakerTripped());
        assertGt(vault.drawdownBps(), 1_000);

        vm.warp(block.timestamp + 2 hours);
        _refresh();
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](1);
        trades[0] = LeashVault.Trade(address(hsk), true, 1_000e6, 0);
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.DrawdownBreached.selector);
        vault.rebalance(trades, bytes32(0), "");

        vm.prank(stranger);
        vault.stopOut(address(weth));
        assertEq(weth.balanceOf(address(vault)), 0);

        vm.prank(owner);
        vault.resetPeak();
        assertFalse(vault.breakerTripped());
        vm.prank(agent);
        vault.rebalance(trades, bytes32(0), "");
        assertGt(hsk.balanceOf(address(vault)), 0);
    }

    function test_RefusesToTradeIntoPoolOffOracle() public {
        LeashVault vault = _vault(_mandate(0, 0), 100_000e6);
        _relay(2, 3_300e8); // oracle +10%, pool not aligned yet
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](1);
        trades[0] = LeashVault.Trade(address(weth), true, 10_000e6, 0);
        vm.prank(agent);
        vm.expectPartialRevert(SwapDesk.PoolOffOracle.selector);
        vault.rebalance(trades, bytes32(0), "");

        vm.prank(keeper);
        assertEq(aligner.align(_tokens(), 10), 1);
        assertApproxEqRel(desk.poolPrice(address(weth)), 3_300e8, 1e14);
        vm.prank(agent);
        vault.rebalance(trades, bytes32(0), "");
    }

    function test_OwnerCanExitWhenOracleFails() public {
        LeashVault vault = _vault(_mandate(500, 1_000), 100_000e6);
        _buy(vault, address(wbtc), 30_000e6);
        vm.mockCallRevert(address(desk.feedOf(address(wbtc))), abi.encodeWithSignature("latestRoundData()"), "down");
        vm.expectRevert();
        vault.nav();

        uint256 half = wbtc.balanceOf(address(vault)) / 2;
        vm.startPrank(owner);
        vault.withdraw(address(wbtc), half, owner);
        vault.withdraw(address(usdt), 10_000e6, owner);
        vault.withdrawAll(owner);
        vm.stopPrank();
        assertEq(usdt.balanceOf(address(vault)), 0);
        assertEq(wbtc.balanceOf(address(vault)), 0);
        assertGt(wbtc.balanceOf(owner), half);
    }

    function test_MandateLimits() public {
        LeashVault vault = _vault(_mandate(0, 0), 100_000e6);
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](1);
        // Cap is 40% for BTC.
        trades[0] = LeashVault.Trade(address(wbtc), true, 45_000e6, 0);
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.WeightCapExceeded.selector);
        vault.rebalance(trades, bytes32(0), "");

        trades[0] = LeashVault.Trade(address(wbtc), true, 10_000e6, 0);
        vm.prank(agent);
        vault.rebalance(trades, bytes32(0), "");
        vm.prank(agent);
        vm.expectPartialRevert(LeashVault.CooldownActive.selector);
        vault.rebalance(trades, bytes32(0), "");

        vm.prank(stranger);
        vm.expectRevert(LeashVault.NotAgent.selector);
        vault.rebalance(trades, bytes32(0), "");
    }

    function test_PnlFollowsPrices() public {
        LeashVault vault = _vault(_mandate(0, 0), 100_000e6);
        _buy(vault, address(wbtc), 40_000e6);
        int256 start = vault.pnl();
        _move(1, 60_500e8); // BTC +10%
        assertGt(vault.pnl(), start + 3_500e6);
    }

    /*//////////////////////////////////////////////////////////////
                                HELPERS
    //////////////////////////////////////////////////////////////*/

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](3);
        (t[0], t[1], t[2]) = (address(hsk), address(wbtc), address(weth));
    }

    function _mandate(uint16 stopLossBps, uint16 maxDrawdownBps) internal view returns (LeashVault.Mandate memory) {
        return LeashVault.Mandate({
            minCashBps: 1_000,
            maxTurnoverBps: 20_000,
            turnoverWindow: 1 days,
            maxSlippageBps: 150,
            maxOracleAge: 1 days,
            cooldown: 30 minutes,
            stopLossBps: stopLossBps,
            maxDrawdownBps: maxDrawdownBps,
            expiry: uint64(block.timestamp + 365 days)
        });
    }

    function _vault(LeashVault.Mandate memory m, uint256 deposit) internal returns (LeashVault vault) {
        address[] memory assets = _tokens();
        uint16[] memory caps = new uint16[](3);
        (caps[0], caps[1], caps[2]) = (3_000, 4_000, 4_000);
        vm.startPrank(owner);
        usdt.approve(address(factory), deposit);
        vault = LeashVault(factory.createVault(agent, assets, caps, m, deposit));
        vm.stopPrank();
        assertEq(vault.netDeposits(), deposit);
    }

    function _buy(LeashVault vault, address token, uint256 usdIn) internal {
        if (vault.lastRebalance() != 0) {
            vm.warp(block.timestamp + 2 hours);
            _refresh();
        }
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](1);
        trades[0] = LeashVault.Trade(token, true, usdIn, 0);
        vm.prank(agent);
        vault.rebalance(trades, bytes32(0), "");
    }

    /// @dev Moves the oracle and lets the keeper align the pool, as the testnet keeper does every run.
    function _move(uint256 feedId, int256 answer) internal {
        _relay(feedId, answer);
        vm.prank(keeper);
        aligner.align(_tokens(), 10);
    }

    function _refresh() internal {
        for (uint256 id; id < 3; ++id) {
            (, MirrorFeedHub.Round memory r) = hub.latest(id);
            _relay(id, r.answer);
        }
    }

    function _relay(uint256 feedId, int256 answer) internal {
        uint80 next = ++rounds[feedId];
        uint256[] memory ids = new uint256[](1);
        uint80[] memory roundIds = new uint80[](1);
        int256[] memory answers = new int256[](1);
        uint64[] memory times = new uint64[](1);
        (ids[0], roundIds[0], answers[0], times[0]) = (feedId, next, answer, uint64(block.timestamp));
        hub.relay(ids, roundIds, answers, times, times);
    }

    function _createPool(TestToken token, uint256 price) internal {
        bool tokenIsToken0 = address(token) < address(usdt);
        (address t0, address t1) = tokenIsToken0 ? (address(token), address(usdt)) : (address(usdt), address(token));
        uint160 sqrtPriceX96 = PriceMath.sqrtFromPrice(price, tokenIsToken0, token.decimals(), 6, 8);
        INonfungiblePositionManager(HSKSWAP_NPM).createAndInitializePoolIfNecessary(t0, t1, FEE, sqrtPriceX96);

        uint256 usdSide = 20_000_000e6;
        uint256 tokenSide = usdSide * 10 ** (uint256(token.decimals()) + 8) / (price * 1e6);
        usdt.mint(address(this), usdSide);
        token.mint(address(this), tokenSide);
        usdt.approve(HSKSWAP_NPM, usdSide);
        token.approve(HSKSWAP_NPM, tokenSide);
        (uint256 a0, uint256 a1) = tokenIsToken0 ? (tokenSide, usdSide) : (usdSide, tokenSide);
        INonfungiblePositionManager(HSKSWAP_NPM)
            .mint(
                INonfungiblePositionManager.MintParams({
                    token0: t0,
                    token1: t1,
                    fee: FEE,
                    tickLower: -MAX_TICK,
                    tickUpper: MAX_TICK,
                    amount0Desired: a0,
                    amount1Desired: a1,
                    amount0Min: 0,
                    amount1Min: 0,
                    recipient: address(this),
                    deadline: block.timestamp
                })
            );
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
