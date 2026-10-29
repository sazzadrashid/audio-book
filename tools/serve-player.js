// A small web server for opening the player on this computer: node tools/serve-player.js [port]
// It answers range requests, which audio seeking needs (python -m http.server doesn't).
// Extra folders can be served under a path, e.g. --mount /test=C:\some\folder (used for testing).
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const port = Number(args.find(a => /^\d+$/.test(a)) || 8766);
const mounts = [['/', path.resolve(__dirname, '..', 'player')]];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mount') {
    const [prefix, folder] = args[++i].split(/=(.*)/s);
    mounts.unshift([prefix.replace(/\/?$/, '/'), path.resolve(folder)]);
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.data': 'application/octet-stream',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

function resolve(urlPath) {
  for (const [prefix, folder] of mounts) {
    if (urlPath === prefix.slice(0, -1) || urlPath.startsWith(prefix)) {
      const file = path.join(folder, decodeURIComponent(urlPath.slice(prefix.length)));
      return file.startsWith(folder) ? file : null; // no ../ tricks
    }
  }
  return null;
}

http.createServer((req, res) => {
  let file = resolve(new URL(req.url, 'http://x').pathname);
  try {
    if (file && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch {
    file = null;
  }
  if (!file || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  const size = fs.statSync(file).size;
  const headers = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`The Audio Book player is at http://localhost:${port}/ (only this computer can see it).`);
  console.log('Keep this window open while you use it. Close it to stop.');
});
