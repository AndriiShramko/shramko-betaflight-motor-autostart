// End-to-end on the REAL board in real Chrome, the way a visitor uses the page:
//   Connect (Chrome's own port picker, answered by tools/pick-serial-port.ps1 through UI Automation)
//   -> connection line -> Motor status (USB only: waiting for the battery) -> STOP -> Run the program…
//   (dialog + checkbox; the board really reboots, the page reconnects) -> Change settings -> change
//   one setting of every kind by keyboard and mouse (quick picks, Other, minutes + seconds, the
//   More settings drawer) -> Save to board (reboot, reconnect, read back) -> "Saved and checked"
//   -> page shows the new values -> Feedback bug report with diagnostics -> close the browser
//   -> the board's own CLI must hold exactly the new values (independent check).
// Everything the page sends to /api/ carries X-Autostart-Test: 1 (stored as test, never sent to the bot).
// usage (from site/):  node tools/e2e-real.mjs [url] --phase change|restore [--port COM6] [--no-feedback] [--battery-connected]
//   change : 10 s/15 %/Steady/until battery/3.3 V/motors 1-4  ->  12 s/17 %/Gusts/90 s/3.4 V/motors 1-3
//   restore: the other way round (the values the project ships with)
//
// !!! UNPLUG THE BATTERY FIRST and take the propeller off. The run expects USB power only: it ticks the
// propeller box itself and presses Run now, and with a battery attached the motor really spins (change
// phase: 12 s wait, 17 %, gusts 40–80 % for 90 s). Without --battery-connected it aborts (after a STOP)
// as soon as the Battery meter shows a voltage. With --battery-connected (propeller off!) it presses STOP
// right after every restart and expects the countdown instead of "Waiting for the battery".
// The final CLI check leaves with "exit noreboot": the board stays held (motor stopped) until it is switched
// off and on — a plain "exit" would reboot it and, with a battery attached, run the program unattended.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const url = args[0] && !args[0].startsWith('--') ? args[0] : 'https://autostart.flyreelstudio.eu/en/';
const phase = opt('--phase', 'change');
const comPort = opt('--port', 'COM6');
const batteryConnected = args.includes('--battery-connected');
const shots = `docs/wip/shots/e2e-${phase}`;
fs.mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`, ...a);
const fails = [];
const check = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) fails.push(what); return ok; };

// board values (CLI); the form holds the same raw values in data-value
const SHIPPED = { autostart_delay: '10', autostart_throttle: '15', autostart_pattern: 'STEADY', autostart_run_time: '0', autostart_cell_cutoff: '330', autostart_motors: '15' };
const CHANGED = { autostart_delay: '12', autostart_throttle: '17', autostart_pattern: 'GUSTS', autostart_run_time: '90', autostart_cell_cutoff: '340', autostart_motors: '7' };
const [before, after] = phase === 'restore' ? [CHANGED, SHIPPED] : [SHIPPED, CHANGED];

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
// the whole configurator (connect card, motor status, settings), not just the viewport
const shot = async name => { await tool.screenshot({ path: `${shots}/${String(++n).padStart(2, '0')}-${name}.png` }); };
const text = async () => (await tool.innerText()).replace(/\s+/g, ' ');
const waitText = async (rx, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (rx.test(await text())) return check(true, what); await page.waitForTimeout(300); }
  log('  page says:', (await text()).slice(0, 600));
  return check(false, what);
};
const btn = name => tool.locator('button', { hasText: name }).first();
// every setting's place in the form carries data-name and data-value (the raw CLI value the form holds)
const field = name => tool.locator(`[data-name="${name}"]`);

// 1. connect through Chrome's own picker
const picker = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'tools/pick-serial-port.ps1', '-Match', 'STM32|Betaflight', '-TimeoutSec', '30']);
picker.stdout.on('data', d => String(d).trim().split('\n').forEach(l => log(l.trim())));
await btn(/^Connect$/).click();
if (!await waitText(/Connected: /, 40000, 'connected through the port picker')) { await shot('connect-failed'); await ctx.close(); process.exit(1); }
await page.waitForTimeout(2500);
const facts = await text();
check(/F405|HGLRC|STM32/i.test(facts), 'the connection line names the board');
check(/Shramko Autostart/.test(facts), 'the connection line says the module is there');
log('  page:', facts.slice(0, 500));
await shot('connected');

// 2. motor status: USB power only, unless the owner said the battery is connected (then the motor can spin)
const battery = (await tool.locator('.st-live .st-meter').nth(1).innerText()).replace(/\s+/g, ' ');
const usbOnly = /No battery \(USB power only\)/.test(battery);
log('  battery meter:', battery);
if (!usbOnly && !batteryConnected) {
  // a battery is attached: stop whatever runs and leave before anything can start the motor
  await btn(/STOP motor/).click().catch(() => undefined);
  await page.waitForTimeout(1500);
  await shot('aborted-battery');
  log('ABORT: the Battery meter shows a voltage. Unplug the battery (USB power only) and run again,');
  log('       or pass --battery-connected with the propeller off. The board was sent STOP; switch it off and on to run its program.');
  await ctx.close();
  picker.kill();
  process.exit(2);
}
if (usbOnly) {
  // "Held by the computer": still held by the previous run's CLI check (this page session did not cause it, so
  // it is not "Stopped with STOP"); step 3 restarts it
  await waitText(/Waiting for the battery|Stopped with STOP|Held by the computer/, 15000, 'Motor status: waiting for the battery, or held since the last run (USB only)');
  check(true, 'Motor status: no battery on USB power');
} else check(/\d[.,]\d+ V/.test(battery), 'Motor status: the battery voltage is shown (--battery-connected)');
await shot('live-usb');

// after a restart with a battery attached the program counts down for real: STOP it at once
const stopIfBattery = async (what) => {
  if (usbOnly) return;
  await btn(/STOP motor/).click();
  await waitText(/Stopped with STOP/, 10000, `Motor status: stopped with STOP after ${what}`);
};

// 3. STOP, then Run the program (real reboot, page reconnects by itself)
await btn(/STOP motor/).click();
// the page checks the next samples: "stays stopped until Run" once the board says it holds (bit 64)
await waitText(/Stopped\. It stays stopped|already stopped|does not hold the program/, 8000, 'STOP acknowledged');
await waitText(/Stopped with STOP/, 10000, 'Motor status: stopped with STOP');
await shot('stopped');
await btn(/Run the program/).click();
const dlg = page.locator('dialog[open]');
check(await dlg.count() === 1, 'Run asks for confirmation');
check(await dlg.locator('button', { hasText: /STOP motor/ }).isVisible(), 'the Run dialog carries its own STOP');
const confirm = dlg.locator('button', { hasText: /^Run now$/ });
check(await confirm.isDisabled(), 'Run now is blocked until the safety box is ticked');
await dlg.locator('input[type=checkbox]').check();
await confirm.click();
await waitText(/Board restarted/, 40000, 'board restarted and page reconnected');
if (usbOnly) await waitText(/Waiting for the battery/, 20000, 'program running again from the start');
else {
  await waitText(/Waiting|Starts in|Speeding up|Running/, 20000, 'program running again from the start (battery attached)');
  await stopIfBattery('Run now');
}
await shot('restarted');

// 4. open the settings and compare with what the board holds
await btn(/^Change settings$|^Reload from the board$/).click();
check(await tool.locator('.st-form').waitFor({ state: 'visible', timeout: 30000 }).then(() => true, () => false), 'settings read');
check(!/running from the start/.test(await tool.locator('.st-live').innerText()), 'no stale "program running" message once the read holds the program');
const value = name => field(name).getAttribute('data-value');
for (const [k, v] of Object.entries(before)) check((await value(k)) === v, `page holds ${k} = ${v} (got ${await value(k)})`);
check(new RegExp(`${before.autostart_delay} s after the battery is plugged in`).test(await tool.locator('.st-form > .st-program').innerText()), 'the program in words shows the board\'s wait');
await shot('read');

// 5. change one setting of every kind like a person does
const typeInto = async (input, v) => {
  await input.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(v, { delay: 40 });
  await page.keyboard.press('Tab');
};
// a quick pick when there is one with this value, else "Other" and type it
const pick = async (name, v, chipText) => {
  const chip = field(name).locator('label.st-chip', { hasText: new RegExp(`^${chipText}$`) });
  if (await chip.count()) return chip.click();
  await field(name).locator('label.st-chip', { hasText: /^Other$/ }).click();
  await typeInto(field(name).locator('.st-other input.st-num'), v);
};
const want = after;
await pick('autostart_delay', want.autostart_delay, `${want.autostart_delay} s`);
await pick('autostart_throttle', want.autostart_throttle, `${want.autostart_throttle} %`);
await field('autostart_pattern').locator('label.st-chip', { hasText: want.autostart_pattern === 'GUSTS' ? /^On$/ : /^Off$/ }).click();
if (want.autostart_run_time === '0') await field('autostart_run_time').locator('label.st-chip', { hasText: 'Until the battery is low' }).click();
else {
  await field('autostart_run_time').locator('label.st-chip', { hasText: 'For a set time' }).click();
  const t = Number(want.autostart_run_time);
  await typeInto(field('autostart_run_time').locator('input.st-num').nth(0), String(Math.floor(t / 60)));
  await typeInto(field('autostart_run_time').locator('input.st-num').nth(1), String(t % 60));
}
// the rest lives in More settings
const more = tool.locator('details.st-more');
if (!(await more.evaluate(d => d.open))) await more.locator('summary').click();
await typeInto(field('autostart_cell_cutoff').locator('input.st-num'), String(Number(want.autostart_cell_cutoff) / 100)); // typed as 3.4, not 3.40
const m4 = field('autostart_motors').locator('input[type=checkbox]').nth(3);
if ((await m4.isChecked()) !== (want.autostart_motors === '15')) await field('autostart_motors').locator('label.st-check-inline').nth(3).click();
for (const [k, v] of Object.entries(want)) check((await value(k)) === v, `typed ${k} = ${v} (holds ${await value(k)})`);
const marked = await tool.locator('.st-field.st-changed, .st-q.st-changed').count();
check(marked === 6, `6 settings marked as changed (${marked})`);
check(/Will save:/.test(await tool.locator('.st-changes').innerText()), 'the change list names what Save will write');
await shot('edited');

// 6. save: write, save, reboot, reconnect, read back
check(await btn(/Save to board/).isEnabled(), 'Save to board enabled');
await btn(/Save to board/).click();
await waitText(/Saved and checked on the board: \d+ values/, 90000, 'Saved and checked on the board');
log('  saved:', ((await text()).match(/Saved and checked on the board: \d+ values\./) || [''])[0]);
for (const [k, v] of Object.entries(want)) check((await value(k)) === v, `after save the page holds ${k} = ${v}`);
check(await tool.locator('.st-field.st-changed, .st-q.st-changed').count() === 0, 'nothing left marked as changed');
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

// 8. independent check: the board's own CLI, browser closed. "exit noreboot", never a plain "exit": a reboot
// clears the hold and, with a battery attached, starts the program with no page and no STOP on screen
await new Promise(r => setTimeout(r, 1500));
const cli = spawnSync('python', ['../tools/bf_cli.py', comPort, 'get autostart', 'exit noreboot'], { encoding: 'utf8', timeout: 60000 });
const board = Object.fromEntries([...cli.stdout.matchAll(/^(autostart_\w+) = (\S+)/gm)].map(m => [m[1], m[2]]));
for (const [k, v] of Object.entries(after)) check(board[k] === v, `board CLI: ${k} = ${v} (has ${board[k]})`);
fs.writeFileSync(`${shots}/board-after.txt`, cli.stdout);
log('The board is held (motor stopped). To run the saved program: unplug USB and the battery, then plug in the battery.');
log(fails.length ? `FAIL ${fails.length}: ${fails.join(' | ')}` : 'ALL PASS');
process.exit(fails.length ? 1 : 0);
