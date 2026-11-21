// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestToken
/// @notice Testnet stand-in for USDT, HSK, WBTC and WETH on HSK Chain testnet. Only approved minters (the deployer,
///         the {TokenFaucet} and the {PoolAligner}) can mint; anyone can burn their own balance. Never deployed on
///         mainnet, where Leash uses the real tokens.
contract TestToken is ERC20 {
    uint8 internal immutable _decimals;

    address public owner;
    mapping(address account => bool) public isMinter;

    event MinterSet(address indexed account, bool allowed);
    event OwnerChanged(address indexed owner);

    error NotOwner();
    error NotMinter();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        owner = msg.sender;
        isMinter[msg.sender] = true;
        emit OwnerChanged(msg.sender);
        emit MinterSet(msg.sender, true);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function setMinter(address account, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        isMinter[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function transferOwnership(address owner_) external {
        if (msg.sender != owner) revert NotOwner();
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    function mint(address to, uint256 amount) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}

/// @title TokenFaucet
/// @notice Hands out testnet USDT so anyone can open a Leash vault. Needs minter rights on the token.
contract TokenFaucet {
    TestToken public immutable token;
    uint256 public immutable amount;
    uint256 public immutable cooldown;

    mapping(address account => uint256) public lastClaim;

    event Claimed(address indexed account, uint256 amount);

    error TooSoon(uint256 nextClaimAt);

    constructor(TestToken token_, uint256 amount_, uint256 cooldown_) {
        token = token_;
        amount = amount_;
        cooldown = cooldown_;
    }

    function claim() external {
        uint256 last = lastClaim[msg.sender];
        if (last != 0 && block.timestamp < last + cooldown) revert TooSoon(last + cooldown);
        lastClaim[msg.sender] = block.timestamp;
        token.mint(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }
}
