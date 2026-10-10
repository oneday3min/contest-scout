// Contest Scout — finds, reads and ranks contests/hackathons for a small creator team.
// Zero dependencies: Node 18+ (built-in fetch). Run: node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { analyze, discover, pickModels, status, models } = require('./lib/core');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, 'public');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 400_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/status') return send(res, 200, status());
    if (req.method === 'POST' && pathname === '/api/analyze') {
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
      return send(res, 200, await analyze(await readBody(req), ip));
    }
    if (req.method === 'POST' && pathname === '/api/discover') {
      const body = await readBody(req);
      return send(res, 200, await discover({ query: body.query }));
    }
    if (req.method === 'GET') {
      const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
    }
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

pickModels().then(() => {
  server.listen(PORT, () => {
    const s = status();
    console.log(`Contest Scout on http://localhost:${PORT}  (mode: ${s.mode}, fast=${models.fast || '-'}, reason=${models.reason || '-'})`);
  });
});
