import { networkInterfaces } from 'node:os';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '0.0.0.0';
const app = createApp({ mediaDir: process.env.MEDIA_DIR, sourcesFile: process.env.SOURCES_FILE });
app.on('error', error => { console.error(error.message); process.exitCode = 1; });
app.listen(port, host, () => {
  console.log(`Bangumi TV POC: http://localhost:${port}/`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`TV server address: http://${address.address}:${port}`);
      if (address.family === 'IPv4' && !address.internal) console.log(`Phone controller: http://${address.address}:${port}/remote/`);
    }
  }
  console.log('Keep this Mac awake. Ctrl+C stops the server.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  app.close();
  app.closeAllConnections();
});
