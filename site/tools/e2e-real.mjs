// End-to-end on the REAL board in real Chrome, the way a visitor uses the page:
//   Connect (Chrome's own port picker, answered by tools/pick-serial-port.ps1 through UI Automation)
//   -> board facts -> live view (USB only: waiting for the battery) -> STOP -> Restart program
//   (dialog + checkbox; the board really reboots, the page reconnects) -> Read settings -> change
//   one field of every kind by keyboard and mouse -> Save to board (reboot, reconnect, read back)
//   -> "Saved and verified" -> page shows the new values -> Feedback bug report with diagnostics
//   -> close the browser -> the board's own CLI must hold exactly the new values (independent check).
// Everything the page sends to /api/ carries X-Autostart-Test: 1 (stored as test, never sent to the bot).
// usage (from site/):  node tools/e2e-real.mjs [url] --phase change|restore [--port COM6] [--no-feedback]
//   change : 10 s/15 %/Steady/until battery/3.3 V/motors 1-4  ->  12 s/17 %/Gusts/90 s/3.4 V/motors 1-3
//   restore: the other way round (the values the project ships with)
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const url = args[0] && !args[0].startsWith('--') ? args[0] : 'https://autostart.flyreelstudio.eu/en/';
const phase = opt('--phase', 'change');
const comPort = opt('--port', 'COM6');
const shots = `docs/wip/shots/e2e-${phase}`;
fs.mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const fails = [];
const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) fails.push(what); return ok; };

// board values (CLI) and what the page shows for them
const SHIPPED = { autostart_delay: '10', autostart_throttle: '15', autostart_pattern: 'STEADY', autostart_run_time: '0', autostart_cell_cutoff: '330', autostart_motors: '15' };
const CHANGED = { autostart_delay: '12', autostart_throttle: '17', autostart_pattern: 'GUSTS', autostart_run_time: '90', autostart_cell_cutoff: '340', autostart_motors: '7' };
const [before, after] = phase === 'restore' ? [CHANGED, SHIPPED] : [SHIPPED, CHANGED];
const shown = b => ({
  autostart_delay: b.autostart_delay, autostart_throttle: b.autostart_throttle, autostart_pattern: b.autostart_pattern,
  autostart_run_time: b.autostart_run_time === '0' ? 'zero' : b.autostart_run_time,
  autostart_cell_cutoff: String(Number(b.autostart_cell_cutoff) / 100), autostart_motors: b.autostart_motors,  // the page shows 3.3, not 3.30
});

const ctx = await chromium.launchPersistentContext('C:/dev/_e2e-chrome-profile', {
  channel: 'chrome', headless: false, viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', e => log('PAGEERROR', e.message));
page.on('console', m => { if (m.type() === 'error') log('CONSOLE', m.text()); });
await page.route('**/api/**', r => r.continue({ headers: { ...r.request().headers(), 'x-autostart-test': '1' } }));
const apiAnswers = [];
page.on('response', async r => { if (r.url().includes('/api/report')) apiAnswers.push(await r.json().catch(() => ({}))); });

await page.goto(url, { waitUntil: 'networkidle' });
const tool = page.locator('#tool');
await tool.scrollIntoViewIfNeeded();
let n = 0;
// the whole configurator (connect card, live view, settings), not just the viewport
const shot = async name => { await tool.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png` }); };
const text = async () => (await tool.innerText()).replace(/\s+/g, ' ');
const waitText = async (rx, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (rx.test(await text())) return check(true, what); await page.waitForTimeout(300); }
  log('  page says:', (await text()).slice(0, 600));
  return check(false, what);
};
const btn = name => tool.locator('button', { hasText: name }).first();
const field = name => tool.locator(`.st-field[data-name="${name}"]`);

// 1. connect through Chrome's own picker
const picker = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/pick-serial-port.ps1', '-Match', 'STM32|Betaflight', '-TimeoutSec', '30']);
picker.stdout.on('data', d => String(d).trim().split('\n').forEach(l => log(l.trim())));
await btn(/^Connect$/).click();
if (!await waitText(/Connected\./, 40000, 'connected through the port picker')) { await shot('connect-failed'); await ctx.close(); process.exit(1); }
await page.waitForTimeout(2500);
const facts = await text();
check(/F405|HGLRC|STM32/i.test(facts), 'board facts name the board');
log('  facts:', facts.slice(0, 500));
await shot('connected');

// 2. live view on USB only
await waitText(/Waiting for the battery/, 15000, 'live view: waiting for the battery (USB only)');
check(/No battery \(USB power only\)/.test(await text()), 'live view: no battery on USB power');
await shot('live-usb');

// 3. STOP, then Restart program (real reboot, page reconnects by itself)
await btn(/STOP motor/).click();
await waitText(/Stop sent|already stopped/, 8000, 'STOP acknowledged');
await waitText(/Program stopped/, 10000, 'live view: program stopped after STOP');
await shot('stopped');
await btn(/Restart program/).click();
const dlg = page.locator('dialog[open]');
check(await dlg.count() === 1, 'restart asks for confirmation');
const confirm = dlg.locator('button', { hasText: /Restart now/ });
check(await confirm.isDisabled(), 'Restart now is blocked until the safety box is ticked');
await dlg.locator('input[type=checkbox]').check();
await confirm.click();
await waitText(/Board restarted/, 40000, 'board restarted and page reconnected');
await waitText(/Waiting for the battery/, 20000, 'program running again from the start');
await shot('restarted');

// 4. read settings and compare with what the board holds
await btn(/^Read settings$|^Read again$/).click();
await waitText(/Settings read from the board/, 30000, 'settings read');
check(!/running from the start/.test(await tool.locator('.st-live').innerText()), 'no stale "program running" message once the read holds the program');
const value = async name => {
  const f = field(name);
  const num = f.locator('input.st-num');
  if (await num.count()) return (await num.isDisabled()) ? 'zero' : (await num.inputValue()).trim();
  const r = f.locator('input[type=radio]:checked');
  if (await r.count()) return r.getAttribute('value');
  const boxes = await f.locator('input[type=checkbox]').evaluateAll(bs => bs.map(b => b.checked));
  return String(boxes.reduce((m, c, i) => (c ? m | (1 << i) : m), 0));
};
for (const [k, v] of Object.entries(shown(before))) check((await value(k)) === v, `page shows ${k} = ${v} (got ${await value(k)})`);
await shot('read');

// 5. change one field of every kind like a person does
const typeNum = async (name, v) => {
  const i = field(name).locator('input.st-num');
  await i.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(v, { delay: 40 });
  await page.keyboard.press('Tab');
};
const want = shown(after);
await typeNum('autostart_delay', want.autostart_delay);
await typeNum('autostart_throttle', want.autostart_throttle);
await field('autostart_pattern').locator('label', { hasText: want.autostart_pattern === 'GUSTS' ? 'Gusts' : 'Steady' }).click();
const zero = field('autostart_run_time').locator('input[type=checkbox]');
if (want.autostart_run_time === 'zero') { if (!await zero.isChecked()) await field('autostart_run_time').locator('label.st-check').click(); }
else { if (await zero.isChecked()) await field('autostart_run_time').locator('label.st-check').click(); await typeNum('autostart_run_time', want.autostart_run_time); }
await typeNum('autostart_cell_cutoff', want.autostart_cell_cutoff);
const m4 = field('autostart_motors').locator('input[type=checkbox]').nth(3);
if ((await m4.isChecked()) !== (want.autostart_motors === '15')) await field('autostart_motors').locator('label.st-check-inline').nth(3).click();
for (const [k, v] of Object.entries(want)) check((await value(k)) === v, `typed ${k} = ${v} (shows ${await value(k)})`);
check(await tool.locator('.st-field.st-changed').count() === 6, `6 fields marked as changed (${await tool.locator('.st-field.st-changed').count()})`);
await shot('edited');

// 6. save: write, save, reboot, reconnect, read back
check(await btn(/Save to board/).isEnabled(), 'Save to board enabled');
await btn(/Save to board/).click();
await waitText(/Saved and verified: \d+ values/, 90000, 'Saved and verified');
log('  saved:', ((await text()).match(/Saved and verified: \d+ values\./) || [''])[0]);
for (const [k, v] of Object.entries(want)) check((await value(k)) === v, `after save the page shows ${k} = ${v}`);
check(await tool.locator('.st-field.st-changed').count() === 0, 'nothing left marked as changed');
await shot('saved');

// 7. feedback: a bug report with diagnostics (marked as a test run)
if (!args.includes('--no-feedback')) {
  await page.locator('#fb-open').click();
  const fb = page.locator('#fb');
  await fb.locator('input[value=bug]').check();
  await fb.locator('textarea[name=message]').fill(`[E2E ${phase}] agent acceptance run on the real board, ignore`);
  check(await fb.locator('input[name=diag]').isChecked(), 'diagnostics box ticked by default');
  await fb.locator('#fb-send').click();
  const end = Date.now() + 15000;
  let said = '';
  while (Date.now() < end && !/report number|didn't work/.test(said)) { said = await fb.innerText(); await page.waitForTimeout(300); }
  const id = (said.match(/R-\d{8}-\d{4}/) || [''])[0];
  check(!!id, `feedback shows its number (${id})`);
  const a = apiAnswers.at(-1) || {};
  check(a.test === true && a.diagnostics === true, `stored as a test with diagnostics (${JSON.stringify(a)})`);
  await shot('feedback');
  fs.writeFileSync(`${shots}/report-id.txt`, id);
}
await ctx.close();
picker.kill();

// 8. independent check: the board's own CLI, browser closed
await new Promise(r => setTimeout(r, 1500));
const cli = spawnSync('python', ['../tools/bf_cli.py', comPort, 'get autostart', 'exit'], { encoding: 'utf8', timeout: 60000 });
const board = Object.fromEntries([...cli.stdout.matchAll(/^(autostart_\w+) = (\S+)/gm)].map(m => [m[1], m[2]]));
for (const [k, v] of Object.entries(after)) check(board[k] === v, `board CLI: ${k} = ${v} (has ${board[k]})`);
fs.writeFileSync(`${shots}/board-after.txt`, cli.stdout);
log(fails.length ? `FAIL ${fails.length}: ${fails.join(' | ')}` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
