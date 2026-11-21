// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapDesk} from "./interfaces/ISwapDesk.sol";
import {LeashVault} from "./LeashVault.sol";

/// @title LeashFactory
/// @notice Creates {LeashVault}s and indexes them by owner and by the agent they were created for.
contract LeashFactory {
    using SafeERC20 for IERC20;

    ISwapDesk public immutable desk;
    IERC20 public immutable usd;

    address[] internal _vaults;
    mapping(address owner => address[]) internal _byOwner;
    mapping(address agent => address[]) internal _byAgent;
    mapping(address vault => bool) public isVault;

    event VaultCreated(address indexed vault, address indexed owner, address indexed agent, uint256 initialDeposit);

    constructor(ISwapDesk desk_) {
        desk = desk_;
        usd = desk_.usd();
    }

    /// @notice Creates a vault owned by the caller. An initial deposit is pulled from the caller (approve first).
    function createVault(
        address agent,
        address[] calldata assets,
        uint16[] calldata caps,
        LeashVault.Mandate calldata mandate,
        uint256 initialDeposit
    ) external returns (address vault) {
        LeashVault v = new LeashVault(msg.sender, agent, desk, assets, caps, mandate);
        vault = address(v);
        _vaults.push(vault);
        _byOwner[msg.sender].push(vault);
        _byAgent[agent].push(vault);
        isVault[vault] = true;
        emit VaultCreated(vault, msg.sender, agent, initialDeposit);
        if (initialDeposit != 0) {
            usd.safeTransferFrom(msg.sender, address(this), initialDeposit);
            usd.forceApprove(vault, initialDeposit);
            v.deposit(initialDeposit);
        }
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function vaults() external view returns (address[] memory) {
        return _vaults;
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _byOwner[owner];
    }

    /// @notice Vaults created for `agent`. Owners can change agents later, so check `vault.agent()` before acting.
    function vaultsByAgent(address agent) external view returns (address[] memory) {
        return _byAgent[agent];
    }
}
