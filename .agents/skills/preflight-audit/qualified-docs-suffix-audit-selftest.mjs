#!/usr/bin/env node
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyDocsOnlySuffix } from './qualified-docs-suffix-audit.mjs';

let testCount = 0;
function check(condition, message) {
  testCount += 1;
  assert.ok(condition, `FAIL(${testCount}): ${message}`);
}

const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qualified-docs-suffix-audit-selftest-'));

function git(args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' }).trim();
}
function commit(message) {
  git(['add', '-A']);
  git(['commit', '-m', message]);
  return git(['rev-parse', 'HEAD']);
}
function write(relPath, content) {
  const full = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

try {
  git(['init']);
  git(['config', 'user.name', 'Synthetic Selftest']);
  git(['config', 'user.email', 'synthetic-selftest@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);

  write('src/app.ts', "console.log('v1');\n");
  const baseHead = commit('base source commit');

  write('docs/notes.md', '# Notes v1\n');
  const head1 = commit('approved docs-only commit');
  const r1 = verifyDocsOnlySuffix({ repoRoot, fromHead: baseHead, toHead: head1, allowedPaths: ['docs/notes.md'] });
  check(r1.result === 'DOCS_ONLY_SUFFIX_CONFIRMED_NOT_MERGE_AUTHORIZATION', 'approved docs-only suffix confirmed');

  write('src/app.ts', "console.log('v2');\n");
  commit('intermediate source edit');
  write('src/app.ts', "console.log('v1');\n");
  const head3 = commit('revert intermediate source edit');
  write('docs/more.md', '# More\n');
  const head4 = commit('another approved docs change');
  const allowed = ['docs/notes.md', 'docs/more.md'];

  const r2 = verifyDocsOnlySuffix({ repoRoot, fromHead: baseHead, toHead: head4, allowedPaths: allowed });
  check(r2.result === 'STOP' && r2.code === 'OUT_OF_SCOPE_CHANGE', 'intermediate src edit+revert still OUT_OF_SCOPE_CHANGE from base');

  const r3 = verifyDocsOnlySuffix({ repoRoot, fromHead: head3, toHead: head1, allowedPaths: allowed });
  check(r3.result === 'STOP' && r3.code === 'CURRENT_HEAD_MISMATCH', 'wrong final SHA yields CURRENT_HEAD_MISMATCH');

  const r4 = verifyDocsOnlySuffix({ repoRoot, fromHead: head3, toHead: head4, allowedPaths: [] });
  check(r4.result === 'STOP' && r4.code === 'OUT_OF_SCOPE_CHANGE', 'unapproved docs list yields OUT_OF_SCOPE_CHANGE');

  write('docs/notes.md', '# Notes v1 dirty uncommitted\n');
  const r5 = verifyDocsOnlySuffix({ repoRoot, fromHead: head3, toHead: head4, allowedPaths: allowed });
  check(r5.result === 'STOP' && r5.code === 'WORKTREE_NOT_CLEAN', 'dirty worktree yields WORKTREE_NOT_CLEAN');
  git(['checkout', '--', '.']);

  fs.rmSync(path.join(repoRoot, 'docs', 'more.md'));
  const head5 = commit('docs deletion');
  const r6 = verifyDocsOnlySuffix({ repoRoot, fromHead: head4, toHead: head5, allowedPaths: ['docs/more.md'] });
  check(r6.result === 'STOP' && r6.code === 'DOCS_DELETION_REFUSED', 'docs deletion yields DOCS_DELETION_REFUSED');

  console.log(`QUALIFIED_DOCS_SUFFIX_AUDIT_SELFTEST=PASS tests=${testCount}`);
} finally {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}
