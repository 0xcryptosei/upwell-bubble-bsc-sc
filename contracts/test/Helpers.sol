// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test-only helpers. Not deployed.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IVaultLike {
    function claim(uint256 epoch, uint256 amount, bytes32[] calldata proof) external;
}

interface IStakingLike {
    function claim() external;
    function stake(uint256 amount) external;
    function withdraw(uint256 amount) external;
}

contract TestToken is ERC20 {
    constructor() ERC20("Upwell", "UPW") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

/// @dev Takes a 1% fee on every transfer (like a taxed token), sent to a sink.
contract FeeToken is ERC20 {
    address public constant SINK = address(0xFEE);
    constructor() ERC20("Fee UPW", "FUPW") {}
    function mint(address to, uint256 a) external { _mint(to, a); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, SINK, fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Sends its whole balance with Solidity's transfer (2300 gas stipend).
contract Send2300 {
    constructor() payable {}
    function go(address payable to) external { to.transfer(address(this).balance); }
}

/// @dev A wallet that refuses BNB.
contract RejectBNB {
    receive() external payable { revert("no BNB"); }
}

/// @dev Claims from the vault and tries to claim again from inside receive().
contract ReentrantClaimer {
    IVaultLike public vault;
    uint256 public epoch;
    uint256 public amount;
    bytes32[] public proof;
    bool public reentered;
    bool public reentrySucceeded;

    constructor(IVaultLike v) { vault = v; }

    function attack(uint256 e, uint256 a, bytes32[] calldata p) external {
        epoch = e; amount = a; proof = p;
        vault.claim(e, a, p);
    }

    receive() external payable {
        if (!reentered) {
            reentered = true;
            try vault.claim(epoch, amount, proof) { reentrySucceeded = true; } catch {}
        }
    }
}

/// @dev Stakes, then tries to re-enter staking when it receives its BNB reward.
contract ReentrantStaker {
    IStakingLike public staking;
    bool public reentrySucceeded;
    bool private inside;

    constructor(IStakingLike s) { staking = s; }

    function approveAndStake(ERC20 token, uint256 a) external {
        token.approve(address(staking), type(uint256).max);
        staking.stake(a);
    }

    function claimRewards() external { staking.claim(); }

    receive() external payable {
        if (!inside) {
            inside = true;
            try staking.claim() { reentrySucceeded = true; } catch {}
            inside = false;
        }
    }
}

/// @dev A wallet that burns all the gas it is given.
contract GasBurner {
    receive() external payable { while (true) {} }
}
