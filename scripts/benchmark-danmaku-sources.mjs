// Keep the old command as a fail-closed compatibility stub. No credentials,
// worker imports, upstream search, or comment downloads are permitted here.
console.error('Live danmaku source comparisons are disabled to protect the daily API quota. Use npm test or npm run benchmark:danmaku with offline fixtures.');
process.exitCode = 2;
