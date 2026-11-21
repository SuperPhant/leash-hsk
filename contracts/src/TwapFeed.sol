// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

interface IUniswapV3PoolOracle {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @title TwapFeed
/// @notice AggregatorV3-compatible USD price of a token, read as a time-weighted average from its HSKSwap
///         (Uniswap V3) pool against a USD stablecoin. Used on mainnet, where APRO's feeds only answer whitelisted
///         contracts; the {SwapDesk} then compares the pool's spot price with this average before every swap, so
///         a sudden move inside the window blocks trading instead of being traded into.
/// @dev    The stablecoin is treated as worth exactly 1 USD. `latestRoundData` is computed on every call, so
///         `updatedAt` is always the current block time and the round id is that timestamp.
contract TwapFeed is AggregatorV3Interface {
    uint256 internal constant Q128 = 1 << 128;
    /// @dev 1.0001 in Q128.
    uint256 internal constant BASE = Q128 + Q128 / 10_000;
    /// @dev Keeps 1.0001^|tick| below 2^58 so the Q128 maths cannot overflow (covers prices from 1e-17 to 1e17).
    int256 internal constant MAX_ABS_TICK = 400_000;

    IUniswapV3PoolOracle public immutable pool;
    address public immutable token;
    bool public immutable tokenIsToken0;
    uint8 public immutable tokenDecimals;
    uint8 public immutable usdDecimals;
    uint32 public immutable window;
    uint8 public constant decimals = 8;

    string public description;

    error NotInPool();
    error TickOutOfRange(int256 tick);
    error NoRounds();

    constructor(IUniswapV3PoolOracle pool_, address token_, uint32 window_, string memory description_) {
        address t0 = pool_.token0();
        address t1 = pool_.token1();
        if (token_ != t0 && token_ != t1) revert NotInPool();
        pool = pool_;
        token = token_;
        tokenIsToken0 = token_ == t0;
        tokenDecimals = IERC20Metadata(token_).decimals();
        usdDecimals = IERC20Metadata(token_ == t0 ? t1 : t0).decimals();
        window = window_;
        description = description_;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80) external pure returns (uint80, int256, uint256, uint256, uint80) {
        revert NoRounds();
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 price = priceAtTick(meanTick());
        uint80 id = uint80(block.timestamp);
        return (id, int256(price), block.timestamp - window, block.timestamp, id);
    }

    /// @notice Arithmetic mean tick over the window, rounded towards negative infinity.
    function meanTick() public view returns (int24) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = window;
        (int56[] memory cumulatives,) = pool.observe(ago);
        int56 delta = cumulatives[1] - cumulatives[0];
        int56 w = int56(uint56(window));
        int24 tick = int24(delta / w);
        if (delta < 0 && delta % w != 0) tick--;
        return tick;
    }

    /// @notice USD price of one whole token at `tick`, with 8 decimals.
    function priceAtTick(int24 tick) public view returns (uint256) {
        // Pool price is token1 per token0 = 1.0001^tick; USD per token is that or its inverse.
        int256 t = tokenIsToken0 ? int256(tick) : -int256(tick);
        if (t > MAX_ABS_TICK || t < -MAX_ABS_TICK) revert TickOutOfRange(t);
        uint256 powX128 = _pow(uint256(t < 0 ? -t : t));
        uint256 usdPerRawX128 = t < 0 ? Math.mulDiv(Q128, Q128, powX128) : powX128;
        return Math.mulDiv(usdPerRawX128, 10 ** (uint256(tokenDecimals) + decimals), Q128 * 10 ** usdDecimals);
    }

    /// @dev 1.0001^n in Q128 by binary exponentiation.
    function _pow(uint256 n) internal pure returns (uint256 result) {
        result = Q128;
        uint256 base = BASE;
        while (n != 0) {
            if (n & 1 != 0) result = Math.mulDiv(result, base, Q128);
            n >>= 1;
            if (n != 0) base = Math.mulDiv(base, base, Q128);
        }
    }
}
