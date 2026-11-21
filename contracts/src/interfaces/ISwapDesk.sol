// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "./AggregatorV3Interface.sol";

/// @notice What a {LeashVault} needs from its trading venue: oracle prices to value positions and enforce the
///         mandate, and swaps that pay out only to the caller.
interface ISwapDesk {
    function usd() external view returns (IERC20);

    function usdDecimals() external view returns (uint8);

    function isListed(address token) external view returns (bool);

    function feedOf(address token) external view returns (AggregatorV3Interface);

    /// @notice Latest oracle price for one whole token, with the feed's decimals.
    function priceOf(address token) external view returns (uint256 price, uint8 feedDecimals, uint256 updatedAt);

    /// @notice USD value (in `usd` units) of `raw` token units at the oracle price.
    function valueOf(address token, uint256 raw) external view returns (uint256);

    /// @notice Raw token units worth `usdAmount` at the oracle price.
    function unitsFor(address token, uint256 usdAmount) external view returns (uint256);

    /// @notice Spot price of one whole token in the DEX pool, with the feed's decimals.
    function poolPrice(address token) external view returns (uint256);

    function buy(address token, uint256 usdIn, uint256 minOut) external returns (uint256 out);

    function sell(address token, uint256 rawIn, uint256 minOut) external returns (uint256 out);
}
