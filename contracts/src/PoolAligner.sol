// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SwapDesk} from "./SwapDesk.sol";
import {TestToken} from "./TestToken.sol";
import {PriceMath} from "./PriceMath.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3.sol";

/// @title PoolAligner
/// @notice Testnet only. Plays the arbitrageur that keeps HSKSwap testnet pools in line with the (mirrored)
///         mainnet oracle price: for every pool that drifted more than `minGapBps` away, it swaps directly against
///         the pool with the oracle price as the limit, minting the test tokens it owes and burning what it
///         receives. On mainnet real arbitrageurs do this job, so the aligner is never deployed there.
contract PoolAligner {
    SwapDesk public immutable desk;

    address public owner;
    address public keeper;
    address internal _activePool;

    event Aligned(
        address indexed token,
        address indexed pool,
        uint256 poolPriceBefore,
        uint256 poolPriceAfter,
        uint256 oraclePrice
    );
    event KeeperChanged(address indexed keeper);

    error NotOwner();
    error NotKeeper();
    error UnexpectedCallback();

    constructor(SwapDesk desk_, address keeper_) {
        desk = desk_;
        owner = msg.sender;
        keeper = keeper_;
        emit KeeperChanged(keeper_);
    }

    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert NotOwner();
        keeper = keeper_;
        emit KeeperChanged(keeper_);
    }

    /// @notice Moves each listed pool back to its oracle price if it drifted at least `minGapBps`.
    /// @return moved How many pools were moved.
    function align(address[] calldata tokens, uint256 minGapBps) external returns (uint256 moved) {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeper();
        uint8 usdDecimals = desk.usdDecimals();
        for (uint256 i; i < tokens.length; ++i) {
            address token = tokens[i];
            SwapDesk.Market memory m = desk.market(token);
            (uint256 price, uint8 fd,) = desk.priceOf(token);
            uint256 before = desk.poolPrice(token);
            if (PriceMath.deviationBps(before, price) < minGapBps) continue;

            uint160 target = PriceMath.sqrtFromPrice(price, m.tokenIsToken0, m.tokenDecimals, usdDecimals, fd);
            (uint160 current,,,,,,) = m.pool.slot0();
            if (target == current) continue;

            _activePool = address(m.pool);
            m.pool.swap(address(this), target < current, int256(uint256(type(uint128).max)), target, "");
            _activePool = address(0);

            _burnAll(m.pool.token0());
            _burnAll(m.pool.token1());
            ++moved;
            emit Aligned(token, address(m.pool), before, desk.poolPrice(token), price);
        }
    }

    /// @dev Pays the pool by minting the owed test token.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _activePool || _activePool == address(0)) revert UnexpectedCallback();
        IUniswapV3Pool pool = IUniswapV3Pool(msg.sender);
        if (amount0Delta > 0) TestToken(pool.token0()).mint(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) TestToken(pool.token1()).mint(msg.sender, uint256(amount1Delta));
    }

    function _burnAll(address token) internal {
        uint256 bal = TestToken(token).balanceOf(address(this));
        if (bal != 0) TestToken(token).burn(bal);
    }
}
