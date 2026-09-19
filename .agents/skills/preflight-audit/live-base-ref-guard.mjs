import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set(['base', 'remote']);
function parseArgs(argv) {
  const out = { pretty: false };
  const seen = new Set();
  for (let i = 0; i < argv.length;) {
    const token = argv[i];
    if (token === '--pretty') { out.pretty = true; i += 1; continue; }
    if (!token?.startsWith('--')) throw new Error('CLI_ARGUMENT_INVALID');
    const key = token.slice(2);
    if (!ALLOWED.has(key) || seen.has(key)) throw new Error('CLI_ARGUMENT_INVALID');
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error('CLI_ARGUMENT_INVALID');
    seen.add(key);
    out[key] = value;
    i += 2;
  }
  if (!Object.hasOwn(out, 'remote')) out.remote = 'origin';
  return out;
}

function runGit(args, cwd = process.cwd()) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
}

function validSha(value) { return /^[0-9a-f]{40}$/i.test(String(value ?? '')); }
function stop(code, extra = {}) { return { schemaVersion: 1, result: 'STOP', code, ...extra }; }
export function observeLiveBaseRef({ base, remote = 'origin', cwd = process.cwd() }) {
  if (!/^[A-Za-z0-9._/-]+$/.test(base ?? '')) return stop('BASE_BRANCH_INVALID');
  if (!/^[A-Za-z0-9._-]+$/.test(remote ?? '') || String(remote).startsWith('-')) return stop('REMOTE_NAME_INVALID');

  const root = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (root.status !== 0) return stop('NOT_GIT_REPOSITORY');

  const live = runGit(['ls-remote', '--heads', remote, `refs/heads/${base}`], cwd);
  if (live.status !== 0) return stop('LIVE_BASE_QUERY_FAILED', { baseBranch: base, remote });
  const rows = live.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (rows.length !== 1) return stop(rows.length === 0 ? 'LIVE_BASE_REF_MISSING' : 'LIVE_BASE_REF_AMBIGUOUS', { baseBranch: base, remote });
  const [liveSha, liveRef, ...extra] = rows[0].trim().split(/\s+/);
  if (extra.length || liveRef !== `refs/heads/${base}` || !validSha(liveSha)) {
    return stop('LIVE_BASE_RESPONSE_INVALID', { baseBranch: base, remote });
  }

  const trackingRef = `refs/remotes/${remote}/${base}`;
  const local = runGit(['rev-parse', '--verify', `${trackingRef}^{commit}`], cwd);
  if (local.status !== 0) return stop('LOCAL_TRACKING_REF_MISSING', { baseBranch: base, remote, liveBaseSha: liveSha.toLowerCase() });
  const localSha = local.stdout.trim().toLowerCase();
  if (!validSha(localSha)) return stop('LOCAL_TRACKING_REF_INVALID', { baseBranch: base, remote, liveBaseSha: liveSha.toLowerCase() });
  const normalizedLive = liveSha.toLowerCase();
  if (localSha !== normalizedLive) {
    return stop('LOCAL_TRACKING_REF_STALE', {
      baseBranch: base,
      remote,
      localTrackingSha: localSha,
      liveBaseSha: normalizedLive,
    });
  }
  return {
    schemaVersion: 1,
    result: 'PROCEED',
    code: 'LIVE_BASE_TRACKING_CURRENT',
    baseBranch: base,
    remote,
    localTrackingSha: localSha,
    liveBaseSha: normalizedLive,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.base) throw new Error('BASE_BRANCH_REQUIRED');
    const report = observeLiveBaseRef(args);
    console.log(JSON.stringify(report, null, args.pretty ? 2 : 0));
    console.error(`LIVE_BASE_REF_GUARD=${report.result}`);
    if (report.result !== 'PROCEED') process.exitCode = 2;
  } catch (error) {
    const code = error instanceof Error ? error.message : 'LIVE_BASE_REF_GUARD_ERROR';
    console.log(JSON.stringify(stop(code), null, process.argv.includes('--pretty') ? 2 : 0));
    console.error('LIVE_BASE_REF_GUARD=STOP');
    process.exitCode = 2;
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCli) await main();
