import { createHmac, timingSafeEqual } from 'node:crypto';
import { validateRemoteURL } from './upstream.mjs';

// Stateless, signed references: a TV cannot turn this into an arbitrary URL proxy.
export function createReferences(secret) {
  function sign(sourceId, payload) {
    return createHmac('sha256', secret).update(sourceId + ':' + payload).digest('base64url');
  }
  return {
    encode(sourceId, url) {
      validateRemoteURL(url);
      const payload = Buffer.from(url).toString('base64url');
      return payload + '.' + sign(sourceId, payload);
    },
    decode(sourceId, token) {
      if (token.length > 16000) throw new Error('Invalid stream reference');
      const [payload, signature, extra] = token.split('.');
      const expected = Buffer.from(sign(sourceId, payload || ''));
      const actual = Buffer.from(signature || '');
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw Object.assign(new Error('Invalid stream reference'), { status: 403 });
      }
      return validateRemoteURL(Buffer.from(payload, 'base64url').toString()).href;
    }
  };
}

export function rewriteManifest(text, baseURL, rewrite) {
  if (!text.replace(/^\uFEFF/, '').startsWith('#EXTM3U')) throw new Error('Source is not an HLS manifest');
  // URI attributes include keys, rendition playlists, init segments and I-frames.
  function replace(uri) {
    if (uri.includes('{$')) throw new Error('HLS variable substitution is not supported by this POC');
    return rewrite(new URL(uri, baseURL).href);
  }
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"\r\n]+)"/g, (_, uri) => `URI="${replace(uri)}"`);
    return replace(line.trim());
  }).join('\n');
}
