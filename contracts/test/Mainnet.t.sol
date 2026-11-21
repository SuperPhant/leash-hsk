// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SwapDesk} from "../src/SwapDesk.sol";
import {TwapFeed, IUniswapV3PoolOracle} from "../src/TwapFeed.sol";
import {PriceMath} from "../src/PriceMath.sol";
import {LeashVault} from "../src/LeashVault.sol";
import {LeashFactory} from "../src/LeashFactory.sol";
import {AggregatorV3Interface} from "../src/interfaces/AggregatorV3Interface.sol";
import {IUniswapV3Factory, ISwapRouter02} from "../src/interfaces/IUniswapV3.sol";

/// @notice The mainnet configuration: real USDT, WHSK and WBTC on HSK Chain, priced by 30-minute HSKSwap TWAPs
///         (APRO's feeds there only answer whitelisted contracts) and traded in the real HSKSwap pools.
contract LeashHskMainnetTest is Test {
    address internal constant USDT = 0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029;
    address internal constant WHSK = 0xB210D2120d57b758EE163cFfb43e73728c471Cf1;
    address internal constant WBTC = 0x6119CA49a79f5825C8B345F8d7aC36B272565b14;
    address internal constant HSKSWAP_FACTORY = 0x972cA9D1662F5e029cD18327D29026532E84c742;
    address internal constant HSKSWAP_ROUTER = 0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3;
    address internal constant APRO_HSK = 0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b;
    address internal constant APRO_BTC = 0x204ED500ab56A2E19B051561258E3A45c850360F;
    address internal constant POOL_WHSK = 0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC;
    address internal constant POOL_WBTC = 0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A;

    SwapDesk internal desk;
    LeashFactory internal factory;
    address internal owner = makeAddr("owner");
    address internal agent = makeAddr("agent");

    function setUp() public {
        vm.createSelectFork("https://mainnet.hsk.xyz");
        desk =
            new SwapDesk(IERC20(USDT), IUniswapV3Factory(HSKSWAP_FACTORY), ISwapRouter02(HSKSWAP_ROUTER), 300, 1 days);
        TwapFeed hskFeed =
            new TwapFeed(IUniswapV3PoolOracle(POOL_WHSK), WHSK, 30 minutes, "HSK / USD (HSKSwap 30m TWAP)");
        TwapFeed btcFeed =
            new TwapFeed(IUniswapV3PoolOracle(POOL_WBTC), WBTC, 30 minutes, "BTC / USD (HSKSwap 30m TWAP)");
        desk.list(WHSK, hskFeed, 3000);
        desk.list(WBTC, btcFeed, 3000);
        factory = new LeashFactory(desk);
    }

    function test_AproIsAccessControlled() public {
        vm.expectRevert(bytes("No access"));
        AggregatorV3Interface(APRO_HSK).latestRoundData();
    }

    function test_TwapTracksApro() public {
        address[2] memory tokens = [WHSK, WBTC];
        address[2] memory apro = [APRO_HSK, APRO_BTC];
        for (uint256 i; i < 2; ++i) {
            // Off-chain style read (sender == origin), the way the keeper reads APRO.
            vm.prank(address(0x1234), address(0x1234));
            (, int256 aproAnswer,,,) = AggregatorV3Interface(apro[i]).latestRoundData();
            console2.log("apro  ", uint256(aproAnswer));
            (uint256 oracle, uint256 spot, uint256 updatedAt, uint256 gap, bool tradable) = desk.check(tokens[i]);
            console2.log("oracle", oracle);
            console2.log("pool  ", spot);
            console2.log("age s ", block.timestamp - updatedAt);
            console2.log("gapBps", gap);
            console2.log("ok    ", tradable);
            assertLt(PriceMath.deviationBps(oracle, uint256(aproAnswer)), 500);
        }
    }

    function test_VaultTradesOnMainnetHskSwap() public {
        deal(USDT, owner, 1_000e6);
        address[] memory assets = new address[](2);
        (assets[0], assets[1]) = (WHSK, WBTC);
        uint16[] memory caps = new uint16[](2);
        (caps[0], caps[1]) = (5_000, 5_000);
        LeashVault.Mandate memory m = LeashVault.Mandate({
            minCashBps: 1_000,
            maxTurnoverBps: 20_000,
            turnoverWindow: 1 days,
            maxSlippageBps: 300,
            maxOracleAge: 1 days,
            cooldown: 1 hours,
            stopLossBps: 800,
            maxDrawdownBps: 1_500,
            expiry: uint64(block.timestamp + 30 days)
        });
        vm.startPrank(owner);
        IERC20(USDT).approve(address(factory), 1_000e6);
        LeashVault vault = LeashVault(factory.createVault(agent, assets, caps, m, 1_000e6));
        vm.stopPrank();

        (,,,, bool hskOk) = desk.check(WHSK);
        vm.skip(!hskOk);
        LeashVault.Trade[] memory trades = new LeashVault.Trade[](1);
        trades[0] = LeashVault.Trade(WHSK, true, 200e6, 0);
        vm.prank(agent);
        vault.rebalance(trades, keccak256("mainnet"), "");
        assertGt(IERC20(WHSK).balanceOf(address(vault)), 0);
        assertApproxEqRel(vault.nav(), 1_000e6, 0.02e18);
    }
}
