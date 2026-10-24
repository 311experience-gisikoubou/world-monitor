#!/usr/bin/env node
// Synthetic-only Windows-compatible Git batching behavior regression.
// The official foundation-update selftest separately exercises updater CLI.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

function git(cwd, ...args) {
  return spawnSync('git', args, {cwd, windowsHide:true, encoding:'utf8', timeout:8000, maxBuffer:2*1024*1024});
}
const repo=mkdtempSync(join(tmpdir(),'foundation-mixed-batch-'));
try {
  assert.equal(git(repo,'init','--quiet').status,0);
  git(repo,'config','user.name','Synthetic');
  git(repo,'config','user.email','synthetic@example.invalid');
  mkdirSync(join(repo,'docs'));
  const names=['docs/test.md','a.txt','b.txt'];
  writeFileSync(join(repo,names[0]),'one\n');
  writeFileSync(join(repo,names[1]),'two\n');
  writeFileSync(join(repo,names[2]),'three\n');
  assert.equal(git(repo,'add','--',...names).status,0);
  assert.equal(git(repo,'commit','-qm','synthetic').status,0);
  test('NUL tree records and stdin-paths canonical hashes agree for all entries',()=>{
    const tree=git(repo,'ls-tree','-r','-z','HEAD');
    assert.equal(tree.status,0);
    const paths=new Map();
    for(const line of tree.stdout.split('\0').filter(Boolean)){
      const m=/^([0-7]{6}) (\S+) ([0-9a-f]{40})\t(.+)$/.exec(line);
      assert.ok(m);
      assert.equal(m[2],'blob');
      assert.ok(['100644','100755'].includes(m[1]));
      paths.set(m[4],m[3]);
    }
    const list=[...paths.keys()].sort();
    const batch=spawnSync('git',['hash-object','--stdin-paths'],{cwd:repo,windowsHide:true,encoding:'utf8',input:list.join('\n')+'\n',timeout:8000});
    assert.equal(batch.status,0);
    const got=batch.stdout.trim().split(/\r?\n/);
    assert.deepEqual(got,list.map(x=>paths.get(x)));
    for(const n of list) assert.equal(git(repo,'hash-object','--',n).stdout.trim(),paths.get(n));
  });
  test('forged or absent blob OIDs must not match batch tree',()=>{
    const tree=git(repo,'ls-tree','-r','-z','HEAD');
    assert.equal(tree.status,0);
    assert.ok(!tree.stdout.includes('0'.repeat(40)));
    assert.equal(git(repo,'ls-tree','--name-only','HEAD','--','not-present-file').stdout.trim(),'');
  });
} finally {
  // Keep the temporary fixture until Node's test runner has executed tests.
  process.on('exit',()=>rmSync(repo,{recursive:true,force:true}));
}
