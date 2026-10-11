import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const directory = fileURLToPath(new URL('../data/reports/', import.meta.url));
const valid = name => /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(name);
export async function listReports() {
  let names;
  try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return Promise.all(names.filter(valid).sort().reverse().slice(0, 90).map(async id => {
    const report = await readReport(id);
    return { id, startedAt: report.startedAt, completedAt: report.completedAt, status: report.status, summary: report.summary, error: report.error };
  }));
}
export async function readReport(id) {
  if (!valid(id)) throw Object.assign(new Error('Invalid report ID'), { status: 400 });
  return JSON.parse(await readFile(path.join(directory, id), 'utf8'));
}
