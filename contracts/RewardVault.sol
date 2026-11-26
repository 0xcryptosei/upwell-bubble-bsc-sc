// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

interface IStakingRewards {
    function notifyRewardAmount() external payable;
}

/**
 * @title Upwell Reward Vault
 * @notice Collects BNB from the $UPW buy/sell tax and pays it out once per week (an "epoch").
 *
 * When the operator closes an epoch, the BNB that arrived since the last close is split:
 *   - callers   (default 60%) : claimable by top callers with a Merkle proof
 *   - stakers   (default 25%) : forwarded to the $UPW staking contract
 *   - buyback   (default 10%) : sent to the buyback & burn wallet
 *   - operations(default  5%) : sent to the operations wallet
 *
 * The caller allocation is computed off-chain by the Upwell backend. Its Merkle leaves are
 * OpenZeppelin StandardMerkleTree leaves of (address account, uint256 epoch, uint256 amount):
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(account, epoch, amount))))
 *
 * Any part of the caller pool that the backend does not allocate stays with callers and is added
 * to the next epoch's caller pool (callerCarry). Unclaimed rewards of an expired epoch are recycled
 * the same way.
 *
 * Payouts to the staking contract and the two wallets can never block a close: if one fails, the
 * amount is held in the vault (pendingStakerRewards / heldBuyback / heldOps) and can be sent later.
 */
contract RewardVault is AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    uint16 public constant BPS = 10_000;
    uint256 public constant PAYOUT_GAS = 100_000;

    struct Split {
        uint16 callers;
        uint16 stakers;
        uint16 buyback;
        uint16 ops;
    }

    struct Epoch {
        bytes32 root;        // Merkle root of caller rewards
        uint128 allocated;   // total BNB the root can pay out
        uint128 claimed;     // BNB already claimed
        uint64 closedAt;     // timestamp of close
        uint64 claimDeadline;// after this, unclaimed BNB can be recycled
        bool recycled;
    }

    Split public split = Split({callers: 6_000, stakers: 2_500, buyback: 1_000, ops: 500});

    address public staking;
    address payable public buybackWallet;
    address payable public opsWallet;

    /// @notice How long callers have to claim an epoch before it can be recycled.
    uint64 public claimWindow = 90 days;
    uint64 public constant MIN_CLAIM_WINDOW = 7 days;
    uint64 public constant MAX_CLAIM_WINDOW = 365 days;

    /// @notice Last closed epoch id. Epoch ids start at 1.
    uint256 public currentEpoch;

    /// @notice BNB reserved for unclaimed caller rewards across all epochs.
    uint256 public reservedForClaims;

    /// @notice BNB from the stakers' share that could not be forwarded (no staking contract yet, or it failed).
    uint256 public pendingStakerRewards;

    /// @notice Callers' BNB not allocated (or recycled) in earlier epochs: added to the next callers' pool.
    uint256 public callerCarry;

    /// @notice Buyback / operations BNB whose transfer failed; sent with flushHeldPayouts().
    uint256 public heldBuyback;
    uint256 public heldOps;

    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event Funded(address indexed from, uint256 amount);
    event EpochClosed(
        uint256 indexed epoch,
        bytes32 root,
        uint256 inflow,
        uint256 callerAllocated,
        uint256 toStakers,
        uint256 toBuyback,
        uint256 toOps
    );
    event Claimed(uint256 indexed epoch, address indexed account, uint256 amount);
    event EpochRecycled(uint256 indexed epoch, uint256 amount);
    event SplitUpdated(uint16 callers, uint16 stakers, uint16 buyback, uint16 ops);
    event WalletsUpdated(address staking, address buyback, address ops);
    event ClaimWindowUpdated(uint64 claimWindow);
    event PayoutHeld(address indexed to, uint256 amount);

    error InvalidSplit();
    error ZeroAddress();
    error AllocationTooHigh(uint256 allocated, uint256 available);
    error AlreadyClaimed();
    error InvalidProof();
    error UnknownEpoch();
    error EpochExpired();
    error NotExpired();
    error AlreadyRecycled();
    error EmptyRoot();
    error WrongEpoch(uint256 expected, uint256 given);

    constructor(address admin, address operator, address staking_, address payable buyback_, address payable ops_) {
        if (admin == address(0) || operator == address(0) || buyback_ == address(0) || ops_ == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, operator);
        staking = staking_; // may be zero until staking launches (Phase 2)
        buybackWallet = buyback_;
        opsWallet = ops_;
    }

    /// @notice The $UPW tax (or anyone) can send BNB here.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice New BNB that has arrived since the last close and is not reserved or carried for anything.
    function unallocated() public view returns (uint256) {
        uint256 locked = reservedForClaims + pendingStakerRewards + callerCarry + heldBuyback + heldOps;
        uint256 bal = address(this).balance;
        return bal > locked ? bal - locked : 0;
    }

    /// @notice What the next close would split. "callers" includes the carried-over callers' BNB.
    function preview() external view returns (uint256 inflow, uint256 callers, uint256 stakers, uint256 buyback, uint256 ops) {
        inflow = unallocated();
        (callers, stakers, buyback, ops) = _split(inflow);
        callers += callerCarry;
    }

    function canClaim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) external view returns (bool) {
        Epoch memory e = epochs[epoch];
        if (e.root == bytes32(0) || e.recycled || hasClaimed[epoch][account]) return false;
        if (block.timestamp > e.claimDeadline) return false;
        return MerkleProof.verifyCalldata(proof, e.root, _leaf(account, epoch, amount));
    }

    // ---------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------

    /**
     * @notice Close the current week and open claims for it.
     * @param epoch The epoch being closed: must be currentEpoch + 1, so a resent or duplicate transaction reverts.
     * @param root Merkle root of (account, epoch, amount) caller rewards.
     * @param callerAllocated Sum of all amounts in the tree. Must not exceed the callers' pool (share + carry).
     */
    function closeEpoch(uint256 epoch, bytes32 root, uint256 callerAllocated) external onlyRole(OPERATOR_ROLE) whenNotPaused nonReentrant {
        if (epoch != currentEpoch + 1) revert WrongEpoch(currentEpoch + 1, epoch);
        if (root == bytes32(0) && callerAllocated != 0) revert EmptyRoot();

        uint256 inflow = unallocated();
        (uint256 callersShare, uint256 stakersShare, uint256 buybackShare, uint256 opsShare) = _split(inflow);
        callersShare += callerCarry;
        if (callerAllocated > callersShare) revert AllocationTooHigh(callerAllocated, callersShare);

        currentEpoch = epoch;
        uint64 nowTs = uint64(block.timestamp);
        epochs[epoch] = Epoch({
            root: root,
            allocated: uint128(callerAllocated),
            claimed: 0,
            closedAt: nowTs,
            claimDeadline: nowTs + claimWindow,
            recycled: false
        });
        reservedForClaims += callerAllocated;
        callerCarry = callersShare - callerAllocated; // stays with callers, added to the next epoch's pool

        emit EpochClosed(epoch, root, inflow, callerAllocated, stakersShare, buybackShare, opsShare);

        _payStakers(stakersShare);
        heldBuyback += buybackShare;
        heldOps += opsShare;
        _payHeld();
    }

    /// @notice Try again to send buyback / operations BNB whose transfer failed (e.g. after the admin fixed a wallet).
    function flushHeldPayouts() external onlyRole(OPERATOR_ROLE) nonReentrant {
        _payHeld();
    }

    /// @notice Try again to forward staker rewards that were held back.
    function flushStakerRewards() external onlyRole(OPERATOR_ROLE) nonReentrant {
        uint256 amount = pendingStakerRewards;
        pendingStakerRewards = 0;
        _payStakers(amount);
    }

    /// @notice Return unclaimed BNB of an expired epoch to the pool for the next close.
    function recycleExpired(uint256 epoch) external onlyRole(OPERATOR_ROLE) whenNotPaused {
        Epoch storage e = epochs[epoch];
        if (e.closedAt == 0) revert UnknownEpoch();
        if (e.recycled) revert AlreadyRecycled();
        if (block.timestamp <= e.claimDeadline) revert NotExpired();
        e.recycled = true;
        uint256 left = uint256(e.allocated) - uint256(e.claimed);
        reservedForClaims -= left;
        callerCarry += left; // back to the callers' pool
        emit EpochRecycled(epoch, left);
    }

    // ---------------------------------------------------------------------
    // Callers
    // ---------------------------------------------------------------------

    function claim(uint256 epoch, uint256 amount, bytes32[] calldata proof) external whenNotPaused nonReentrant {
        _claim(epoch, msg.sender, amount, proof);
        Address.sendValue(payable(msg.sender), amount);
    }

    /// @notice Claim several epochs in one transaction.
    function claimMany(uint256[] calldata epochIds, uint256[] calldata amounts, bytes32[][] calldata proofs) external whenNotPaused nonReentrant {
        require(epochIds.length == amounts.length && amounts.length == proofs.length, "length mismatch");
        uint256 total;
        for (uint256 i; i < epochIds.length; ++i) {
            _claim(epochIds[i], msg.sender, amounts[i], proofs[i]);
            total += amounts[i];
        }
        Address.sendValue(payable(msg.sender), total);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setSplit(uint16 callers, uint16 stakers, uint16 buyback, uint16 ops) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(callers) + stakers + buyback + ops != BPS) revert InvalidSplit();
        split = Split(callers, stakers, buyback, ops);
        emit SplitUpdated(callers, stakers, buyback, ops);
    }

    function setWallets(address staking_, address payable buyback_, address payable ops_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (buyback_ == address(0) || ops_ == address(0)) revert ZeroAddress();
        staking = staking_;
        buybackWallet = buyback_;
        opsWallet = ops_;
        emit WalletsUpdated(staking_, buyback_, ops_);
    }

    function setClaimWindow(uint64 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(window >= MIN_CLAIM_WINDOW, "window too short");
        require(window <= MAX_CLAIM_WINDOW, "window too long");
        claimWindow = window;
        emit ClaimWindowUpdated(window);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _split(uint256 inflow) internal view returns (uint256 callers, uint256 stakers, uint256 buyback, uint256 ops) {
        Split memory s = split;
        stakers = (inflow * s.stakers) / BPS;
        buyback = (inflow * s.buyback) / BPS;
        ops = (inflow * s.ops) / BPS;
        callers = inflow - stakers - buyback - ops; // rounding dust goes to callers
    }

    /// @dev Never reverts: with no staking contract, or if it rejects the call, the BNB is held for later.
    function _payStakers(uint256 amount) internal {
        if (amount == 0) return;
        if (staking != address(0)) {
            try IStakingRewards(staking).notifyRewardAmount{value: amount}() {
                return;
            } catch {
                emit PayoutHeld(staking, amount);
            }
        }
        pendingStakerRewards += amount;
    }

    /// @dev Never reverts: a wallet that refuses BNB keeps its amount held in the vault.
    function _payHeld() internal {
        uint256 b = heldBuyback;
        if (b > 0) {
            heldBuyback = 0;
            if (!_trySend(buybackWallet, b)) { heldBuyback = b; emit PayoutHeld(buybackWallet, b); }
        }
        uint256 o = heldOps;
        if (o > 0) {
            heldOps = 0;
            if (!_trySend(opsWallet, o)) { heldOps = o; emit PayoutHeld(opsWallet, o); }
        }
    }

    /// @dev Gas is capped so a wallet that burns gas cannot make the close run out of gas (plenty for a multisig).
    function _trySend(address payable to, uint256 amount) internal returns (bool ok) {
        (ok, ) = to.call{value: amount, gas: PAYOUT_GAS}("");
    }

    function _claim(uint256 epoch, address account, uint256 amount, bytes32[] calldata proof) internal {
        Epoch storage e = epochs[epoch];
        if (e.root == bytes32(0)) revert UnknownEpoch();
        if (e.recycled || block.timestamp > e.claimDeadline) revert EpochExpired();
        if (hasClaimed[epoch][account]) revert AlreadyClaimed();
        if (!MerkleProof.verifyCalldata(proof, e.root, _leaf(account, epoch, amount))) revert InvalidProof();

        if (uint256(e.claimed) + amount > e.allocated) revert AllocationTooHigh(uint256(e.claimed) + amount, e.allocated);

        hasClaimed[epoch][account] = true;
        e.claimed += uint128(amount);
        reservedForClaims -= amount;
        emit Claimed(epoch, account, amount);
    }

    function _leaf(address account, uint256 epoch, uint256 amount) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, epoch, amount))));
    }
}
