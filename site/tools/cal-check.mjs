// Calibration from the ESC voltage, against the emulated board with a wrong scale (?mockScale=250, board reads 1.19x high;
// a value the CLI accepts, 10–255) and live ESC telemetry (?mockEsc=bidir: the ESC answers at stop too):
// Motor status must warn (outside every closed area), Change settings must open More settings by itself at the
// calibration box, the box must show the disagreement and one click must propose a scale that brings the board to
// the ESC's value. With a correct scale (negative control) there is no warning and the drawer stays closed. And the
// real-hardware case of 2026-10-20: after a restart MSP keeps the ESC's LAST voltage over the TX wire (14.81 V on a 22.2 V
// pack) until the motor turns — it must never warn, open the drawer or be offered for calibration.
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
const check = (cond, what) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) ok = false; };
const cases = [
  ['250', true, 'mockEsc=bidir&mockScale=250'],
  ['210', false, 'mockEsc=bidir&mockScale=210'],
  // a stale ESC voltage: the TX wire, 14.81 V kept from before, the motor never turns here (a 60 s wait)
  ['stale 14.81 V', false, 'mockEsc=sensor&mockEscVolts=14.81&mockSet=autostart_delay:60']
];
for (const [scale, expectWarn, q] of cases) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/en/?mock=1&mockSpeed=4&${q}`);
  await page.locator('#tool .st-connect .st-primary').click();
  await page.locator('#tool .st-live').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(2500);
  const liveWarn = /the ESC measures/.test(await page.locator('#tool .st-live .st-warns').innerText());
  console.log(`mockScale ${scale}:`);
  check(liveWarn === expectWarn, `Motor status ${expectWarn ? 'warns' : 'does not warn'} about the ESC/board voltage`);
  await page.locator('#tool .st-preread .st-primary').click();
  await page.locator('#tool .st-form').waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(800);
  const more = page.locator('#tool details.st-more');
  const autoOpen = await more.evaluate(d => d.open);
  check(autoOpen === expectWarn, `More settings ${expectWarn ? 'opens by itself' : 'stays closed'}`);
  if (!autoOpen) await more.locator('summary').click();
  const box = page.locator('#tool .st-cal');
  await box.scrollIntoViewIfNeeded();
  const hint = await box.locator('.st-help').nth(1).innerText();
  const warn = await box.locator('.st-help.st-warn').count() > 0;
  console.log(`  "${hint}" warn=${warn}`);
  check(warn === expectWarn, `the calibration box ${expectWarn ? 'shows' : 'does not show'} a disagreement`);
  const escButton = await box.locator('button', { hasText: /ESC/ }).isVisible();
  check(escButton === expectWarn, `"Use the ESC's reading" ${expectWarn ? 'is offered' : 'is not offered'}`);
  if (scale.startsWith('stale')) check(/not fresh yet/.test(hint), 'the box says the ESC voltage is not fresh yet');
  if (expectWarn) {
    await box.locator('button', { hasText: /ESC/ }).click();
    const msg = await box.locator('.st-fnote').innerText();
    console.log('  after click:', msg);
    check(/New scale/.test(msg), 'one click proposes a new scale');
    fs.mkdirSync('docs/wip/shots', { recursive: true });
    await page.screenshot({ path: 'docs/wip/shots/cal-esc.png', clip: await box.boundingBox() });
  }
  await page.close();
}
await browser.close();
server.close();
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
