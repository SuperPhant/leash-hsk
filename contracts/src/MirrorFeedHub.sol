// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";

/// @title MirrorFeedHub
/// @notice Testnet mirror of HSK Chain mainnet price data. A relayer copies the APRO feed rounds from mainnet
///         (same roundId, answer and timestamps) so testnet contracts price assets exactly like they would on
///         mainnet; for assets without an APRO feed (ETH) it relays the mainnet HSKSwap pool price as numbered
///         rounds. Every feed is exposed through its own AggregatorV3-compatible {MirrorFeed} adapter, and
///         `source` records the mainnet contract it mirrors.
contract MirrorFeedHub {
    struct Round {
        int256 answer;
        uint64 startedAt;
        uint64 updatedAt;
        uint64 relayedAt;
    }

    struct FeedInfo {
        address adapter;
        address source;
        uint8 decimals;
        string description;
    }

    /// @notice Tolerated clock skew between the mainnet round timestamp and this chain's block time.
    uint256 public constant MAX_FUTURE_SKEW = 10 minutes;

    address public owner;
    address public relayer;

    FeedInfo[] internal _feeds;
    mapping(uint256 feedId => uint80) public latestRound;
    mapping(uint256 feedId => mapping(uint80 roundId => Round)) internal _rounds;

    event FeedAdded(uint256 indexed feedId, address indexed adapter, address indexed source, string description);
    event Relayed(uint256 indexed feedId, uint80 indexed roundId, int256 answer, uint256 updatedAt);
    event RelaySkipped(uint256 indexed feedId, uint80 indexed roundId, uint8 reason);
    event RelayerChanged(address indexed relayer);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotRelayer();
    error LengthMismatch();
    error UnknownFeed(uint256 feedId);
    error NoData(uint256 feedId, uint80 roundId);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address relayer_) {
        owner = msg.sender;
        relayer = relayer_;
        emit OwnerChanged(msg.sender);
        emit RelayerChanged(relayer_);
    }

    function setRelayer(address relayer_) external onlyOwner {
        relayer = relayer_;
        emit RelayerChanged(relayer_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function addFeed(address source, uint8 decimals_, string calldata description_)
        external
        onlyOwner
        returns (uint256 feedId, address adapter)
    {
        feedId = _feeds.length;
        adapter = address(new MirrorFeed(this, feedId));
        _feeds.push(FeedInfo({adapter: adapter, source: source, decimals: decimals_, description: description_}));
        emit FeedAdded(feedId, adapter, source, description_);
    }

    /// @notice Copies mainnet rounds. Rounds that are not newer than the stored one, or are malformed,
    ///         are skipped (with an event) so a batch never fails because one feed did not move.
    function relay(
        uint256[] calldata feedIds,
        uint80[] calldata roundIds,
        int256[] calldata answers,
        uint64[] calldata startedAts,
        uint64[] calldata updatedAts
    ) external {
        if (msg.sender != relayer) revert NotRelayer();
        uint256 n = feedIds.length;
        if (roundIds.length != n || answers.length != n || startedAts.length != n || updatedAts.length != n) {
            revert LengthMismatch();
        }
        for (uint256 i; i < n; ++i) {
            uint256 id = feedIds[i];
            if (id >= _feeds.length) revert UnknownFeed(id);
            uint80 prev = latestRound[id];
            if (roundIds[i] <= prev) {
                emit RelaySkipped(id, roundIds[i], 1);
                continue;
            }
            if (answers[i] <= 0 || updatedAts[i] > block.timestamp + MAX_FUTURE_SKEW || startedAts[i] > updatedAts[i]) {
                emit RelaySkipped(id, roundIds[i], 2);
                continue;
            }
            if (prev != 0 && updatedAts[i] < _rounds[id][prev].updatedAt) {
                emit RelaySkipped(id, roundIds[i], 3);
                continue;
            }
            _rounds[id][roundIds[i]] = Round({
                answer: answers[i],
                startedAt: startedAts[i],
                updatedAt: updatedAts[i],
                relayedAt: uint64(block.timestamp)
            });
            latestRound[id] = roundIds[i];
            emit Relayed(id, roundIds[i], answers[i], updatedAts[i]);
        }
    }

    function feedCount() external view returns (uint256) {
        return _feeds.length;
    }

    function feed(uint256 feedId) external view returns (FeedInfo memory) {
        if (feedId >= _feeds.length) revert UnknownFeed(feedId);
        return _feeds[feedId];
    }

    function roundOf(uint256 feedId, uint80 roundId) public view returns (Round memory r) {
        r = _rounds[feedId][roundId];
        if (r.updatedAt == 0) revert NoData(feedId, roundId);
    }

    function latest(uint256 feedId) external view returns (uint80 roundId, Round memory r) {
        roundId = latestRound[feedId];
        r = roundOf(feedId, roundId);
    }
}

/// @title MirrorFeed
/// @notice AggregatorV3-compatible view onto one {MirrorFeedHub} feed. Drop-in replacement for the
///         mainnet feed it mirrors (same decimals, round ids and timestamps).
contract MirrorFeed is AggregatorV3Interface {
    MirrorFeedHub public immutable hub;
    uint256 public immutable feedId;

    constructor(MirrorFeedHub hub_, uint256 feedId_) {
        hub = hub_;
        feedId = feedId_;
    }

    function decimals() external view returns (uint8) {
        return hub.feed(feedId).decimals;
    }

    function description() external view returns (string memory) {
        return hub.feed(feedId).description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    /// @notice The HSK Chain mainnet contract (APRO feed or HSKSwap pool) this adapter mirrors.
    function source() external view returns (address) {
        return hub.feed(feedId).source;
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        MirrorFeedHub.Round memory r = hub.roundOf(feedId, roundId);
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        (uint80 roundId, MirrorFeedHub.Round memory r) = hub.latest(feedId);
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }
}
