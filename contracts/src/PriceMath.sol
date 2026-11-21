// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title PriceMath
/// @notice Converts between a Uniswap V3 pool's sqrtPriceX96 and a USD price per whole token with a feed's
///         decimals, so pool prices and oracle answers can be compared directly.
library PriceMath {
    uint256 internal constant Q64 = 1 << 64;
    uint256 internal constant Q128 = 1 << 128;
    uint256 internal constant Q192 = 1 << 192;

    /// @notice USD price of one whole `token` implied by `sqrtPriceX96`, scaled to `priceDecimals`.
    /// @param tokenIsToken0 Whether `token` is the pool's token0 (the quote token is the other side).
    function priceFromSqrt(
        uint160 sqrtPriceX96,
        bool tokenIsToken0,
        uint8 tokenDecimals,
        uint8 usdDecimals,
        uint8 priceDecimals
    ) internal pure returns (uint256) {
        // token1 per token0 in raw units, as a Q128 number; fits in 256 bits because sqrtPriceX96 < 2^160.
        uint256 ratioX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, Q64);
        uint256 scale = 10 ** (uint256(tokenDecimals) + priceDecimals);
        if (tokenIsToken0) {
            return Math.mulDiv(ratioX128, scale, Q128 * 10 ** usdDecimals);
        }
        if (ratioX128 == 0) return type(uint256).max;
        return Math.mulDiv(Q128, scale, ratioX128) / 10 ** usdDecimals;
    }

    /// @notice The sqrtPriceX96 at which one whole `token` is worth `price` (with `priceDecimals`) in USD.
    function sqrtFromPrice(
        uint256 price,
        bool tokenIsToken0,
        uint8 tokenDecimals,
        uint8 usdDecimals,
        uint8 priceDecimals
    ) internal pure returns (uint160) {
        uint256 tokenUnit = 10 ** (uint256(tokenDecimals) + priceDecimals);
        uint256 usdUnit = price * 10 ** usdDecimals;
        // ratio = token1 raw per token0 raw.
        uint256 ratioX192 =
            tokenIsToken0 ? Math.mulDiv(usdUnit, Q192, tokenUnit) : Math.mulDiv(tokenUnit, Q192, usdUnit);
        return uint160(Math.sqrt(ratioX192));
    }

    /// @notice |a - b| / b in basis points.
    function deviationBps(uint256 a, uint256 b) internal pure returns (uint256) {
        if (b == 0) return type(uint256).max;
        uint256 diff = a > b ? a - b : b - a;
        return Math.mulDiv(diff, 10_000, b);
    }
}
