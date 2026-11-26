// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title Upwell Call Ledger
 * @notice Makes every judged call public and tamper-proof without paying gas per call.
 *
 * Calls are free and made off-chain. Once a week the backend publishes one Merkle root of all
 * calls judged in that epoch, plus a root of every caller's running stats. Roots can never be
 * changed, so anyone can prove a call (or a caller's record) against the chain.
 *
 * Call leaf (OpenZeppelin StandardMerkleTree, double-hashed):
 *   (uint256 callId, address caller, address token, uint8 window, uint256 entryMcap,
 *    uint256 exitMcap, uint64 startAt, uint64 endAt, bool won)
 *   window: 0 = 1h, 1 = 24h, 2 = 7d. Market caps are USD with 2 decimals (cents).
 *
 * Stats leaf:
 *   (address caller, uint256 epoch, uint256 calls, uint256 wins, uint256 bestMultipleBps, uint256 score, uint256 xp)
 */
contract CallLedger is AccessControl {
    bytes32 public constant PUBLISHER_ROLE = keccak256("PUBLISHER_ROLE");

    struct Entry {
        bytes32 callsRoot;
        bytes32 statsRoot;
        uint32 callCount;
        uint64 publishedAt;
        string uri; // optional: IPFS / HTTPS link to the full JSON dump of the epoch
    }

    struct CallRecord {
        uint256 callId;
        address caller;
        address token;
        uint8 window;
        uint256 entryMcap;
        uint256 exitMcap;
        uint64 startAt;
        uint64 endAt;
        bool won;
    }

    struct StatsRecord {
        address caller;
        uint256 epoch;
        uint256 calls;
        uint256 wins;
        uint256 bestMultipleBps;
        uint256 score;
        uint256 xp;
    }

    uint256 public latestEpoch;
    mapping(uint256 => Entry) public entries;

    event EpochPublished(uint256 indexed epoch, bytes32 callsRoot, bytes32 statsRoot, uint32 callCount, string uri);

    error AlreadyPublished();
    error OutOfOrder();
    error EmptyRoot();

    constructor(address admin, address publisher) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PUBLISHER_ROLE, publisher);
    }

    function publish(uint256 epoch, bytes32 callsRoot, bytes32 statsRoot, uint32 callCount, string calldata uri)
        external
        onlyRole(PUBLISHER_ROLE)
    {
        if (entries[epoch].publishedAt != 0) revert AlreadyPublished();
        if (epoch != latestEpoch + 1) revert OutOfOrder();
        if (callsRoot == bytes32(0) && callCount != 0) revert EmptyRoot();
        latestEpoch = epoch;
        entries[epoch] = Entry(callsRoot, statsRoot, callCount, uint64(block.timestamp), uri);
        emit EpochPublished(epoch, callsRoot, statsRoot, callCount, uri);
    }

    /// @notice Check that a call (its full record) is in an epoch's calls tree. The leaf is hashed here from the
    /// fields, so an internal node of the tree can never be passed off as a call.
    function verifyCall(uint256 epoch, CallRecord calldata c, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = entries[epoch].callsRoot;
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, _callLeaf(c));
    }

    /// @notice Check that a caller's stats record is in an epoch's stats tree (leaf hashed here from the fields).
    function verifyStats(uint256 epoch, StatsRecord calldata s, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = entries[epoch].statsRoot;
        if (root == bytes32(0)) return false;
        return MerkleProof.verifyCalldata(proof, root, _statsLeaf(s));
    }

    function _callLeaf(CallRecord calldata c) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(c.callId, c.caller, c.token, c.window, c.entryMcap, c.exitMcap, c.startAt, c.endAt, c.won))));
    }

    function _statsLeaf(StatsRecord calldata s) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(s.caller, s.epoch, s.calls, s.wins, s.bestMultipleBps, s.score, s.xp))));
    }

    /// @notice Helper with the exact leaf encoding used for calls.
    function callLeaf(
        uint256 callId,
        address caller,
        address token,
        uint8 window,
        uint256 entryMcap,
        uint256 exitMcap,
        uint64 startAt,
        uint64 endAt,
        bool won
    ) external pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(callId, caller, token, window, entryMcap, exitMcap, startAt, endAt, won))));
    }

    /// @notice Helper with the exact leaf encoding used for stats.
    function statsLeaf(address caller, uint256 epoch, uint256 calls, uint256 wins, uint256 bestMultipleBps, uint256 score, uint256 xp)
        external
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(keccak256(abi.encode(caller, epoch, calls, wins, bestMultipleBps, score, xp))));
    }
}
