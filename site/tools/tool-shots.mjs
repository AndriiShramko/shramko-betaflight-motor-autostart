// Screenshots of the configurator after "connecting" to the emulated board (?mock=1), desktop + phone.
// usage: node tools/tool-shots.mjs [distDir] [outDir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || 'dist');
const out = path.resolve(process.argv[3] || 'docs/wip/shots');
fs.mkdirSync(out, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
const errors = [];
for (const [name, vp, lang] of [['tool-en-1440', { width: 1440, height: 1000 }, 'en'], ['tool-ru-375', { width: 375, height: 812 }, 'ru']]) {
  const page = await browser.newPage({ viewport: vp });
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(name + ' console: ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/${lang}/?mock=1&mockSpeed=4`);
  const btn = page.locator('#tool button').first();
  await btn.click();
  await page.waitForTimeout(2500);
  const read = page.locator('#tool button', { hasText: /read|прочитать|leer|odczytaj/i }).first();
  if (await read.count()) { await read.click(); await page.waitForTimeout(3000); }
  await page.locator('#tool').screenshot({ path: path.join(out, name + '.png') });
  console.log('shot', name);
  await page.close();
}
await browser.close();
server.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('OK, no page errors');
