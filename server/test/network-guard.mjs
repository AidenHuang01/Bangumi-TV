// Preloaded by npm test. Mock fetchers and ephemeral loopback fixtures work;
// external networks and known production/worker ports are forbidden.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

process.env.BANGUMI_NO_DANMAKU_NETWORK = '1';
const productionPorts = new Set(['8785', '8787', '8790', '8791', '8792', '9321', '9322', '9323']);
function blocked() { return Object.assign(new Error('Tests cannot access external networks or production services.'), { code: 'ERR_TEST_EXTERNAL_NETWORK' }); }
function allow(host = 'localhost', port) {
  const value = String(host).toLowerCase().replace(/^\[|\]$/gu, '');
  if (!['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value) || productionPorts.has(String(port))) throw blocked();
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  allow(url.hostname, url.port || (url.protocol === 'https:' ? '443' : '80'));
  return originalFetch.call(this, input, init);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    if (!first.path) allow(first.host || first.hostname, first.port);
  } else if (typeof first === 'number' || /^\d+$/u.test(String(first))) {
    allow(typeof args[1] === 'string' ? args[1] : 'localhost', first);
  } // A string Unix-socket path is local, not an outgoing network request.
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
