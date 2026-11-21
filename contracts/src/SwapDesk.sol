// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {ISwapDesk} from "./interfaces/ISwapDesk.sol";
import {IUniswapV3Factory, IUniswapV3Pool, ISwapRouter02} from "./interfaces/IUniswapV3.sol";
import {PriceMath} from "./PriceMath.sol";

/// @title SwapDesk
/// @notice Routes Leash vault trades through HSKSwap (Uniswap V3) pools and prices them with oracle feeds.
///         Every listed token has a USD feed (APRO on mainnet, a mirror of the mainnet feeds on testnet) and a
///         token/USD pool. Before each swap the desk checks that the feed is fresh and that the pool's spot
///         price is within `maxDeviationBps` of it, so a vault never trades into a manipulated or stale pool.
///         Output always goes to `msg.sender`; the desk never holds funds between calls.
contract SwapDesk is ISwapDesk {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint16 public constant MAX_DEVIATION_LIMIT_BPS = 2_000;

    struct Market {
        AggregatorV3Interface feed;
        IUniswapV3Pool pool;
        uint24 fee;
        uint8 tokenDecimals;
        bool tokenIsToken0;
    }

    IERC20 public immutable usd;
    uint8 public immutable usdDecimals;
    IUniswapV3Factory public immutable factory;
    ISwapRouter02 public immutable router;

    address public owner;
    uint16 public maxDeviationBps;
    uint32 public maxOracleAge;

    mapping(address token => Market) internal _markets;
    address[] internal _tokens;

    event Listed(address indexed token, address indexed feed, address indexed pool, uint24 fee);
    event Traded(
        address indexed trader,
        address indexed token,
        bool buy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 oraclePrice,
        uint256 poolPriceBefore
    );
    event ParamsSet(uint16 maxDeviationBps, uint32 maxOracleAge);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotListed(address token);
    error NoPool(address token, uint24 fee);
    error BadPrice(address token);
    error StalePrice(address token, uint256 updatedAt);
    error PoolOffOracle(address token, uint256 poolPrice, uint256 oraclePrice);
    error InsufficientOutput(uint256 out, uint256 minOut);
    error ZeroAmount();
    error BadParams();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        IERC20 usd_,
        IUniswapV3Factory factory_,
        ISwapRouter02 router_,
        uint16 maxDeviationBps_,
        uint32 maxOracleAge_
    ) {
        if (maxDeviationBps_ == 0 || maxDeviationBps_ > MAX_DEVIATION_LIMIT_BPS || maxOracleAge_ == 0) {
            revert BadParams();
        }
        usd = usd_;
        usdDecimals = IERC20Metadata(address(usd_)).decimals();
        factory = factory_;
        router = router_;
        owner = msg.sender;
        maxDeviationBps = maxDeviationBps_;
        maxOracleAge = maxOracleAge_;
        emit OwnerChanged(msg.sender);
        emit ParamsSet(maxDeviationBps_, maxOracleAge_);
    }

    /*//////////////////////////////////////////////////////////////
                                ADMIN
    //////////////////////////////////////////////////////////////*/

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function setParams(uint16 maxDeviationBps_, uint32 maxOracleAge_) external onlyOwner {
        if (maxDeviationBps_ == 0 || maxDeviationBps_ > MAX_DEVIATION_LIMIT_BPS || maxOracleAge_ == 0) {
            revert BadParams();
        }
        maxDeviationBps = maxDeviationBps_;
        maxOracleAge = maxOracleAge_;
        emit ParamsSet(maxDeviationBps_, maxOracleAge_);
    }

    /// @notice Lists `token` with its USD `feed`, trading in the token/USD pool of the given fee tier.
    function list(address token, AggregatorV3Interface feed, uint24 fee) external onlyOwner {
        address pool = factory.getPool(token, address(usd), fee);
        if (pool == address(0)) revert NoPool(token, fee);
        if (address(_markets[token].feed) == address(0)) _tokens.push(token);
        _markets[token] = Market({
            feed: feed,
            pool: IUniswapV3Pool(pool),
            fee: fee,
            tokenDecimals: IERC20Metadata(token).decimals(),
            tokenIsToken0: IUniswapV3Pool(pool).token0() == token
        });
        emit Listed(token, address(feed), pool, fee);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function market(address token) external view returns (Market memory) {
        return _market(token);
    }

    function isListed(address token) external view returns (bool) {
        return address(_markets[token].feed) != address(0);
    }

    function feedOf(address token) external view returns (AggregatorV3Interface) {
        return _markets[token].feed;
    }

    function priceOf(address token) public view returns (uint256 price, uint8 feedDecimals, uint256 updatedAt) {
        AggregatorV3Interface feed = _market(token).feed;
        (, int256 answer,, uint256 updated,) = feed.latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        return (uint256(answer), feed.decimals(), updated);
    }

    function valueOf(address token, uint256 raw) public view returns (uint256) {
        (uint256 price, uint8 fd,) = priceOf(token);
        return Math.mulDiv(raw, price * 10 ** usdDecimals, 10 ** (uint256(_markets[token].tokenDecimals) + fd));
    }

    function unitsFor(address token, uint256 usdAmount) public view returns (uint256) {
        (uint256 price, uint8 fd,) = priceOf(token);
        return Math.mulDiv(usdAmount, 10 ** (uint256(_markets[token].tokenDecimals) + fd), price * 10 ** usdDecimals);
    }

    function poolPrice(address token) public view returns (uint256) {
        Market memory m = _market(token);
        (uint160 sqrtPriceX96,,,,,,) = m.pool.slot0();
        return PriceMath.priceFromSqrt(sqrtPriceX96, m.tokenIsToken0, m.tokenDecimals, usdDecimals, m.feed.decimals());
    }

    /// @notice Oracle price, pool price, oracle timestamp and their gap; what the guard checks before a swap.
    function check(address token)
        external
        view
        returns (uint256 oraclePrice, uint256 spot, uint256 updatedAt, uint256 deviationBps, bool tradable)
    {
        (oraclePrice,, updatedAt) = priceOf(token);
        spot = poolPrice(token);
        deviationBps = PriceMath.deviationBps(spot, oraclePrice);
        tradable = block.timestamp <= updatedAt + maxOracleAge && deviationBps <= maxDeviationBps;
    }

    /*//////////////////////////////////////////////////////////////
                                TRADING
    //////////////////////////////////////////////////////////////*/

    function buy(address token, uint256 usdIn, uint256 minOut) external returns (uint256 out) {
        if (usdIn == 0) revert ZeroAmount();
        (Market memory m, uint256 price, uint256 spot) = _guard(token);
        usd.safeTransferFrom(msg.sender, address(this), usdIn);
        usd.forceApprove(address(router), usdIn);
        out = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(usd),
                tokenOut: token,
                fee: m.fee,
                recipient: msg.sender,
                amountIn: usdIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        if (out == 0 || out < minOut) revert InsufficientOutput(out, minOut);
        emit Traded(msg.sender, token, true, usdIn, out, price, spot);
    }

    function sell(address token, uint256 rawIn, uint256 minOut) external returns (uint256 out) {
        if (rawIn == 0) revert ZeroAmount();
        (Market memory m, uint256 price, uint256 spot) = _guard(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), rawIn);
        IERC20(token).forceApprove(address(router), rawIn);
        out = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: token,
                tokenOut: address(usd),
                fee: m.fee,
                recipient: msg.sender,
                amountIn: rawIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        if (out == 0 || out < minOut) revert InsufficientOutput(out, minOut);
        emit Traded(msg.sender, token, false, rawIn, out, price, spot);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _market(address token) internal view returns (Market memory m) {
        m = _markets[token];
        if (address(m.feed) == address(0)) revert NotListed(token);
    }

    function _guard(address token) internal view returns (Market memory m, uint256 price, uint256 spot) {
        m = _market(token);
        uint256 updatedAt;
        (price,, updatedAt) = priceOf(token);
        if (block.timestamp > updatedAt + maxOracleAge) revert StalePrice(token, updatedAt);
        spot = poolPrice(token);
        if (PriceMath.deviationBps(spot, price) > maxDeviationBps) revert PoolOffOracle(token, spot, price);
    }
}
