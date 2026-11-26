// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Upwell Staking
 * @notice Stake $UPW, earn a share of the Reward Vault in BNB. No lock: unstake any time.
 *
 * Each weekly deposit from the Reward Vault is paid out evenly over the following REWARD_DURATION
 * (7 days), second by second, to whoever is staked at that time, pro rata to their stake.
 * So rewards follow time staked: staking just before a deposit and leaving right after earns
 * almost nothing, and nobody can collect a lump that built up while no one was staked.
 * Any reward time that passes with nobody staked is queued and paid out with the next deposit.
 * BNB sent to this contract directly (e.g. holder dividends that $UPW pays to the staked tokens it holds)
 * is queued the same way and shared out with the next deposit.
 *
 * Note: $UPW is a taxed token on Flap.sh. stake() credits the balance actually received,
 * so fee-on-transfer amounts are handled correctly.
 */
contract UpwellStaking is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant NOTIFIER_ROLE = keccak256("NOTIFIER_ROLE");
    uint256 private constant ACC = 1e18;
    uint256 public constant REWARD_DURATION = 7 days;

    IERC20 public immutable upw;

    uint256 public totalStaked;
    uint256 public rewardRate;            // BNB wei per second, for the current period
    uint256 public periodFinish;          // when the current period's rewards run out
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;  // scaled by ACC
    uint256 public queued;                // BNB waiting for the next period (unstaked time, rounding, direct transfers)
    uint256 public totalNotified;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardAdded(uint256 amount, uint256 rewardRate, uint256 periodFinish);
    event Received(address indexed from, uint256 amount);

    error ZeroAmount();
    error InsufficientStake();

    constructor(IERC20 upw_, address admin, address vault) {
        upw = upw_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (vault != address(0)) _grantRole(NOTIFIER_ROLE, vault);
    }

    /// @notice BNB sent here directly (not through the vault) is added to the next period's rewards.
    receive() external payable {
        queued += msg.value;
        emit Received(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * ACC) / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return rewards[account] + (balanceOf[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / ACC;
    }

    /// @notice BNB still to be paid out in the current period.
    function remainingRewards() external view returns (uint256) {
        return block.timestamp >= periodFinish ? 0 : (periodFinish - block.timestamp) * rewardRate;
    }

    // ---------------------------------------------------------------------
    // Stakers
    // ---------------------------------------------------------------------

    function stake(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        _update(msg.sender);

        uint256 before = upw.balanceOf(address(this));
        upw.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = upw.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();

        balanceOf[msg.sender] += received;
        totalStaked += received;
        emit Staked(msg.sender, received);
    }

    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientStake();
        _update(msg.sender);
        balanceOf[msg.sender] -= amount;
        totalStaked -= amount;
        upw.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() public nonReentrant {
        _update(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward == 0) return;
        rewards[msg.sender] = 0;
        Address.sendValue(payable(msg.sender), reward);
        emit RewardPaid(msg.sender, reward);
    }

    /// @notice Withdraw everything and claim BNB in one go.
    function exit() external {
        uint256 bal = balanceOf[msg.sender];
        if (bal > 0) withdraw(bal);
        claim();
    }

    // ---------------------------------------------------------------------
    // Reward Vault
    // ---------------------------------------------------------------------

    /// @notice Add BNB to be paid out over the next REWARD_DURATION (plus whatever is left of the current period).
    function notifyRewardAmount() external payable onlyRole(NOTIFIER_ROLE) {
        _update(address(0));
        uint256 amount = msg.value + queued;
        queued = 0;
        if (block.timestamp < periodFinish) amount += (periodFinish - block.timestamp) * rewardRate;
        rewardRate = amount / REWARD_DURATION;
        queued = amount % REWARD_DURATION; // the rounding remainder is carried into the next period, not lost
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + REWARD_DURATION;
        totalNotified += msg.value;
        emit RewardAdded(msg.value, rewardRate, periodFinish);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Bring the reward index up to now. Reward time with nobody staked is queued, not lost.
    function _update(address account) internal {
        uint256 until = lastTimeRewardApplicable();
        if (until > lastUpdateTime) {
            if (totalStaked == 0) queued += (until - lastUpdateTime) * rewardRate;
            else rewardPerTokenStored += ((until - lastUpdateTime) * rewardRate * ACC) / totalStaked;
            lastUpdateTime = until;
        }
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
    }
}
