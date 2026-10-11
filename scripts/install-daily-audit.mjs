import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('This installer uses macOS launchd');
const root = fileURLToPath(new URL('../', import.meta.url));
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (zone !== 'America/Los_Angeles') throw new Error('Mac system time zone must be America/Los_Angeles for this 05:00 schedule; current: ' + zone);
const label = 'dev.forgetech.bangumi-source-audit';
const dir = path.join(homedir(), 'Library/LaunchAgents');
const file = path.join(dir, label + '.plist');
const logs = path.join(root, 'server/data/logs');
await mkdir(dir, { recursive: true }); await mkdir(logs, { recursive: true });
const xml = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const args = ['/usr/bin/caffeinate', '-i', process.execPath, path.join(root, 'scripts/daily-audit.mjs')];
await writeFile(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(value => '<string>' + xml(value) + '</string>').join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>5</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'daily-audit.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'daily-audit-error.log'))}</string>
</dict></plist>\n`, { mode: 0o600 });
const domain = 'gui/' + process.getuid();
spawnSync('launchctl', ['bootout', domain + '/' + label], { stdio: 'ignore' });
const result = spawnSync('launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
if (result.status !== 0) throw new Error('Could not register launch agent');
console.log('Installed daily 05:00 America/Los_Angeles audit:', file);
console.log('Mac must be logged in and awake at 05:00; sleeping jobs run when it wakes.');
