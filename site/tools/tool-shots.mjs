// Screenshots of the configurator against the emulated board (?mock=1), en + ru at 1440 and 375 px:
// before Connect, connected (Motor status + Step 3 before reading), after Change settings, with More settings
// open, and the window itself (the fixed STOP bar). Fails on page errors or a horizontal scroll.
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
const query = process.env.SHOTS_QUERY || 'mock=1&mockSpeed=4';
// every state the fixed STOP bar can show, per language: at 375 px only the words may be cut, never the Power %
const BAR_KEYS = ['tool.state.0', 'tool.state.1', 'tool.state.2', 'tool.state.3', 'tool.state.4', 'tool.state.5', 'tool.state.unknown', 'tool.live.waitBattery', 'tool.live.waitButton', 'tool.live.paused', 'tool.live.stopped', 'tool.live.held', 'tool.status.connecting', 'tool.live.off', 'tool.live.usbHeld', 'tool.live.manual', 'tool.live.noAnswer'];
const toolStrings = lang => JSON.parse(fs.readFileSync(path.resolve('web/src/i18n', `tool.${lang}.json`), 'utf8'));
const barCheck = async (page, name, lang) => {
  const words = BAR_KEYS.map(k => toolStrings(lang)[k]);
  // set each text in one synchronous step (the live view rewrites the bar 5 times a second), measure, restore
  const bad = await page.evaluate(list => {
    const text = document.querySelector('#tool .st-stoptext');
    const pct = document.querySelector('#tool .st-stoppct');
    const bar = document.querySelector('#tool .st-stopbar');
    if (!text || !pct || !bar || bar.hidden) return ['no STOP bar'];
    const keep = [text.textContent, pct.textContent];
    const out = [];
    for (const w of list) {
      text.textContent = w;
      pct.textContent = ' · 100 %';
      const p = pct.getBoundingClientRect();
      const s = pct.parentElement.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      if (p.width < 10 || pct.scrollWidth > pct.clientWidth + 1 || p.right > s.right + 0.5 || b.right > innerWidth + 0.5) out.push(`"${w}" → % ${Math.round(p.left)}–${Math.round(p.right)}, box ends ${Math.round(s.right)}`);
    }
    [text.textContent, pct.textContent] = keep;
    return out;
  }, words);
  if (bad.length) errors.push(`${name}: STOP bar cuts the Power %: ${bad.join('; ')}`);
};
for (const lang of ['en', 'ru']) {
  for (const vp of [{ width: 1440, height: 1000 }, { width: 375, height: 812 }]) {
    const name = `tool-${lang}-${vp.width}`;
    const page = await browser.newPage({ viewport: vp });
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(name + ' console: ' + m.text()); });
    await page.goto(`http://127.0.0.1:${port}/${lang}/?${query}`);
    const tool = page.locator('#tool');
    const shot = async step => { await tool.screenshot({ path: path.join(out, `${name}-${step}.png`) }); console.log('shot', `${name}-${step}`); };
    const wide = async step => {
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      if (w > vp.width) errors.push(`${name} ${step}: page is ${w}px wide (viewport ${vp.width})`);
    };
    await page.locator('#tool .st-connect .st-primary').waitFor();
    await shot('1-start');
    await page.locator('#tool .st-connect .st-primary').click();
    await page.locator('#tool .st-live').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(1500);
    await shot('2-connected');
    await wide('connected');
    await barCheck(page, name, lang);
    await page.locator('#tool .st-preread .st-primary').click();
    await page.locator('#tool .st-form').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(800);
    await shot('3-settings');
    await wide('settings');
    const more = page.locator('#tool .st-more');
    if (!(await more.evaluate(d => d.open))) await more.locator('summary').click();
    await page.waitForTimeout(300);
    await shot('4-more');
    await wide('more');
    // the window itself: the fixed STOP bar over Step 3
    await page.locator('#tool .st-settings').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `${name}-5-window.png`) });
    console.log('shot', `${name}-5-window`);
    await page.close();
  }
}
// es and pl (the longest words): the STOP bar at 375 px only, no screenshots
for (const lang of ['es', 'pl']) {
  const name = `tool-${lang}-375`;
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/${lang}/?${query}`);
  await page.locator('#tool .st-connect .st-primary').click();
  await page.locator('#tool .st-live').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(800);
  await barCheck(page, name, lang);
  console.log('bar check', name);
  await page.close();
}
await browser.close();
server.close();
if (errors.length) { console.log('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('OK, no page errors, no horizontal scroll');
