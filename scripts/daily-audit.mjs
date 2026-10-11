import { mkdir, open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, 'server/data/reports');
await mkdir(directory, { recursive: true });
const lockPath = path.join(directory, '.audit.lock');
let lock;
try { lock = await open(lockPath, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const owner = Number(await readFile(lockPath, 'utf8'));
  if (!Number.isSafeInteger(owner) || owner < 2) throw new Error('Invalid audit lock; inspect server/data/reports/.audit.lock');
  let alive = true;
  try { process.kill(owner, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
  if (alive) { console.log('An audit is already running; skipped.'); process.exit(0); }
  await unlink(lockPath); lock = await open(lockPath, 'wx');
}
await lock.writeFile(String(process.pid)); await lock.close();
const startedAt = new Date().toISOString();
const file = path.join(directory, startedAt.replace(/[:.]/g, '-') + '.json');
let child;
async function save(report) { await writeFile(file + '.tmp', JSON.stringify(report, null, 2) + '\n'); await rename(file + '.tmp', file); }
try {
  await save({ startedAt, status: 'starting', timeZone: 'America/Los_Angeles', expectedPerProvider: 10, providers: [] });
  console.log('Source audit started:', startedAt);
  const result = await new Promise(resolve => {
    child = spawn(process.execPath, [path.join(root, 'server/tools/audit-rules.mjs'), '--daily', '--rules-dir', path.join(root, 'server/rules'),
      '--core-port', '8792', '--port', '8785', '--max-roads', '2', '--report', file], { cwd: root, stdio: 'inherit' });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); }, 2 * 60 * 60 * 1000);
    child.once('error', () => { clearTimeout(timer); resolve({ code: 1, error: 'Could not start audit process' }); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, error: expired ? 'Audit exceeded two hours' : 'Audit process stopped before completion' }); });
  });
  const report = JSON.parse(await readFile(file, 'utf8'));
  report.schedule = { hour: 5, minute: 0, timeZone: 'America/Los_Angeles' };
  if (result.code !== 0 || report.status !== 'completed') {
    report.status = 'failed'; report.error = result.error; report.completedAt = new Date().toISOString(); process.exitCode = 1;
  }
  report.summary = (report.providers || []).map(provider => ({ id: provider.id, expected: 10,
    passed: provider.cases.filter(item => item?.outcome === 'passed').length,
    checked: provider.cases.filter(Boolean).length }));
  await save(report);
  console.log('Source audit report:', file, report.status);
} finally { await unlink(lockPath); }
