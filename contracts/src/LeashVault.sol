// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ISwapDesk} from "./interfaces/ISwapDesk.sol";

/// @title LeashVault
/// @notice A crypto portfolio on HSK Chain that an AI agent may trade on HSKSwap, but only inside an onchain
///         mandate set by the owner: which tokens, how much of each, how often and how much it may trade, how
///         fresh the oracle must be and how far execution may deviate from it. Two risk rules are enforced by
///         the contract itself rather than by the agent:
///         - stop-loss: once a position trades `stopLossBps` below its average entry price, anyone may sell it,
///           and the agent cannot buy it back for a while;
///         - drawdown breaker: once NAV falls `maxDrawdownBps` below its high-water mark, the agent may only sell,
///           anyone may sell any position, and buying stays off until the owner resets the mark.
///         The agent can only swap through the configured desk, so it can never move funds out of the vault. The
///         owner can pause the agent, change the rules and withdraw everything at any time, even if an oracle fails.
contract LeashVault {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_ASSETS = 8;
    uint256 public constant MAX_TRADES = 16;
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;
    uint256 public constant MAX_RISK_BPS = 9_000;
    uint256 public constant MAX_URI_LENGTH = 256;
    /// @notice Minimum time a stopped-out token stays blocked for buying.
    uint256 public constant MIN_REENTRY_DELAY = 1 hours;

    struct Mandate {
        /// @dev Minimum share of NAV kept in cash after any rebalance that buys.
        uint16 minCashBps;
        /// @dev Maximum traded notional per window, as a share of NAV at the start of the window.
        uint16 maxTurnoverBps;
        /// @dev Length of the turnover window in seconds.
        uint32 turnoverWindow;
        /// @dev Worst accepted execution versus the oracle price.
        uint16 maxSlippageBps;
        /// @dev Oldest accepted oracle update for any traded asset, in seconds.
        uint32 maxOracleAge;
        /// @dev Minimum seconds between two rebalances (the agent's trade frequency).
        uint32 cooldown;
        /// @dev Stop-loss distance below a position's average entry price; 0 turns it off.
        uint16 stopLossBps;
        /// @dev Drawdown from the NAV high-water mark that trips the breaker; 0 turns it off.
        uint16 maxDrawdownBps;
        /// @dev Unix time at which the agent's authority ends.
        uint64 expiry;
    }

    struct Trade {
        address token;
        bool buy;
        /// @dev USD units when buying, raw token units when selling.
        uint256 amountIn;
        /// @dev Agent's own floor; the vault additionally enforces the mandate's oracle-based floor.
        uint256 minAmountOut;
    }

    struct Holding {
        address token;
        string symbol;
        uint8 decimals;
        uint16 capBps;
        uint256 raw;
        uint256 price;
        uint8 priceDecimals;
        uint256 updatedAt;
        uint256 value;
        uint256 weightBps;
        uint256 entryPrice;
        uint256 stopPrice;
        uint64 buyBlockedUntil;
    }

    enum ExitReason {
        None,
        StopLoss,
        Drawdown
    }

    ISwapDesk public immutable desk;
    IERC20 public immutable usd;
    address public immutable factory;

    address public owner;
    address public agent;
    bool public paused;
    Mandate internal _mandate;

    address[] internal _assets;
    mapping(address token => bool) public isAsset;
    mapping(address token => uint16) public capBps;
    /// @notice Average entry price of the current position, in the token's feed units (0 when flat).
    mapping(address token => uint256) public entryPrice;
    mapping(address token => uint64) public buyBlockedUntil;

    /// @notice NAV high-water mark used by the drawdown breaker; deposits and withdrawals move it with NAV.
    uint256 public peakNav;
    /// @notice USD deposited minus the value withdrawn, for profit and loss.
    uint256 public netDeposits;

    uint256 public epoch;
    uint64 public lastRebalance;
    uint64 public windowStart;
    uint256 public windowNav;
    uint256 public windowTurnover;

    bool internal _locked;

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event AgentChanged(address indexed agent);
    event PausedSet(bool paused);
    event CapSet(address indexed token, uint16 capBps);
    event MandateSet(Mandate mandate);
    event PeakReset(uint256 peakNav);
    event TradeExecuted(
        uint256 indexed epoch,
        address indexed token,
        bool buy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 oraclePrice,
        uint256 notional
    );
    event Rebalanced(
        uint256 indexed epoch,
        address indexed agent,
        uint256 navBefore,
        uint256 navAfter,
        uint256 windowTurnover,
        bytes32 rationaleHash,
        string rationaleURI
    );
    event RiskExit(
        address indexed token,
        ExitReason reason,
        uint256 price,
        uint256 entryPrice,
        uint256 amountSold,
        uint256 usdOut,
        address indexed caller
    );

    error NotOwner();
    error NotAgent();
    error Reentrancy();
    error AgentPaused();
    error MandateExpired(uint256 expiry);
    error CooldownActive(uint256 readyAt);
    error NoTrades();
    error TooManyTrades();
    error TooManyAssets();
    error UriTooLong();
    error ZeroAmount();
    error AssetNotAllowed(address token);
    error BuyNotAllowed(address token);
    error BuyBlocked(address token, uint256 until);
    error NotListedOnDesk(address token);
    error DuplicateAsset(address token);
    error BadCap(address token, uint256 capBps);
    error BadMandate();
    error StaleOracle(address token, uint256 updatedAt, uint256 maxAge);
    error SlippageExceeded(address token, uint256 amountOut, uint256 minAmountOut);
    error TurnoverExceeded(uint256 turnover, uint256 limit);
    error CashFloorBreached(uint256 cashBps, uint256 minCashBps);
    error WeightCapExceeded(address token, uint256 weightBps, uint256 capBps);
    error DrawdownBreached(uint256 nav, uint256 floor);
    error NothingToExit(address token);
    error RiskRuleNotTriggered(address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        address owner_,
        address agent_,
        ISwapDesk desk_,
        address[] memory assets_,
        uint16[] memory caps_,
        Mandate memory mandate_
    ) {
        if (assets_.length != caps_.length) revert BadMandate();
        if (assets_.length > MAX_ASSETS) revert TooManyAssets();
        desk = desk_;
        usd = desk_.usd();
        factory = msg.sender;
        owner = owner_;
        agent = agent_;
        for (uint256 i; i < assets_.length; ++i) {
            _addAsset(assets_[i], caps_[i]);
        }
        _setMandate(mandate_);
        emit AgentChanged(agent_);
    }

    /*//////////////////////////////////////////////////////////////
                                OWNER
    //////////////////////////////////////////////////////////////*/

    /// @notice Adds USD. Anyone may deposit; the funds belong to the owner.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usd.safeTransferFrom(msg.sender, address(this), amount);
        netDeposits += amount;
        peakNav += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Owner exit that works even while the agent is paused, the mandate has expired or an oracle is down.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        (bool priced, uint256 navBefore) = _tryNav();
        uint256 value = token == address(usd) ? amount : _tryValue(token, amount);
        IERC20(token).safeTransfer(to, amount);
        netDeposits = netDeposits > value ? netDeposits - value : 0;
        if (priced && navBefore != 0) {
            peakNav -= Math.mulDiv(peakNav, Math.min(value, navBefore), navBefore);
        }
        if (isAsset[token] && IERC20(token).balanceOf(address(this)) == 0) entryPrice[token] = 0;
        emit Withdrawn(token, amount, to);
    }

    function withdrawAll(address to) external onlyOwner nonReentrant {
        uint256 cash = usd.balanceOf(address(this));
        if (cash != 0) {
            usd.safeTransfer(to, cash);
            emit Withdrawn(address(usd), cash, to);
        }
        for (uint256 i; i < _assets.length; ++i) {
            address token = _assets[i];
            uint256 bal = IERC20(token).balanceOf(address(this));
            if (bal != 0) {
                IERC20(token).safeTransfer(to, bal);
                emit Withdrawn(token, bal, to);
            }
            entryPrice[token] = 0;
        }
        netDeposits = 0;
        peakNav = 0;
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    /// @notice Sets the cap of an existing asset, or adds a new desk-listed asset. A cap of 0 means the agent may
    ///         only sell that asset.
    function setCap(address token, uint16 cap) external onlyOwner {
        if (isAsset[token]) {
            if (cap > BPS) revert BadCap(token, cap);
            capBps[token] = cap;
            emit CapSet(token, cap);
        } else {
            _addAsset(token, cap);
        }
    }

    function setMandate(Mandate calldata mandate_) external onlyOwner {
        _setMandate(mandate_);
    }

    /// @notice Re-arms the drawdown breaker at the current NAV.
    function resetPeak() external onlyOwner {
        uint256 current = nav();
        peakNav = current;
        emit PeakReset(current);
    }

    /*//////////////////////////////////////////////////////////////
                                AGENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Executes the agent's trades, then proves the resulting portfolio still satisfies the mandate.
    ///         Any violation reverts the whole rebalance.
    /// @param rationaleHash keccak256 of the published rationale document.
    /// @param rationaleURI  Where the rationale document can be fetched.
    function rebalance(Trade[] calldata trades, bytes32 rationaleHash, string calldata rationaleURI)
        external
        nonReentrant
    {
        if (msg.sender != agent) revert NotAgent();
        if (paused) revert AgentPaused();
        Mandate memory m = _mandate;
        if (block.timestamp >= m.expiry) revert MandateExpired(m.expiry);
        if (lastRebalance != 0 && block.timestamp < uint256(lastRebalance) + m.cooldown) {
            revert CooldownActive(uint256(lastRebalance) + m.cooldown);
        }
        if (trades.length == 0) revert NoTrades();
        if (trades.length > MAX_TRADES) revert TooManyTrades();
        if (bytes(rationaleURI).length > MAX_URI_LENGTH) revert UriTooLong();

        uint256 navBefore = nav();
        bool breached = _breached(navBefore, m);
        if (block.timestamp >= uint256(windowStart) + m.turnoverWindow) {
            windowStart = uint64(block.timestamp);
            windowNav = navBefore;
            windowTurnover = 0;
        }

        uint256 nextEpoch = epoch + 1;
        address[] memory bought = new address[](trades.length);
        uint256 boughtCount;
        uint256 turnover = windowTurnover;

        for (uint256 i; i < trades.length; ++i) {
            Trade calldata t = trades[i];
            if (t.buy) {
                if (breached) revert DrawdownBreached(navBefore, _floor(m));
                bought[boughtCount++] = t.token;
            }
            turnover += _execute(nextEpoch, t, m);
        }

        // Deposits made after the window opened raise the budget; the agent itself can never raise NAV.
        uint256 base = navBefore > windowNav ? navBefore : windowNav;
        uint256 limit = base * m.maxTurnoverBps / BPS;
        if (turnover > limit) revert TurnoverExceeded(turnover, limit);
        windowTurnover = turnover;

        uint256 navAfter = nav();
        if (boughtCount != 0 && navAfter != 0) {
            uint256 cashBps = usd.balanceOf(address(this)) * BPS / navAfter;
            if (cashBps < m.minCashBps) revert CashFloorBreached(cashBps, m.minCashBps);
            for (uint256 i; i < boughtCount; ++i) {
                address token = bought[i];
                uint256 w = desk.valueOf(token, IERC20(token).balanceOf(address(this))) * BPS / navAfter;
                if (w > capBps[token]) revert WeightCapExceeded(token, w, capBps[token]);
            }
        }
        if (navAfter > peakNav) peakNav = navAfter;

        epoch = nextEpoch;
        lastRebalance = uint64(block.timestamp);
        emit Rebalanced(nextEpoch, msg.sender, navBefore, navAfter, turnover, rationaleHash, rationaleURI);
    }

    /*//////////////////////////////////////////////////////////////
                              RISK EXITS
    //////////////////////////////////////////////////////////////*/

    /// @notice Sells the whole `token` position if the stop-loss or the drawdown breaker says so. Anyone can call
    ///         it (a keeper, the agent, the owner), so the rules hold even when the agent is offline or paused.
    function stopOut(address token) external nonReentrant returns (uint256 usdOut) {
        if (!isAsset[token]) revert AssetNotAllowed(token);
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) revert NothingToExit(token);
        Mandate memory m = _mandate;
        (uint256 price,, uint256 updatedAt) = desk.priceOf(token);
        if (block.timestamp > updatedAt + m.maxOracleAge) revert StaleOracle(token, updatedAt, m.maxOracleAge);

        uint256 entry = entryPrice[token];
        ExitReason reason = _exitReason(price, entry, m);
        if (reason == ExitReason.None) revert RiskRuleNotTriggered(token);

        uint256 minOut = desk.valueOf(token, bal) * (BPS - m.maxSlippageBps) / BPS;
        uint256 before = usd.balanceOf(address(this));
        IERC20(token).forceApprove(address(desk), bal);
        desk.sell(token, bal, minOut);
        usdOut = usd.balanceOf(address(this)) - before;
        if (usdOut < minOut) revert SlippageExceeded(token, usdOut, minOut);

        entryPrice[token] = 0;
        uint256 delay = m.cooldown > MIN_REENTRY_DELAY ? m.cooldown : MIN_REENTRY_DELAY;
        buyBlockedUntil[token] = uint64(block.timestamp + delay);
        emit RiskExit(token, reason, price, entry, bal, usdOut, msg.sender);
    }

    /// @notice Whether {stopOut} would sell `token` right now, and why. Never reverts.
    function exitStatus(address token) external view returns (ExitReason reason, uint256 price, uint256 stopPrice) {
        if (!isAsset[token] || IERC20(token).balanceOf(address(this)) == 0) return (ExitReason.None, 0, 0);
        Mandate memory m = _mandate;
        uint256 updatedAt;
        try desk.priceOf(token) returns (uint256 p, uint8, uint256 u) {
            (price, updatedAt) = (p, u);
        } catch {
            return (ExitReason.None, 0, 0);
        }
        stopPrice = _stopPrice(entryPrice[token], m);
        if (block.timestamp > updatedAt + m.maxOracleAge) return (ExitReason.None, price, stopPrice);
        reason = _exitReason(price, entryPrice[token], m);
    }

    /*//////////////////////////////////////////////////////////////
                                VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Net asset value in USD units: cash plus every asset at its oracle price.
    function nav() public view returns (uint256 total) {
        total = usd.balanceOf(address(this));
        for (uint256 i; i < _assets.length; ++i) {
            uint256 bal = IERC20(_assets[i]).balanceOf(address(this));
            if (bal != 0) total += desk.valueOf(_assets[i], bal);
        }
    }

    /// @notice Profit or loss in USD units: NAV minus net deposits.
    function pnl() external view returns (int256) {
        return int256(nav()) - int256(netDeposits);
    }

    /// @notice Current drawdown from the high-water mark, in basis points.
    function drawdownBps() external view returns (uint256) {
        uint256 current = nav();
        if (peakNav == 0 || current >= peakNav) return 0;
        return (peakNav - current) * BPS / peakNav;
    }

    /// @notice True once the drawdown breaker has tripped: the agent may only sell until the owner resets it.
    function breakerTripped() external view returns (bool) {
        return _breached(nav(), _mandate);
    }

    function mandate() external view returns (Mandate memory) {
        return _mandate;
    }

    function assets() external view returns (address[] memory) {
        return _assets;
    }

    /// @notice Turnover still available in the current window (resets once the window has elapsed).
    function turnoverHeadroom() external view returns (uint256 used, uint256 limit, uint256 resetsAt) {
        Mandate memory m = _mandate;
        uint256 current = nav();
        if (block.timestamp >= uint256(windowStart) + m.turnoverWindow) {
            return (0, current * m.maxTurnoverBps / BPS, block.timestamp + m.turnoverWindow);
        }
        uint256 base = current > windowNav ? current : windowNav;
        return (windowTurnover, base * m.maxTurnoverBps / BPS, uint256(windowStart) + m.turnoverWindow);
    }

    /// @notice Everything a dashboard needs in one call.
    function snapshot() external view returns (uint256 cash, uint256 total, Holding[] memory holdings) {
        Mandate memory m = _mandate;
        cash = usd.balanceOf(address(this));
        total = cash;
        holdings = new Holding[](_assets.length);
        for (uint256 i; i < _assets.length; ++i) {
            address token = _assets[i];
            Holding memory h;
            h.token = token;
            h.symbol = IERC20Metadata(token).symbol();
            h.decimals = IERC20Metadata(token).decimals();
            h.capBps = capBps[token];
            h.raw = IERC20(token).balanceOf(address(this));
            h.entryPrice = entryPrice[token];
            h.stopPrice = _stopPrice(h.entryPrice, m);
            h.buyBlockedUntil = buyBlockedUntil[token];
            try desk.priceOf(token) returns (uint256 p, uint8 pd, uint256 u) {
                (h.price, h.priceDecimals, h.updatedAt) = (p, pd, u);
                h.value = h.raw == 0 ? 0 : desk.valueOf(token, h.raw);
            } catch {}
            total += h.value;
            holdings[i] = h;
        }
        for (uint256 i; i < holdings.length; ++i) {
            holdings[i].weightBps = total == 0 ? 0 : holdings[i].value * BPS / total;
        }
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _execute(uint256 nextEpoch, Trade calldata t, Mandate memory m) internal returns (uint256 notional) {
        if (!isAsset[t.token]) revert AssetNotAllowed(t.token);
        if (t.amountIn == 0) revert ZeroAmount();
        (uint256 price, uint8 fd, uint256 updatedAt) = desk.priceOf(t.token);
        if (block.timestamp > updatedAt + m.maxOracleAge) revert StaleOracle(t.token, updatedAt, m.maxOracleAge);

        uint256 fair;
        IERC20 outToken;
        uint256 held = IERC20(t.token).balanceOf(address(this));
        if (t.buy) {
            if (capBps[t.token] == 0) revert BuyNotAllowed(t.token);
            if (block.timestamp < buyBlockedUntil[t.token]) revert BuyBlocked(t.token, buyBlockedUntil[t.token]);
            fair = desk.unitsFor(t.token, t.amountIn);
            notional = t.amountIn;
            outToken = IERC20(t.token);
        } else {
            fair = desk.valueOf(t.token, t.amountIn);
            notional = fair;
            outToken = usd;
        }
        uint256 minOut = fair * (BPS - m.maxSlippageBps) / BPS;
        if (t.minAmountOut > minOut) minOut = t.minAmountOut;

        uint256 balBefore = outToken.balanceOf(address(this));
        if (t.buy) {
            usd.forceApprove(address(desk), t.amountIn);
            desk.buy(t.token, t.amountIn, minOut);
        } else {
            IERC20(t.token).forceApprove(address(desk), t.amountIn);
            desk.sell(t.token, t.amountIn, minOut);
        }
        uint256 out = outToken.balanceOf(address(this)) - balBefore;
        if (out < minOut) revert SlippageExceeded(t.token, out, minOut);

        if (t.buy) {
            _recordEntry(t.token, held, out, t.amountIn, fd);
        } else if (IERC20(t.token).balanceOf(address(this)) == 0) {
            entryPrice[t.token] = 0;
        }
        emit TradeExecuted(nextEpoch, t.token, t.buy, t.amountIn, out, price, notional);
    }

    /// @dev Volume-weighted average entry, using the actual fill (USD paid per whole token, in feed units).
    function _recordEntry(address token, uint256 held, uint256 bought, uint256 usdPaid, uint8 feedDecimals) internal {
        uint256 fill = Math.mulDiv(
            usdPaid,
            10 ** (uint256(IERC20Metadata(token).decimals()) + feedDecimals),
            bought * 10 ** uint256(desk.usdDecimals())
        );
        uint256 prev = entryPrice[token];
        entryPrice[token] = prev == 0 || held == 0 ? fill : (held * prev + bought * fill) / (held + bought);
    }

    function _exitReason(uint256 price, uint256 entry, Mandate memory m) internal view returns (ExitReason) {
        if (m.stopLossBps != 0 && entry != 0 && price * BPS <= entry * (BPS - m.stopLossBps)) {
            return ExitReason.StopLoss;
        }
        if (_breached(nav(), m)) return ExitReason.Drawdown;
        return ExitReason.None;
    }

    function _stopPrice(uint256 entry, Mandate memory m) internal pure returns (uint256) {
        return m.stopLossBps == 0 ? 0 : entry * (BPS - m.stopLossBps) / BPS;
    }

    function _breached(uint256 current, Mandate memory m) internal view returns (bool) {
        return m.maxDrawdownBps != 0 && peakNav != 0 && current < _floor(m);
    }

    function _floor(Mandate memory m) internal view returns (uint256) {
        return peakNav * (BPS - m.maxDrawdownBps) / BPS;
    }

    function _tryNav() internal view returns (bool ok, uint256 value) {
        try this.nav() returns (uint256 v) {
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    function _tryValue(address token, uint256 amount) internal view returns (uint256) {
        try desk.valueOf(token, amount) returns (uint256 v) {
            return v;
        } catch {
            return 0;
        }
    }

    function _addAsset(address token, uint16 cap) internal {
        if (_assets.length >= MAX_ASSETS) revert TooManyAssets();
        if (isAsset[token]) revert DuplicateAsset(token);
        if (!desk.isListed(token)) revert NotListedOnDesk(token);
        if (cap > BPS) revert BadCap(token, cap);
        _assets.push(token);
        isAsset[token] = true;
        capBps[token] = cap;
        emit CapSet(token, cap);
    }

    function _setMandate(Mandate memory m) internal {
        if (
            m.minCashBps > BPS || m.maxTurnoverBps > 4 * BPS || m.turnoverWindow == 0
                || m.maxSlippageBps > MAX_SLIPPAGE_BPS || m.maxOracleAge == 0 || m.stopLossBps > MAX_RISK_BPS
                || m.maxDrawdownBps > MAX_RISK_BPS || m.expiry <= block.timestamp
        ) revert BadMandate();
        _mandate = m;
        emit MandateSet(m);
    }
}
