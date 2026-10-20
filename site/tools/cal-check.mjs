// Calibration from the ESC voltage, against the emulated board with a wrong scale (?mockScale=290, board reads 1.38x high):
// the box must show the disagreement, one click must propose a scale that brings the board to the
// ESC's value, and with a correct scale (negative control) the warning must not appear.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve(process.argv[2] || 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f)) { res.writeHead(404); res.end('{}'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
let ok = true;
for (const [scale, expectWarn] of [['290', true], ['210', false]]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/en/?mock=1&mockSpeed=4&mockScale=${scale}`);
  await page.locator('#tool button').first().click();
  await page.waitForTimeout(2500);
  const read = page.locator('#tool button', { hasText: /read/i }).first();
  if (await read.count()) { await read.click(); await page.waitForTimeout(3000); }
  const box = page.locator('.st-cal');
  await box.scrollIntoViewIfNeeded();
  const hint = await box.locator('.st-help').nth(1).innerText();
  const warn = await box.locator('.st-help.st-warn').count() > 0;
  console.log(`mockScale ${scale}: "${hint}" warn=${warn}`);
  if (warn !== expectWarn) ok = false;
  if (expectWarn) {
    await box.locator('button', { hasText: /ESC/ }).click();
    const msg = await box.locator('.st-fnote').innerText();
    console.log('  after click:', msg);
    if (!/New scale/.test(msg)) ok = false;
    await page.screenshot({ path: 'docs/wip/shots/cal-esc.png', clip: await box.boundingBox() });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
