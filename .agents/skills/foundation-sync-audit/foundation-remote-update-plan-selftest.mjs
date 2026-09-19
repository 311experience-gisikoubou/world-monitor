#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const helperArg = process.argv[2];
if (!helperArg) throw new Error('helper path required');
const helper = resolve(helperArg);
const sha = (c) => c.repeat(40);
const blobSha = (content) => {
  const body = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};
const replaceContent = 'new agents\n';
const createContent = 'new helper\n';
const base = {
  fromVersion: '1.0.0-dev.38',
  sourceVersion: '1.0.0-dev.39',
  fromCommit: sha('1'),
  sourceCommit: sha('2'),
  targetRepository: 'owner/repo',
  targetBranch: 'chore/foundation-dev39-sync',
  targetHead: sha('3'),
  targetBaseTree: sha('4'),
  entries: [
    { path: 'AGENTS.md', oldSha: sha('a'), newSha: blobSha(replaceContent), targetSha: sha('a'), newContent: replaceContent },
    { path: '.agents/skills/x/SKILL.md', oldSha: sha('c'), newSha: sha('c'), targetSha: sha('c') },
    { path: '.agents/skills/x/new.mjs', oldSha: null, newSha: blobSha(createContent), targetSha: null, newContent: createContent },
    { path: '.agents/skills/x/old.mjs', oldSha: sha('e'), newSha: null, targetSha: sha('e') },
  ],
};
function run(manifest, expected = 0) {
  const r = spawnSync(process.execPath, [helper, '--manifest-json', JSON.stringify(manifest)], { encoding: 'utf8' });
  if (r.status !== expected) throw new Error(`status ${r.status}, expected ${expected}: ${r.stdout} ${r.stderr}`);
  return JSON.parse(r.stdout);
}
let out = run(base);
if (out.code !== 'FOUNDATION_REMOTE_UPDATE_PLAN_READY') throw new Error(JSON.stringify(out));
if (out.counts.planned !== 3 || out.counts.replaced !== 1 || out.counts.created !== 1 || out.counts.deleted !== 1 || out.counts.unchanged !== 1) throw new Error(JSON.stringify(out));
if (out.gitDataContract.updateRef.force !== false || out.gitDataContract.updateRef.expectedCurrentHead !== sha('3')) throw new Error(JSON.stringify(out));
if (out.gitDataContract.createTree.treeElements.length !== 3) throw new Error(JSON.stringify(out));
if (!out.requiredBlobShas.includes(blobSha(replaceContent)) || !out.requiredBlobShas.includes(blobSha(createContent))) throw new Error(JSON.stringify(out));
if (out.preferredTransport !== 'contents-api') throw new Error(JSON.stringify(out));
if (!out.contentsApiContract.available || out.contentsApiContract.reason !== 'READY') throw new Error(JSON.stringify(out));
if (out.contentsApiContract.expectedStartingHead !== sha('3') || !out.contentsApiContract.sequentialWritesRequired) throw new Error(JSON.stringify(out));
if (out.contentsApiContract.operations.length !== 3) throw new Error(JSON.stringify(out));
const replace = out.contentsApiContract.operations.find((entry) => entry.op === 'replace');
const create = out.contentsApiContract.operations.find((entry) => entry.op === 'create');
const remove = out.contentsApiContract.operations.find((entry) => entry.op === 'delete');
if (replace?.method !== 'update_file' || replace?.content !== replaceContent || replace?.expectedCurrentSha !== sha('a')) throw new Error(JSON.stringify(out));
if (create?.method !== 'create_file' || create?.content !== createContent || create?.expectedCurrentSha !== null) throw new Error(JSON.stringify(out));
if (remove?.method !== 'delete_file' || remove?.expectedResultSha !== null) throw new Error(JSON.stringify(out));

out = run({ ...base, entries: [{ path: 'AGENTS.md', oldSha: sha('a'), newSha: blobSha(replaceContent), targetSha: sha('9'), newContent: replaceContent }] }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_TARGET_DRIFT') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [{ path: '.agents/skills/x/new.mjs', oldSha: null, newSha: blobSha(createContent), targetSha: sha('9'), newContent: createContent }] }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_NEW_PATH_CONFLICT') throw new Error(JSON.stringify(out));
out = run({ ...base, targetBranch: 'main' }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_PROTECTED_BRANCH') throw new Error(JSON.stringify(out));
out = run({ ...base, targetBranch: 'refs/heads/main' }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_PROTECTED_BRANCH') throw new Error(JSON.stringify(out));
out = run({ ...base, targetBranch: 'refs/heads/chore/foundation-dev39-sync' });
if (out.targetBranch !== 'chore/foundation-dev39-sync') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [{ path: 'AGENTS.local.md', oldSha: sha('a'), newSha: blobSha(replaceContent), targetSha: sha('a'), newContent: replaceContent }] }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_PATH_OUTSIDE_SHARED_SURFACE') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [base.entries[0], base.entries[0]] }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_DUPLICATE_PATH') throw new Error(JSON.stringify(out));
out = run({ ...base, targetHead: 'bad' }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_TARGET_HEAD_INVALID') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [{ path: '.agents/skills/x/new.mjs', oldSha: null, newSha: blobSha(createContent), targetSha: blobSha(createContent), newContent: createContent }] });
if (out.counts.planned !== 0 || out.counts.unchanged !== 1) throw new Error(JSON.stringify(out));
out = run({ ...base, fromVersion: base.sourceVersion }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_VERSION_NOT_ADVANCED') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [{ path: 'AGENTS.md', oldSha: sha('a'), newSha: blobSha(replaceContent), targetSha: sha('a'), newContent: 'tampered\n' }] }, 2);
if (out.code !== 'FOUNDATION_REMOTE_PLAN_SOURCE_CONTENT_SHA_MISMATCH') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [{ path: 'AGENTS.md', oldSha: sha('a'), newSha: blobSha(replaceContent), targetSha: sha('a') }] });
if (out.preferredTransport !== 'git-data') throw new Error(JSON.stringify(out));
if (out.contentsApiContract.available || out.contentsApiContract.reason !== 'SOURCE_CONTENT_REQUIRED') throw new Error(JSON.stringify(out));
out = run({ ...base, entries: [{ path: '.agents/skills/x/old.mjs', oldSha: sha('e'), newSha: null, targetSha: sha('e') }] });
if (!out.contentsApiContract.available || out.contentsApiContract.operations[0]?.method !== 'delete_file') throw new Error(JSON.stringify(out));

console.log('foundation-remote-update-plan selftest: PASS');
