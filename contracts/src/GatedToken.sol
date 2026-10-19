// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRegGate {
    function statusOf(uint8 category) external view returns (uint8);
    function isAllowed(uint8 category, bool strict) external view returns (bool);
}

/// @title GatedToken
/// @notice Demo ERC-20 whose transfers are gated by a Reg-Gate category.
///         Every transfer asks RegGateStatus first. No bypass: the deployer
///         and the owner are gated exactly like everyone else.
/// @dev Minimal ERC-20, no external dependencies. Approvals are not gated
///      (an approval moves nothing); the transfer that uses it is.
contract GatedToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    IRegGate public immutable gate;
    uint8 public immutable category;
    /// @notice true = only OK passes. false = anything but BLOCK passes.
    bool public immutable strict;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error TransferBlockedByRegGate(uint8 category, uint8 status);
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        address gate_,
        uint8 category_,
        bool strict_,
        uint256 initialSupply
    ) {
        if (gate_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        gate = IRegGate(gate_);
        category = category_;
        strict = strict_;
        // Fail at deploy time on a bad category (statusOf reverts on >= 4).
        IRegGate(gate_).statusOf(category_);
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    /// @notice What a transfer would see right now.
    function transfersAllowed() public view returns (bool) {
        return gate.isAllowed(category, strict);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        if (!gate.isAllowed(category, strict)) {
            revert TransferBlockedByRegGate(category, gate.statusOf(category));
        }
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
