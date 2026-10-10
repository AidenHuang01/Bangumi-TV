import { spawnSync } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../media/Playback-test.mp4', import.meta.url));
try { await access(output); console.log('Demo already exists: ' + output); process.exit(0); } catch {}
// Locally generated footage: no downloads or external media dependencies.
const result = spawnSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-n',
  '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '45', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level:v', '4.1',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', output
], { stdio: 'inherit' });
if (result.error || result.status !== 0) {
  console.error('Demo generation needs ffmpeg on PATH. You can also put an MP4 in server/media/.');
  process.exit(1);
}
await writeFile(fileURLToPath(new URL('../media/Playback-test.vtt', import.meta.url)),
  'WEBVTT\n\n00:00:00.000 --> 00:00:08.000\nBangumi TV — original-quality playback test\n\n00:00:12.000 --> 00:00:22.000\nTry pause, resume, and seeking with the remote.\n\n00:00:30.000 --> 00:00:40.000\nVideo and audio are being served by your Mac.\n');
console.log('Created a 45-second 1080p H.264/AAC test clip and WebVTT subtitles.');
