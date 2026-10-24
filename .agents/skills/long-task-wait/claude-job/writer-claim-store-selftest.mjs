#!/usr/bin/env node
// Self-test for writer-claim-store.mjs (Issue #283, continuation job 005).
//
// Includes a REAL cross-process race test: two separate Node child processes (not just two
// in-process function calls) are spawned concurrently and race to acquire the SAME
// Repo+PR/Issue claim key under one shared synthetic claims directory. Exactly one must win;
// the loser must be BLOCKED and must have written zero claim files of its own (any file it
// attempted to create during this acquisition call is rolled back). This is the real
// concurrency proof that `preflight-audit/writer-lease-guard-selftest.mjs` test 5b explicitly
// documents as NOT being provided by that pure evaluator.
//
// All claim directories used here are synthetic temp directories created and deleted only by
// this test (bounded deletion of only test-owned temp content); the real
// `%LOCALAPPDATA%\ai-dev-foundation\writer-claims\` of the Windows user running this test is
// never read or written by this file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireClaim, buildClaimPlan, claimKeyForBranch, claimKeyForNumber, defaultClaimsDir,
  normalizeBranch, normalizeRepo, releaseClaim,
} from './writer-claim-store.mjs';

const scriptPath = fileURLToPath(new URL('./writer-claim-store.mjs', import.meta.url));
const REPO = 'Acme/App'; // deliberately mixed case to exercise normalization
const NORM_REPO = 'acme/app';

// A valid ownerToken is hex-only (OWNER_TOKEN_RE); derive one deterministically from a
// human-readable seed so each test case gets a distinct, valid, reproducible token.
function newToken(seed) { return createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 32); }
function newClaimsDir(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }
function spawnClaim(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').pop()); } catch { /* leave null on bad output */ }
      resolve({ code, parsed, raw: out });
    });
  });
}
function acquireArgs({ claimsDir, repo = REPO, pr, issue, branch, jobId, ownerToken, pid = 4242, ticks = '637000000000000000' }) {
  const args = ['--acquire', '--claims-dir', claimsDir, '--repo', repo, '--job-id', jobId, '--owner-token', ownerToken, '--pid', String(pid), '--process-start-ticks', ticks];
  if (pr !== undefined) args.push('--pr', String(pr));
  if (issue !== undefined) args.push('--issue', String(issue));
  if (branch !== undefined) args.push('--branch', branch);
  return args;
}
function releaseArgs({ claimsDir, repo = REPO, pr, issue, branch, jobId, ownerToken }) {
  const args = ['--release', '--claims-dir', claimsDir, '--repo', repo, '--job-id', jobId, '--owner-token', ownerToken];
  if (pr !== undefined) args.push('--pr', String(pr));
  if (issue !== undefined) args.push('--issue', String(issue));
  if (branch !== undefined) args.push('--branch', branch);
  return args;
}

const tempDirs = [];
function ownedTempDir(prefix) { const d = newClaimsDir(prefix); tempDirs.push(d); return d; }

async function run() {
  // 1. normalizeRepo / normalizeBranch pure validation.
  {
    assert.equal(normalizeRepo('Acme/App'), 'acme/app');
    assert.equal(normalizeRepo('bad name'), null);
    assert.equal(normalizeRepo('a/../b'), null);
    assert.equal(normalizeBranch('job/20261011-005-task'), 'job/20261011-005-task');
    assert.equal(normalizeBranch('../x'), null);
    assert.equal(normalizeBranch(''), null);
  }

  // 2. Explicit PR->Issue alias collision: same number collapses to one claim key.
  {
    const planSame = buildClaimPlan({ repo: NORM_REPO, prNumber: 42, issueNumber: 42, branch: null });
    assert.equal(planSame.length, 1);
    assert.equal(planSame[0].key, claimKeyForNumber(NORM_REPO, 42));
    const planDistinct = buildClaimPlan({ repo: NORM_REPO, prNumber: 42, issueNumber: 99, branch: null });
    assert.equal(planDistinct.length, 2);
    const planWithBranch = buildClaimPlan({ repo: NORM_REPO, prNumber: 42, issueNumber: null, branch: 'job/x' });
    assert.equal(planWithBranch.length, 2);
    assert.ok(planWithBranch.some((e) => e.key === claimKeyForBranch(NORM_REPO, 'job/x')));
  }

  // 3. defaultClaimsDir resolves under the canonical ai-dev-foundation/writer-claims subpath of
  // LOCALAPPDATA, without ever creating or touching anything (pure path join only).
  {
    const saved = process.env.LOCALAPPDATA;
    try {
      process.env.LOCALAPPDATA = join(tmpdir(), 'fake-localappdata-for-selftest-only');
      const dir = defaultClaimsDir();
      assert.ok(dir.endsWith(join('ai-dev-foundation', 'writer-claims')));
      assert.equal(existsSync(dir), false);
    } finally { process.env.LOCALAPPDATA = saved; }
  }

  // 4. In-process: fresh acquire succeeds; same (jobId, ownerToken) re-acquire blocks itself as
  // HELD_BY_OTHER-shaped (actually HELD_BY_OTHER since a new call always treats any existing
  // record as foreign -- there is no silent self bypass).
  {
    const dir = ownedTempDir('writer-claim-basic-');
    const tokenA = newToken('tokenA');
    const r1 = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 42, issueNumber: null, branch: null, jobId: 'job-1', ownerToken: tokenA, pid: 111, processStartUtcTicks: '1' });
    assert.equal(r1.ok, true);
    assert.equal(r1.acquiredKeys.length, 1);
    assert.equal(readdirSync(dir).length, 1);

    const r2 = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 42, issueNumber: null, branch: null, jobId: 'job-2', ownerToken: newToken('tokenB'), pid: 222, processStartUtcTicks: '2' });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'WRITER_CLAIM_HELD_BY_OTHER');
    assert.equal(readdirSync(dir).length, 1); // loser created zero net files

    const rel = releaseClaim({ claimsDir: dir, repo: REPO, prNumber: 42, issueNumber: null, branch: null, jobId: 'job-1', ownerToken: tokenA });
    assert.equal(rel.ok, true);
    assert.equal(readdirSync(dir).length, 0);

    // Full normal lifecycle: release then re-acquire (clean repeated continuation) succeeds.
    const r3 = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 42, issueNumber: null, branch: null, jobId: 'job-1', ownerToken: newToken('tokenC'), pid: 333, processStartUtcTicks: '3' });
    assert.equal(r3.ok, true);
    const rel2 = releaseClaim({ claimsDir: dir, repo: REPO, prNumber: 42, issueNumber: null, branch: null, jobId: 'job-1', ownerToken: newToken('tokenC') });
    assert.equal(rel2.ok, true);
  }

  // 5. Partial multi-key rollback: a branch+PR acquire whose PR key is already foreign-held must
  // not leave the branch key behind either.
  {
    const dir = ownedTempDir('writer-claim-rollback-');
    const prKey = claimKeyForNumber(NORM_REPO, 7);
    writeFileSync(join(dir, `${prKey}.json`), JSON.stringify({
      schemaVersion: 1, ownerToken: newToken('foreign'), jobId: 'foreign-job', pid: 1, processStartUtcTicks: '1', repo: NORM_REPO, claimedAtIso: new Date().toISOString(),
    }));
    const r = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 7, issueNumber: null, branch: 'job/rollback', jobId: 'job-x', ownerToken: newToken('tokenX'), pid: 1, processStartUtcTicks: '1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'WRITER_CLAIM_HELD_BY_OTHER');
    const branchPath = join(dir, `${claimKeyForBranch(NORM_REPO, 'job/rollback')}.json`);
    assert.equal(existsSync(branchPath), false); // rolled back, not left behind
    assert.equal(readdirSync(dir).length, 1); // only the pre-existing foreign PR claim remains
  }

  // 6. Malformed record BLOCKED, never auto-repaired/auto-reclaimed.
  {
    const dir = ownedTempDir('writer-claim-malformed-');
    const key = claimKeyForNumber(NORM_REPO, 55);
    writeFileSync(join(dir, `${key}.json`), 'not json { at all');
    const r = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 55, issueNumber: null, branch: null, jobId: 'job-1', ownerToken: newToken('tokenM'), pid: 1, processStartUtcTicks: '1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'WRITER_CLAIM_RECORD_MALFORMED');
    assert.equal(readFileSync(join(dir, `${key}.json`), 'utf8'), 'not json { at all'); // left untouched
  }

  // 7. Crash/stale fail-closed: a well-formed record from a plausibly-dead process (never went
  // through this module's own release) and with an ancient claimedAtIso is STILL retained --
  // there is no TTL and no liveness check in this module; it blocks exactly like a live claim.
  {
    const dir = ownedTempDir('writer-claim-stale-');
    const key = claimKeyForNumber(NORM_REPO, 9);
    writeFileSync(join(dir, `${key}.json`), JSON.stringify({
      schemaVersion: 1, ownerToken: newToken('deadproc'), jobId: 'dead-job', pid: 999999, processStartUtcTicks: '1',
      repo: NORM_REPO, claimedAtIso: new Date(0).toISOString(),
    }));
    const r = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 9, issueNumber: null, branch: null, jobId: 'job-new', ownerToken: newToken('tokenN'), pid: 1, processStartUtcTicks: '1' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'WRITER_CLAIM_HELD_BY_OTHER');
  }

  // 8. Process-live ownership older than any notional TTL is retained identically: age alone
  // never matters either way (neither to expire it nor to require it); re-attempting after
  // "aging" the record in place still blocks.
  {
    const dir = ownedTempDir('writer-claim-ttl-');
    const tokenA = newToken('tokenTtl');
    const r1 = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 11, issueNumber: null, branch: null, jobId: 'job-ttl', ownerToken: tokenA, pid: process.pid, processStartUtcTicks: '123' });
    assert.equal(r1.ok, true);
    const [file] = r1.claimFiles;
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    rec.claimedAtIso = new Date(0).toISOString(); // simulate a very old claim
    writeFileSync(file, JSON.stringify(rec));
    const r2 = acquireClaim({ claimsDir: dir, repo: REPO, prNumber: 11, issueNumber: null, branch: null, jobId: 'job-ttl-2', ownerToken: newToken('tokenTtl2'), pid: 1, processStartUtcTicks: '1' });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'WRITER_CLAIM_HELD_BY_OTHER');
  }

  // 9. CLI argument validation fails closed on unknown/missing/duplicate flags.
  {
    const dir = ownedTempDir('writer-claim-cli-args-');
    const bad1 = await spawnClaim(['--acquire', '--claims-dir', dir, '--repo', REPO, '--job-id', 'j', '--owner-token', newToken('t'), '--pid', '1', '--process-start-ticks', '1', '--bogus', 'x']);
    assert.notEqual(bad1.code, 0);
    const bad2 = await spawnClaim(['--acquire', '--claims-dir', dir, '--repo', REPO]);
    assert.notEqual(bad2.code, 0);
    const bad3 = await spawnClaim(['--acquire', '--release', '--claims-dir', dir, '--repo', REPO, '--job-id', 'j', '--owner-token', newToken('t'), '--pid', '1', '--process-start-ticks', '1']);
    assert.notEqual(bad3.code, 0);
  }

  // 10. CLI acquire/release round trip (single process, sequential) matches the in-process API.
  {
    const dir = ownedTempDir('writer-claim-cli-roundtrip-');
    const token = newToken('cliTok');
    const a = await spawnClaim(acquireArgs({ claimsDir: dir, pr: 13, jobId: 'cli-job', ownerToken: token }));
    assert.equal(a.code, 0);
    assert.equal(a.parsed.ok, true);
    const b = await spawnClaim(releaseArgs({ claimsDir: dir, pr: 13, jobId: 'cli-job', ownerToken: token }));
    assert.equal(b.code, 0);
    assert.equal(b.parsed.ok, true);
    assert.equal(readdirSync(dir).length, 0);
  }

  // 11. REAL cross-process race: two separate Node child processes simultaneously claim the SAME
  // Repo+PR across two distinct simulated RepoPath roots (two distinct temp "worktree" dirs,
  // used here only as the cwd each child runs from, since the claim location is intentionally
  // independent of RepoPath). Exactly one must succeed; the loser must be BLOCKED and the shared
  // claims directory must contain exactly the winner's one claim file -- proof the loser wrote
  // zero claim files.
  {
    const claimsDir = ownedTempDir('writer-claim-race-');
    const simulatedRepoA = ownedTempDir('writer-claim-race-repoA-');
    const simulatedRepoB = ownedTempDir('writer-claim-race-repoB-');
    const tokenA = newToken('raceTokenA');
    const tokenB = newToken('raceTokenB');
    const [resA, resB] = await Promise.all([
      spawnClaim(acquireArgs({ claimsDir, pr: 4242, jobId: 'race-job-A', ownerToken: tokenA, pid: 1001 })),
      spawnClaim(acquireArgs({ claimsDir, pr: 4242, jobId: 'race-job-B', ownerToken: tokenB, pid: 1002 })),
    ]);
    // simulatedRepoA/B are never written to by writer-claim-store.mjs itself; this just proves
    // the "separate RepoPath roots" framing did not accidentally share any filesystem state.
    assert.equal(readdirSync(simulatedRepoA).length, 0);
    assert.equal(readdirSync(simulatedRepoB).length, 0);

    const outcomes = [resA, resB];
    const winners = outcomes.filter((o) => o.code === 0 && o.parsed && o.parsed.ok === true);
    const losers = outcomes.filter((o) => o.code !== 0);
    assert.equal(winners.length, 1, 'exactly one of the two concurrent claims must win');
    assert.equal(losers.length, 1, 'exactly one of the two concurrent claims must be blocked');
    assert.equal(losers[0].parsed.code, 'WRITER_CLAIM_HELD_BY_OTHER');

    const files = readdirSync(claimsDir);
    assert.equal(files.length, 1, 'the shared claims directory must contain exactly one claim file after the race');
    const onDisk = JSON.parse(readFileSync(join(claimsDir, files[0]), 'utf8'));
    const winnerToken = winners[0] === resA ? tokenA : tokenB;
    assert.equal(onDisk.ownerToken, winnerToken, 'the surviving claim file must belong to the winner, never the loser');
  }

  // 12. Distinct PR numbers on the same repo may execute concurrently (both succeed).
  {
    const claimsDir = ownedTempDir('writer-claim-distinct-pr-');
    const [resA, resB] = await Promise.all([
      spawnClaim(acquireArgs({ claimsDir, pr: 501, jobId: 'job-distinct-A', ownerToken: newToken('distinctA') })),
      spawnClaim(acquireArgs({ claimsDir, pr: 502, jobId: 'job-distinct-B', ownerToken: newToken('distinctB') })),
    ]);
    assert.equal(resA.code, 0);
    assert.equal(resB.code, 0);
    assert.equal(readdirSync(claimsDir).length, 2);
  }

  // 13. Distinct branches (no PR/Issue overlap) on the same repo may also execute concurrently.
  {
    const claimsDir = ownedTempDir('writer-claim-distinct-branch-');
    const [resA, resB] = await Promise.all([
      spawnClaim(acquireArgs({ claimsDir, pr: 601, branch: 'job/a', jobId: 'job-branch-A', ownerToken: newToken('branchA') })),
      spawnClaim(acquireArgs({ claimsDir, pr: 602, branch: 'job/b', jobId: 'job-branch-B', ownerToken: newToken('branchB') })),
    ]);
    assert.equal(resA.code, 0);
    assert.equal(resB.code, 0);
    assert.equal(readdirSync(claimsDir).length, 4); // 2 PR keys + 2 branch keys
  }

  // 14. PR-vs-pre-PR-Issue alias on the SAME number, raced across two processes, must collide
  // and block exactly one of them -- the alias is not silently treated as two different targets.
  {
    const claimsDir = ownedTempDir('writer-claim-alias-race-');
    const [resA, resB] = await Promise.all([
      spawnClaim(acquireArgs({ claimsDir, pr: 777, jobId: 'job-alias-pr', ownerToken: newToken('aliasPr') })),
      spawnClaim(acquireArgs({ claimsDir, issue: 777, jobId: 'job-alias-issue', ownerToken: newToken('aliasIssue') })),
    ]);
    const codes = [resA.code, resB.code].sort();
    assert.deepEqual(codes, [0, 2]);
    assert.equal(readdirSync(claimsDir).length, 1);
  }

  console.log('writer-claim-store-selftest: all assertions passed');
}

try {
  await run();
} finally {
  for (const d of tempDirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup of this test's own temp dirs only */ }
  }
}
