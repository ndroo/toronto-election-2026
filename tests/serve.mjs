// Serves the repo as static files for local development and the browser tests: node tests/serve.mjs [port]
// (default 8765, which the results Worker allows as an origin). Same paths as the deployed site.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain', '.gz': 'application/gzip' };

export function serve(port = 8765) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, path.normalize(p));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const port = +process.argv[2] || 8765;
  await serve(port);
  console.log(`http://localhost:${port}/  (?demo, ?replay)`);
}
