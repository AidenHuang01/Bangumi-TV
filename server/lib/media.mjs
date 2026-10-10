import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export const mimeTypes = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.vtt': 'text/vtt; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
};

// A single byte range is enough for AVPlay/HTML5 seeking. Reject multipart ranges.
export function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start >= size || start > end) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export async function serveFile(req, res, file, contentType) {
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error('File not found'), { status: 404 });
  const range = parseRange(req.headers.range, info.size);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType || 'application/octet-stream');
  if (range === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
    return res.end();
  }
  if (range) {
    res.writeHead(206, {
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': range.end - range.start + 1
    });
  } else res.writeHead(200, { 'Content-Length': info.size });
  if (req.method === 'HEAD' || info.size === 0) return res.end();
  try {
    await pipeline(createReadStream(file, range || {}), res);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
}
