// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title Upwell Badges
 * @notice Soulbound (non-transferable) achievement badges, one of each per wallet.
 *
 * Badge ids (match the backend):
 *   1 10x call · 2 7-day streak · 3 Safety first · 4 Top 100 · 5 Early bird
 *   6 Sniper tier · 7 Whale spotter · 8 Season 1 · 9 Legend
 *
 * Two ways to mint:
 *   - MINTER_ROLE mints directly (backend pays gas), or
 *   - the caller submits a backend signature with claim() (caller pays gas).
 */
contract UpwellBadges is ERC1155, AccessControl, EIP712 {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant URI_ROLE = keccak256("URI_ROLE");

    bytes32 private constant CLAIM_TYPEHASH = keccak256("Claim(address account,uint256 id,uint256 deadline)");

    string public constant name = "Upwell Badges";
    string public constant symbol = "UPWB";

    mapping(uint256 => bool) public badgeExists;

    event BadgeCreated(uint256 indexed id);

    error Soulbound();
    error AlreadyOwned();
    error UnknownBadge();
    error SignatureExpired();
    error BadSignature();

    constructor(address admin, address minter, string memory uri_) ERC1155(uri_) EIP712("Upwell Badges", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(URI_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        for (uint256 id = 1; id <= 9; ++id) {
            badgeExists[id] = true;
            emit BadgeCreated(id);
        }
    }

    // ---------------------------------------------------------------------
    // Minting
    // ---------------------------------------------------------------------

    function mint(address to, uint256 id) external onlyRole(MINTER_ROLE) {
        _mintOnce(to, id);
    }

    function mintBatch(address[] calldata to, uint256[] calldata ids) external onlyRole(MINTER_ROLE) {
        require(to.length == ids.length, "length mismatch");
        for (uint256 i; i < to.length; ++i) {
            // skip unknown badges and ones already owned, so one bad entry does not fail the whole batch
            if (badgeExists[ids[i]] && balanceOf(to[i], ids[i]) == 0) _mintOnce(to[i], ids[i]);
        }
    }

    /// @notice Mint your own badge with a signature from the backend's MINTER_ROLE key.
    function claim(uint256 id, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CLAIM_TYPEHASH, msg.sender, id, deadline)));
        address signer = ECDSA.recover(digest, signature);
        if (!hasRole(MINTER_ROLE, signer)) revert BadSignature();
        _mintOnce(msg.sender, id);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function createBadge(uint256 id) external onlyRole(DEFAULT_ADMIN_ROLE) {
        badgeExists[id] = true;
        emit BadgeCreated(id);
    }

    function setURI(string calldata uri_) external onlyRole(URI_ROLE) {
        _setURI(uri_);
    }

    // ---------------------------------------------------------------------
    // Soulbound
    // ---------------------------------------------------------------------

    function setApprovalForAll(address, bool) public pure override {
        revert Soulbound();
    }

    /// @dev Only mints (from == 0) are allowed. Transfers and burns revert.
    function _update(address from, address to, uint256[] memory ids, uint256[] memory values) internal override {
        if (from != address(0)) revert Soulbound();
        super._update(from, to, ids, values);
    }

    function _mintOnce(address to, uint256 id) internal {
        if (!badgeExists[id]) revert UnknownBadge();
        if (balanceOf(to, id) != 0) revert AlreadyOwned();
        _mint(to, id, 1, "");
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
