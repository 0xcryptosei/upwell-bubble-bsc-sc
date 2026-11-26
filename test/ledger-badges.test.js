// CallLedger and UpwellBadges.
const assert = require('node:assert/strict')
const { ethers } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')
const { DAY, wait, now } = require('./fixtures')

// leaf types exactly as backend/src/services/epochs.js
const CALL_LEAF = ['uint256', 'address', 'address', 'uint8', 'uint256', 'uint256', 'uint64', 'uint64', 'bool']
const STATS_LEAF = ['address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256']
const toCall = (v) => ({ callId: v[0], caller: v[1], token: v[2], window: v[3], entryMcap: v[4], exitMcap: v[5], startAt: v[6], endAt: v[7], won: v[8] })
const toStats = (v) => ({ caller: v[0], epoch: v[1], calls: v[2], wins: v[3], bestMultipleBps: v[4], score: v[5], xp: v[6] })

async function ledgerSetup() {
  const [admin, publisher, alice, bob] = await ethers.getSigners()
  const ledger = await (await ethers.getContractFactory('CallLedger')).deploy(admin.address, publisher.address)
  const token = '0x' + '7'.repeat(36) + '7777'
  const calls = [
    [1n, alice.address, token, 1, 12_000_000n, 30_000_000n, 1_795_000_000n, 1_795_086_400n, true],
    [2n, bob.address, token, 0, 50_000_000n, 40_000_000n, 1_795_000_100n, 1_795_003_700n, false],
    [3n, alice.address, token, 2, 9_000_000n, 9_100_000n, 1_795_000_200n, 1_795_604_800n, false],
  ]
  const stats = [[alice.address, 1n, 2n, 1n, 25000n, 180n, 120n], [bob.address, 1n, 1n, 0n, 0n, 0n, 2n]]
  return { admin, publisher, alice, bob, ledger, callsTree: StandardMerkleTree.of(calls, CALL_LEAF), statsTree: StandardMerkleTree.of(stats, STATS_LEAF) }
}

describe('CallLedger', () => {
  it('publishes weeks in order, once each, by the publisher only', async () => {
    const { ledger, publisher, alice, callsTree, statsTree } = await ledgerSetup()
    await assert.rejects(ledger.connect(alice).publish(1, callsTree.root, statsTree.root, 3, ''), /AccessControlUnauthorizedAccount/)
    await assert.rejects(ledger.connect(publisher).publish(2, callsTree.root, statsTree.root, 3, ''), /OutOfOrder/)
    await assert.rejects(ledger.connect(publisher).publish(1, ethers.ZeroHash, statsTree.root, 3, ''), /EmptyRoot/)
    await ledger.connect(publisher).publish(1, callsTree.root, statsTree.root, 3, 'ipfs://week1')
    const t = await now()
    await assert.rejects(ledger.connect(publisher).publish(1, callsTree.root, statsTree.root, 3, ''), /AlreadyPublished/)
    const e = await ledger.entries(1)
    assert.equal(e.callsRoot, callsTree.root); assert.equal(e.statsRoot, statsTree.root)
    assert.equal(e.callCount, 3n); assert.equal(e.publishedAt, BigInt(t)); assert.equal(e.uri, 'ipfs://week1')
    assert.equal(await ledger.latestEpoch(), 1n)
    await ledger.connect(publisher).publish(2, ethers.ZeroHash, ethers.ZeroHash, 0, '') // an empty week is fine
    assert.equal(await ledger.latestEpoch(), 2n)
  })

  it('proves every call and stats record built by the backend, and rejects altered ones', async () => {
    const { ledger, publisher, callsTree, statsTree } = await ledgerSetup()
    await ledger.connect(publisher).publish(1, callsTree.root, statsTree.root, 3, '')
    for (const [i, v] of callsTree.entries()) {
      assert.equal(await ledger.verifyCall(1, toCall(v), callsTree.getProof(i)), true)
      assert.equal(await ledger.callLeaf(...v), callsTree.leafHash(v), 'leaf helper matches the backend encoding')
      const forged = toCall(v); forged.won = !forged.won
      assert.equal(await ledger.verifyCall(1, forged, callsTree.getProof(i)), false, 'a flipped result does not verify')
    }
    for (const [i, v] of statsTree.entries()) {
      assert.equal(await ledger.verifyStats(1, toStats(v), statsTree.getProof(i)), true)
      assert.equal(await ledger.statsLeaf(...v), statsTree.leafHash(v))
      const forged = toStats(v); forged.score += 1n
      assert.equal(await ledger.verifyStats(1, forged, statsTree.getProof(i)), false)
    }
    // a record proven against the wrong week, or an unpublished week, fails
    const [i0, v0] = [...callsTree.entries()][0]
    assert.equal(await ledger.verifyCall(2, toCall(v0), callsTree.getProof(i0)), false)
  })
})

async function badgesSetup() {
  const [admin, minter, alice, bob, mallory] = await ethers.getSigners()
  const badges = await (await ethers.getContractFactory('UpwellBadges')).deploy(admin.address, minter.address, 'https://api.upwell.xyz/badges/{id}.json')
  const domain = { name: 'Upwell Badges', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await badges.getAddress() }
  const types = { Claim: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }
  const sign = (signer, account, id, deadline) => signer.signTypedData(domain, types, { account, id, deadline })
  return { admin, minter, alice, bob, mallory, badges, sign }
}

describe('UpwellBadges', () => {
  it('has badges 1-9, metadata and interfaces', async () => {
    const { badges } = await badgesSetup()
    for (let id = 1; id <= 9; id++) assert.equal(await badges.badgeExists(id), true)
    assert.equal(await badges.badgeExists(10), false)
    assert.equal(await badges.name(), 'Upwell Badges'); assert.equal(await badges.symbol(), 'UPWB')
    assert.equal(await badges.uri(1), 'https://api.upwell.xyz/badges/{id}.json')
    assert.equal(await badges.supportsInterface('0xd9b67a26'), true) // ERC-1155
    assert.equal(await badges.supportsInterface('0x7965db0b'), true) // AccessControl
  })

  it('the minter mints each badge once per wallet; others cannot mint', async () => {
    const { badges, minter, alice, mallory } = await badgesSetup()
    await assert.rejects(badges.connect(mallory).mint(alice.address, 1), /AccessControlUnauthorizedAccount/)
    await badges.connect(minter).mint(alice.address, 1)
    assert.equal(await badges.balanceOf(alice.address, 1), 1n)
    await assert.rejects(badges.connect(minter).mint(alice.address, 1), /AlreadyOwned/)
    await assert.rejects(badges.connect(minter).mint(alice.address, 42), /UnknownBadge/)
  })

  it('mintBatch skips owned and unknown badges instead of failing the whole batch', async () => {
    const { badges, minter, alice, bob } = await badgesSetup()
    await badges.connect(minter).mint(alice.address, 2)
    await assert.rejects(badges.connect(minter).mintBatch([alice.address], [1, 2]), /length mismatch/)
    await badges.connect(minter).mintBatch([alice.address, bob.address, bob.address, alice.address], [2, 3, 99, 3])
    assert.equal(await badges.balanceOf(alice.address, 2), 1n)
    assert.equal(await badges.balanceOf(bob.address, 3), 1n)
    assert.equal(await badges.balanceOf(alice.address, 3), 1n)
  })

  it('a caller claims with the backend signature; expired, forged, replayed or someone else\'s signatures fail', async () => {
    const { badges, minter, alice, bob, mallory, sign } = await badgesSetup()
    const deadline = (await now()) + DAY
    const sig = await sign(minter, alice.address, 5, deadline)
    await assert.rejects(badges.connect(bob).claim(5, deadline, sig), /BadSignature/) // not bob's signature
    await assert.rejects(badges.connect(alice).claim(6, deadline, sig), /BadSignature/) // other badge
    await assert.rejects(badges.connect(alice).claim(5, deadline, await sign(mallory, alice.address, 5, deadline)), /BadSignature/)
    await badges.connect(alice).claim(5, deadline, sig)
    assert.equal(await badges.balanceOf(alice.address, 5), 1n)
    await assert.rejects(badges.connect(alice).claim(5, deadline, sig), /AlreadyOwned/) // replay
    const late = (await now()) + 10
    const sig2 = await sign(minter, alice.address, 6, late)
    await wait(60)
    await assert.rejects(badges.connect(alice).claim(6, late, sig2), /SignatureExpired/)
  })

  it('badges are soulbound: no transfers, no approvals, no burns', async () => {
    const { badges, minter, alice, bob } = await badgesSetup()
    await badges.connect(minter).mint(alice.address, 1)
    await assert.rejects(badges.connect(alice).safeTransferFrom(alice.address, bob.address, 1, 1, '0x'), /Soulbound/)
    await assert.rejects(badges.connect(alice).safeBatchTransferFrom(alice.address, bob.address, [1], [1], '0x'), /Soulbound/)
    await assert.rejects(badges.connect(alice).setApprovalForAll(bob.address, true), /Soulbound/)
  })

  it('admin creates badges and the URI role updates metadata', async () => {
    const { badges, admin, minter, alice, mallory } = await badgesSetup()
    await assert.rejects(badges.connect(mallory).createBadge(10), /AccessControlUnauthorizedAccount/)
    await badges.connect(admin).createBadge(10)
    await badges.connect(minter).mint(alice.address, 10)
    await assert.rejects(badges.connect(mallory).setURI('x'), /AccessControlUnauthorizedAccount/)
    await badges.connect(admin).setURI('ipfs://badges/{id}')
    assert.equal(await badges.uri(1), 'ipfs://badges/{id}')
  })
})
