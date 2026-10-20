// Browser test of the tool UI against the emulated board (?mock=1), in real Chrome via Playwright.
// The first-timer path (zero clicks for the default), the quick picks, the drawer and its auto-open rules,
// STOP over every modal, plus the negative controls: the board refuses a value; the board never comes back;
// all defaults keep the drawer closed; gusts and the mix never touch Power / Maximum power / How long.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';

const siteDir = fileURLToPath(new URL('..', import.meta.url));
let server: ViteDevServer;
let browser: Browser;
let base = '';

before(async () => {
    server = await createServer({
        root: fileURLToPath(new URL('./harness/', import.meta.url)),
        configFile: false,
        logLevel: 'error',
        server: { port: 0, strictPort: false, fs: { allow: [siteDir] } },
        optimizeDeps: { noDiscovery: true, include: [] }
    });
    await server.listen();
    const addr = server.httpServer!.address();
    base = `http://localhost:${typeof addr === 'object' && addr ? addr.port : 5199}/`;
    try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
    } catch {
        browser = await chromium.launch({ headless: true });
    }
});

after(async () => {
    await browser?.close();
    await server?.close();
});

const open = async (query: string, viewport = { width: 1280, height: 900 }, init?: () => void) => {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text());
    });
    if (init) await page.addInitScript(init);
    await page.goto(`${base}?${query}`);
    await page.locator('.st-connect .st-primary').waitFor();
    return { page, errors };
};

const connect = async (page: Page) => {
    await page.locator('.st-connect .st-primary').click();
    await page.locator('.st-conn').waitFor({ state: 'visible', timeout: 10000 });
};
const openSettings = async (page: Page) => {
    await page.locator('.st-preread .st-primary').click();
    await page.locator('.st-form').waitFor({ state: 'visible', timeout: 15000 });
};
const connectAndRead = async (page: Page) => {
    await connect(page);
    await openSettings(page);
};
const value = (page: Page, name: string) => page.locator(`.st [data-name="${name}"]`).getAttribute('data-value');
const question = (page: Page, name: string) => page.locator(`.st-q[data-name="${name}"]`);
const moreOpen = (page: Page) => page.locator('details.st-more').evaluate(d => (d as HTMLDetailsElement).open);
const openMore = async (page: Page) => {
    if (!(await moreOpen(page))) await page.locator('details.st-more > summary').click();
};
const changeKeys = (page: Page) => page.locator('.st-changes [data-change]').evaluateAll(els => els.map(e => e.getAttribute('data-change')));

test('zero-click default path: connect shows the factory program and "you are done"; opening the settings changes nothing', async () => {
    const { page, errors } = await open('mock=1&mockReboot=300');
    await connect(page);
    assert.match(await page.locator('.st-conn').innerText(), /Connected: HGLRC_F405_S8 · Shramko Autostart/);
    assert.ok(await page.getByRole('button', { name: 'STOP motor' }).isVisible());
    assert.ok(!(await page.locator('.st-facts').isVisible()), 'board details are folded');
    const pre = await page.locator('.st-preread').innerText();
    assert.match(pre, /Fresh firmware does this \(factory settings — this board may differ\)/);
    assert.match(pre, /10 s after the battery is plugged in/);
    assert.match(pre, /Until the battery stays below 19\.8 V \(6 × 3\.30 V\) for 5 s/);
    assert.match(pre, /If that suits you, you are done: unplug USB and the battery, then plug in the battery\./);
    assert.match(pre, /Boards flashed with version 1\.0 have no battery stop/, 'firmware 1.0 named before the level is known');
    await page.locator('.st-live').getByText(/Betaflight guesses 6S · stop voltage unknown until you open the settings/).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.st-connect').getByText('Not connected.').count(), 0);
    assert.equal(await page.locator('.st-connect').getByText(/Your browser can talk/).count(), 0);

    await openSettings(page);
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('st-program')), 'focus moves to the program');
    assert.match(await page.locator('.st-form > .st-program').innerText(), /What the board will do/);
    assert.ok(await page.getByRole('button', { name: 'Save to board' }).isDisabled());
    assert.match(await page.locator('.st-changes').innerText(), /Nothing changed\. The board is ready/);
    assert.equal(await moreOpen(page), false, 'More settings stays closed for a board at the defaults');
    await page.locator('.st-live').getByText(/6S · stops at 19\.8 V/).waitFor({ timeout: 5000 });
    assert.match(await page.locator('.st-state').innerText(), /Paused while settings are open/);
    assert.match((await page.locator('.st-stopstate').textContent()) ?? '', /Paused while settings are open\s*· 0 %/);
    // K3: the state words and the Power % are separate flex items: a visible gap between them, never "open· 0 %"
    const gap = await page.evaluate(() => document.querySelector('.st-stoppct')!.getBoundingClientRect().left - document.querySelector('.st-stoptext')!.getBoundingClientRect().right);
    assert.ok(gap >= 3, `gap ${gap}px`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('quick picks + Other, the "Will save" list, save → "Saved and checked", focus on the result', async () => {
    const { page, errors } = await open('mock=1&mockReboot=300');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('5 s', { exact: true }).click();
    await question(page, 'autostart_throttle').getByText('Other', { exact: true }).click();
    const other = page.getByLabel('Power, percent', { exact: true });
    assert.ok(await other.evaluate(e => e === document.activeElement), 'a click on Other puts the cursor in the box');
    // typed, not fill(): the old value is selected, so "22" replaces 15 (it once became 1522 → 100 %)
    await page.keyboard.type('22');
    await page.keyboard.press('Tab');
    assert.equal(await value(page, 'autostart_throttle'), '22', 'typing after a click on Other replaces the value');
    await question(page, 'autostart_pattern').getByText('On', { exact: true }).click();
    assert.match(await page.locator('.st-changes').innerText(), /Will save: Wait before start: 10 s → 5 s · Power: 15 % → 22 % · Random gusts: Off → On/);
    const prog = await page.locator('.st-form > .st-program').innerText();
    assert.match(prog, /What the board will do after saving/);
    assert.match(prog, /5 s after the battery is plugged in/);
    assert.match(prog, /Speeds up over 10 s to 22 %, then random gusts of 40–80 %/);
    assert.match(await question(page, 'autostart_pattern').innerText(), /About 20 % power between gusts works well/);
    // the unit stays on the row of its box (beats the page's input[type=text] { display: block })
    const [box, unit] = await Promise.all([other.boundingBox(), question(page, 'autostart_throttle').locator('.st-other .st-unit').boundingBox()]);
    assert.ok(box && unit && Math.abs(box.y + box.height / 2 - (unit.y + unit.height / 2)) < 6, 'unit on the same row');

    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    assert.match(await page.locator('.st-msg[data-result="saved"]').innerText(), /Saved and checked on the board: 3 values\. The motor stays stopped until you press Run now/);
    assert.ok(await page.evaluate(() => document.activeElement?.getAttribute('data-result') === 'saved'), 'focus on the result');
    assert.deepEqual([await value(page, 'autostart_delay'), await value(page, 'autostart_throttle'), await value(page, 'autostart_pattern')], ['5', '22', 'GUSTS']);
    assert.ok(await page.getByRole('button', { name: 'Save to board' }).isDisabled());
    assert.ok(await page.locator('.st-msg[data-result="saved"]').getByRole('button', { name: 'Run now…' }).isVisible());
    assert.deepEqual(errors, []);
    await page.close();
});

test('a board value that matches no chip preselects Other with the exact value (45 s, 22 %, 5S); the cell check suggests, never changes', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockSet=autostart_delay:45,autostart_throttle:22,autostart_cells:5');
    await connectAndRead(page);
    for (const [name, label, v] of [['autostart_delay', 'Wait before start, seconds', '45'], ['autostart_throttle', 'Power, percent', '22'], ['autostart_cells', 'Battery, cells', '5']]) {
        assert.equal(await question(page, name).locator('input[type=radio]:checked').getAttribute('value'), 'other', `${name}: Other selected`);
        assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), v, `${name} shows ${v}`);
    }
    const battery = question(page, 'autostart_cells');
    await battery.getByText(/24\.4 V doesn’t fit 5S\. Is it 6S\?/).waitFor({ timeout: 5000 });
    assert.equal(await value(page, 'autostart_cells'), '5', 'only a suggestion');
    // a keyboard user hears the protection line and the fit check with the choice (only the lines shown now)
    const desc = await battery.locator('input[value="other"]').evaluate(r => (r.getAttribute('aria-describedby') ?? '').split(' ').map(id => document.getElementById(id)?.textContent ?? '').join(' | '));
    assert.match(desc, /Protected: stops at/);
    assert.match(desc, /24\.4 V doesn’t fit 5S/);
    assert.doesNotMatch(desc, /Cells counted automatically/, 'a hidden line is not named');
    await battery.getByRole('button', { name: 'Use 6S' }).click();
    assert.equal(await value(page, 'autostart_cells'), '6');
    assert.equal(await battery.locator('input[type=radio]:checked').getAttribute('value'), '6');
    await battery.getByText('24.4 V fits 6S').waitFor();
    await page.close();
});

test('negative control: gusts On and the suggested mix keep Power 30, Maximum power 40 and How long 2 min', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockSet=autostart_throttle:30,autostart_throttle_limit:40,autostart_run_time:120');
    await connectAndRead(page);
    assert.equal(await moreOpen(page), false, 'a cap is a badge, not a reason to open');
    assert.match(await page.locator('details.st-more > summary').innerText(), /Maximum power 40 %/);
    assert.equal(await question(page, 'autostart_throttle').locator('input[type=radio]:checked').getAttribute('value'), '30');
    assert.equal(await page.getByLabel('How long, minutes', { exact: true }).inputValue(), '2');
    assert.equal(await page.getByLabel('How long, seconds', { exact: true }).inputValue(), '0');
    await question(page, 'autostart_pattern').getByText('On', { exact: true }).click();
    assert.deepEqual(await changeKeys(page), ['autostart_pattern'], 'the switch changes one value');
    await openMore(page);
    await page.getByRole('button', { name: 'Use the suggested gust mix' }).click();
    assert.match(await page.locator('.st-changes').innerText(), /and 4 more/);
    assert.deepEqual([await value(page, 'autostart_throttle'), await value(page, 'autostart_throttle_limit'), await value(page, 'autostart_run_time')], ['30', '40', '120']);
    assert.deepEqual([await value(page, 'autostart_gust_min'), await value(page, 'autostart_gust_max'), await value(page, 'autostart_gust_len_min')], ['50', '90', '200']);
    // number boxes are named with their unit (the visible unit is a symbol)
    for (const n of ['Shortest gust, seconds', 'Strongest gust, percent', 'Longest pause, seconds', 'Maximum power, percent', 'Speed-up time, seconds'])
        assert.equal(await page.getByRole('textbox', { name: n, exact: true }).count(), 1, n);
    assert.match(await page.locator('.st-form > .st-program').innerText(), /then gusts capped at 40 % by Maximum power/, 'the firmware caps every gust at 40 %');
    assert.match(await page.locator('.st [data-name="autostart_gust_max"]').innerText(), /Capped at 40 % by Maximum power/);
    assert.match(await page.locator('.st-form > .st-program').innerText(), /Never above 40 % \(Maximum power\)/);
    // the 20 % base only on request
    await page.getByRole('button', { name: 'Also set Power to 20 %' }).click();
    assert.equal(await value(page, 'autostart_throttle'), '20');
    assert.equal(await page.getByLabel('Power, percent', { exact: true }).inputValue(), '20');
    await page.close();
});

test('How long: a set time in minutes + seconds, clamped; "until the battery is low" back to 0', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await connectAndRead(page);
    await question(page, 'autostart_run_time').getByText('For a set time', { exact: true }).click();
    assert.equal(await value(page, 'autostart_run_time'), '60', 'starts at 1 min, never an empty box');
    // the minutes are selected: typing "2" gives 2 min, not "1" + "2" = 12 min
    await page.keyboard.type('2');
    assert.equal(await value(page, 'autostart_run_time'), '120');
    assert.match(await page.locator('.st-form > .st-program').innerText(), /2 min after the speed-up/);
    await page.getByLabel('How long, minutes', { exact: true }).fill('2');
    await page.getByLabel('How long, seconds', { exact: true }).fill('75');
    await page.getByLabel('How long, seconds', { exact: true }).press('Tab');
    assert.equal(await value(page, 'autostart_run_time'), '179');
    assert.match(await question(page, 'autostart_run_time').innerText(), /Seconds go from 0 to 59/);
    await page.getByLabel('How long, seconds', { exact: true }).press('ArrowUp');
    assert.equal(await value(page, 'autostart_run_time'), '180');
    assert.deepEqual([await page.getByLabel('How long, minutes', { exact: true }).inputValue(), await page.getByLabel('How long, seconds', { exact: true }).inputValue()], ['3', '0']);
    assert.match(await page.locator('.st-form > .st-program').innerText(), /3 min after the speed-up; sooner if the battery stays below 19\.8 V/);
    await question(page, 'autostart_run_time').getByText('Until the battery is low', { exact: true }).click();
    assert.equal(await value(page, 'autostart_run_time'), '0');
    assert.ok(!(await page.getByLabel('How long, minutes', { exact: true }).isVisible()));
    await page.close();
});

test('"No battery protection" needs a confirm (focus on Cancel, Esc cancels, its own STOP), then red lines outside the drawer', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await connectAndRead(page);
    await openMore(page);
    const box = page.getByLabel('No battery protection (the LiPo can be ruined)');
    await box.click();
    const dlg = page.locator('dialog[open]');
    await dlg.getByText('Turn off battery protection?').waitFor();
    assert.ok(await dlg.getByRole('button', { name: 'STOP motor' }).isVisible(), 'the confirm carries a STOP');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Cancel');
    await page.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' }).catch(() => undefined);
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await value(page, 'autostart_cell_cutoff'), '330');
    assert.ok(!(await box.isChecked()));
    assert.ok(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type === 'checkbox'), 'focus back on the switch');

    await box.click();
    await page.getByRole('button', { name: 'Turn it off' }).click();
    await page.locator('.st [data-name="autostart_cell_cutoff"][data-value="0"]').waitFor({ timeout: 3000 });
    assert.match(await question(page, 'autostart_cells').innerText(), /No battery protection: the motor runs until the LiPo is empty/);
    assert.match(await question(page, 'autostart_run_time').innerText(), /Until the power is off/);
    assert.match(await page.locator('.st-form > .st-program').innerText(), /Until the power is off — no battery protection/);
    assert.match(await page.locator('details.st-more > summary').innerText(), /Needs a look: Stop voltage per cell: no battery protection/);
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    await page.locator('.st-live').getByText('No battery protection: the motor runs until the LiPo is empty.').waitFor({ timeout: 5000 });
    assert.equal(await moreOpen(page), true, 'never closes by itself');
    await page.close();
});

test('More settings opens by itself for every safety case; all defaults and a cap keep it closed (negative controls)', async () => {
    const cases: [string, boolean][] = [
        ['autostart_cell_cutoff:0', true],
        ['autostart_cells:0', true],
        ['autostart_vbat_min:0', true],
        ['autostart_usb_inhibit:ON', true],
        ['autostart_motors:14', true],
        ['autostart_mode:BUTTON', true],
        ['autostart_cutoff_time:20', true],
        ['autostart_box:40', true],
        ['', false],
        ['autostart_throttle_limit:40', false],
        ['autostart_ramp:200', false]
    ];
    for (const [set, opens] of cases) {
        const { page } = await open(`mock=1&mockReboot=150${set ? `&mockSet=${set}` : ''}`);
        await connectAndRead(page);
        assert.equal(await moreOpen(page), opens, `${set || 'all defaults'}: drawer ${opens ? 'opens' : 'stays closed'}`);
        const summary = await page.locator('details.st-more > summary').innerText();
        if (opens) assert.match(summary, /Needs a look:/, set);
        else assert.doesNotMatch(summary, /Needs a look/, set);
        if (set === 'autostart_ramp:200') assert.match(summary, /Not default: Speed-up time: 20 s/);
        if (set === 'autostart_cells:0') assert.match(await question(page, 'autostart_cells').innerText(), /Cells counted automatically/);
        if (set === 'autostart_usb_inhibit:ON') assert.match(await page.locator('.st-form > .st-program').innerText(), /Nothing spins while a computer is connected/);
        await page.close();
    }
    // the closed drawer names EVERY hidden value that differs (no "and N more")
    const { page } = await open('mock=1&mockReboot=150&mockSet=autostart_ramp:50,autostart_gust_min:41,autostart_gust_max:81,autostart_vbat_min:61,autostart_motors:3');
    await connectAndRead(page);
    assert.equal(await moreOpen(page), false);
    const summary = await page.locator('details.st-more > summary').innerText();
    for (const t of ['Speed-up time: 5 s', 'Weakest gust: 41 %', 'Strongest gust: 81 %', 'Battery counts as plugged in from: 6.1 V', 'Motor outputs: 1, 2']) assert.ok(summary.includes(t), `${t} in "${summary}"`);
    assert.doesNotMatch(summary, /and \d+ more/);
    await page.close();
});

test('Reset to defaults… lists every change (hidden ones too) and needs a confirm', async () => {
    const { page } = await open('mock=1&mockReboot=150&mockSet=autostart_ramp:200,autostart_delay:30');
    await connectAndRead(page);
    await openMore(page);
    await page.getByRole('button', { name: 'Reset to defaults…' }).click();
    const dlg = page.locator('dialog[open]');
    const text = await dlg.innerText();
    assert.match(text, /Go back to the defaults\?/);
    assert.match(text, /Wait before start: 30 s → 10 s/);
    assert.match(text, /Speed-up time: 20 s → 10 s/);
    await dlg.getByRole('button', { name: 'Use the defaults' }).click();
    await page.locator('.st-changes [data-change="autostart_ramp"]').waitFor({ timeout: 3000 });
    assert.deepEqual(await changeKeys(page), ['autostart_delay', 'autostart_ramp']);
    assert.match(await page.locator('.st-msg').filter({ hasText: 'Defaults are in the form' }).innerText(), /Press Save to board/);
    await page.close();
});

test('STOP works while the Run dialog and the page’s Feedback (sma:stop) are open, also while the board restarts', async () => {
    const { page, errors } = await open('mock=1&mockReboot=600&mockSpeed=10');
    await connect(page);
    await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
    // inside the Run dialog
    await page.getByRole('button', { name: 'Run the program…' }).click();
    await page.locator('dialog[open]').getByRole('button', { name: 'STOP motor' }).click();
    await page.locator('.st-state[data-state="0"]').waitFor({ timeout: 5000 });
    assert.match(await page.locator('.st-state').innerText(), /Stopped with STOP/);
    await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
    // run again: the propeller confirmation, then STOP while the board restarts (queued, never disabled)
    await page.getByRole('button', { name: 'Run the program…' }).click();
    const runNow = page.getByRole('button', { name: 'Run now', exact: true });
    assert.ok(await runNow.isDisabled());
    await page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await runNow.click();
    await page.locator('.st[data-phase="rebooting"], .st[data-phase="reconnecting"]').waitFor({ timeout: 3000 });
    assert.ok(await page.locator('.st-stopbar .st-stop').isEnabled(), 'STOP enabled during the restart');
    assert.match(await page.locator('.st-stopstate').innerText(), /Board restarting|Waiting for the board/);
    await page.locator('.st-live .st-msg').getByText('Board restarted: the program runs from the start.').waitFor({ timeout: 10000 });
    await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
    // the page's modal Feedback: its own STOP dispatches sma:stop
    await page.locator('#fb-open').click();
    await page.locator('#fb[open] #fb-stop').click();
    await page.locator('.st-state[data-state="0"]').waitFor({ timeout: 5000 });
    assert.deepEqual(errors, []);
    await page.close();
});

test('keyboard: after Connect the focus is on the connection line and the next Tab is STOP; Run now lands on STOP; Disconnect goes back to Connect', async () => {
    const { page, errors } = await open('mock=1&mockReboot=300');
    const active = () => page.evaluate(() => document.activeElement?.textContent ?? '');
    await page.locator('.st-connect .st-primary').focus();
    await page.keyboard.press('Enter');
    await page.locator('.st-conn').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.classList.contains('st-conn'), null, { timeout: 3000 });
    await page.keyboard.press('Tab');
    assert.equal(await active(), 'STOP motor', 'the first Tab after the connection line');
    await page.keyboard.press('Tab');
    assert.equal(await active(), 'Disconnect');
    // Run the program… → tick → Run now: the motor is about to start, the focus is on STOP (not lost to the page)
    await page.getByRole('button', { name: 'Run the program…' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space'); // the propeller box has the focus
    await page.locator('dialog[open]').getByRole('button', { name: 'Run now', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.activeElement?.matches('.st-stopbar .st-stop')), `focus after Run now: ${await active()}`);
    await page.locator('.st-live .st-msg').getByText('Board restarted: the program runs from the start.').waitFor({ timeout: 10000 });
    assert.ok(await page.evaluate(() => document.activeElement?.matches('.st-stopbar .st-stop')), 'still on STOP after the restart');
    await page.getByRole('button', { name: 'Disconnect' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Connect', null, { timeout: 5000 });
    assert.deepEqual(errors, []);
    await page.close();
});

test('Run now then Save: no stale "runs from the start"; STOP in the same moment as Run now: stopped and held, never "runs"', async () => {
    const { page, errors } = await open('mock=1&mockReboot=400&mockSpeed=4');
    await connectAndRead(page);
    const runDialog = async () => {
        await page.locator('.st-live > .st-row > .st-btn').click();
        await page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    };
    await runDialog();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    await page.locator('.st-live .st-msg').getByText('Board restarted: the program runs from the start.').waitFor({ timeout: 10000 });
    await page.locator('.st[data-phase="ready"]').waitFor();
    await question(page, 'autostart_pattern').getByText('On', { exact: true }).click();
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    await page.locator('.st-state').filter({ hasText: 'Paused while settings are open' }).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await page.locator('.st-live').innerText(), /runs from the start/, 'the old Run message is gone after Save');
    // STOP clicked in the same task as Run now: queued, sent once the board is back, the program stays held
    await runDialog();
    await page.evaluate(() => {
        (document.querySelector('dialog.st-run .st-primary') as HTMLButtonElement).click();
        (document.querySelector('.st-stopbar .st-stop') as HTMLButtonElement).click();
    });
    await page.locator('.st-live .st-msg').getByText(/Board restarted, then stopped with STOP/).waitFor({ timeout: 10000 });
    await page.locator('.st-state').filter({ hasText: 'Stopped with STOP' }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(1500); // the emulated program would be counting down by now if the hold were lost
    assert.match(await page.locator('.st-state').innerText(), /Stopped with STOP/);
    assert.doesNotMatch(await page.locator('.st-live').innerText(), /runs from the start/);
    assert.deepEqual(errors, []);
    await page.close();
});

test('STOP right after Save (the CLI is being opened): the save succeeds, no false "refused" or "stopped answering"', async () => {
    for (const delay of [0, 150]) {
        const { page, errors } = await open('mock=1&mockReboot=300');
        await connectAndRead(page);
        await question(page, 'autostart_delay').getByText('5 s', { exact: true }).click();
        await page.evaluate(d => {
            (document.querySelector('.st-actions .st-primary') as HTMLButtonElement).click();
            setTimeout(() => (document.querySelector('.st-stopbar .st-stop') as HTMLButtonElement).click(), d);
        }, delay);
        await page.locator('.st-actions .st-msg[data-result]').waitFor({ timeout: 20000 });
        const msg = page.locator('.st-actions .st-msg');
        assert.equal(await msg.getAttribute('data-result'), 'saved', `STOP after ${delay} ms: ${await msg.innerText()}`);
        assert.match(await msg.innerText(), /Saved and checked on the board: 1 value\./, 'one value, singular');
        await page.waitForTimeout(2000);
        assert.doesNotMatch(await page.locator('.st-live').innerText(), /stopped answering/, `${delay} ms`);
        assert.equal(await page.locator('.st-error').isVisible(), false);
        assert.deepEqual(errors, [], `${delay} ms`);
        await page.close();
    }
});

test('firmware 1.0 with a wrong voltage scale: Calibrate opens the helper in More settings → Battery, the ESC button sets vbat_scale', async () => {
    const { page, errors } = await open('mock=1&mockReboot=150&mockFw=1.0&mockScale=180&mockEsc=bidir');
    await connect(page);
    await page.locator('.st-live').getByText(/the ESC measures 24[.,]\d+ V/).waitFor({ timeout: 5000 });
    await page.locator('.st-live').getByRole('button', { name: 'Calibrate' }).first().click();
    await page.locator('.st-form').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await moreOpen(page), true);
    assert.match(await page.locator('#tool-more-battery').innerText(), /voltage calibration only[\s\S]*Battery stop needs firmware 1\.1/);
    await page.waitForFunction(() => !!document.activeElement?.closest('.st-cal'), null, { timeout: 3000 });
    await page.locator('.st-cal').getByRole('button', { name: /Use the ESC’s reading/ }).click();
    assert.match(await page.locator('.st-cal').innerText(), /New scale \d+ \(was 180\)/);
    assert.notEqual(await value(page, 'vbat_scale'), '180');
    assert.deepEqual(await changeKeys(page), ['vbat_scale']);
    assert.deepEqual(errors, []);
    await page.close();
});

test('short windows: the Run dialog keeps its own STOP in view (sticky buttons)', async () => {
    const cases: [string, { width: number; height: number }][] = [
        ['en', { width: 812, height: 375 }],
        ['en', { width: 320, height: 568 }],
        ['ru', { width: 812, height: 375 }]
    ];
    for (const [lang, vp] of cases) {
        const { page } = await open(`mock=1&mockReboot=150&lang=${lang}`, vp);
        await connectAndRead(page);
        await question(page, 'autostart_delay').locator('label.st-chip').first().click(); // unsaved change: a longer dialog
        await page.locator('.st-live > .st-row > .st-btn').click();
        const dlg = page.locator('dialog[open]');
        await dlg.waitFor();
        await page.waitForTimeout(150);
        const stop = (await dlg.locator('.st-dlgstop').boundingBox())!;
        const box = (await dlg.boundingBox())!;
        const inView = stop.y >= box.y - 0.5 && stop.y + stop.height <= box.y + box.height + 0.5 && stop.y + stop.height <= vp.height;
        assert.ok(inView, `${lang} ${vp.width}×${vp.height}: STOP ${JSON.stringify(stop)} in the dialog ${JSON.stringify(box)}`);
        await page.close();
    }
});

test('announcements that come together are joined; the reason the drawer opened by itself comes last', async () => {
    const { page } = await open('mock=1&mockReboot=150&mockSet=autostart_cell_cutoff:0');
    await connect(page);
    await page.evaluate(() => {
        const region = document.querySelector('.st p.st-sr[role=status]')!;
        const said: string[] = [];
        (window as unknown as { __said: string[] }).__said = said;
        new MutationObserver(() => {
            if (region.textContent) said.push(region.textContent);
        }).observe(region, { childList: true, characterData: true, subtree: true });
    });
    await openSettings(page);
    await page.waitForTimeout(1200);
    const said = await page.evaluate(() => (window as unknown as { __said: string[] }).__said);
    const both = said.find(s => /Settings read from the board\./.test(s) && /More settings opened: Stop voltage per cell: no battery protection/.test(s));
    assert.ok(both, JSON.stringify(said));
    assert.ok(both.indexOf('More settings opened') > both.indexOf('Settings read'), 'the safety reason last');
    await page.close();
});

test('sma:board tells the page about the board; the STOP bar reserves room at the bottom while connected', async () => {
    const { page } = await open('mock=1&mockReboot=150');
    await connect(page);
    await page.waitForFunction(() => (window as unknown as { __board: { connected: boolean }[] }).__board.some(e => e.connected));
    const lastEv = () => page.evaluate(() => (window as unknown as { __board: { connected: boolean; module: boolean }[] }).__board.at(-1));
    assert.deepEqual({ ...(await lastEv()), phase: undefined }, { connected: true, module: true, phase: undefined });
    const space = await page.evaluate(() => ({ cls: document.documentElement.classList.contains('sma-connected'), pad: parseFloat(getComputedStyle(document.body).paddingBottom), bar: document.querySelector('.st-stopbar')!.getBoundingClientRect().height }));
    assert.ok(space.cls && space.bar >= 44 && Math.abs(space.pad - (space.bar + 12)) <= 1, JSON.stringify(space));
    // the board counts down (DELAY): Disconnect says the motor starts soon, not "keeps its program for later"
    await page.locator('.st-state[data-state="1"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.waitForFunction(() => !(window as unknown as { __board: { connected: boolean }[] }).__board.at(-1)!.connected);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sma-connected')), false);
    assert.equal(await page.evaluate(() => document.body.style.paddingBottom), '');
    assert.match(await page.locator('.st-status').innerText(), /Disconnected during the countdown: the motor starts soon\. To stop it, unplug the battery/);
    // negative control: STOP first (held), then Disconnect → the plain text
    await connect(page);
    await page.getByRole('button', { name: 'STOP motor' }).click();
    await page.locator('.st-state').filter({ hasText: 'Stopped with STOP' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.locator('.st-status').filter({ hasText: /Disconnected\. The board keeps its program/ }).waitFor({ timeout: 5000 });
    // a stock build: connected, but no module
    const stock = await open('mock=1&mockFw=stock');
    await connect(stock.page);
    await stock.page.waitForFunction(() => (window as unknown as { __board: { connected: boolean }[] }).__board.some(e => e.connected));
    assert.equal((await stock.page.evaluate(() => (window as unknown as { __board: { module: boolean }[] }).__board.at(-1)))!.module, false);
    await stock.page.close();
    await page.close();
});

test('private mode: a throwing localStorage — the tool renders and works, More settings starts closed', async () => {
    const { page, errors } = await open('mock=1&mockReboot=150', undefined, () => {
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() {
                throw new DOMException('denied', 'SecurityError');
            }
        });
    });
    await connectAndRead(page);
    assert.equal(await moreOpen(page), false);
    await openMore(page);
    assert.equal(await moreOpen(page), true);
    assert.deepEqual(errors, []);
    await page.close();
});

test('foolproof input: out of range is clamped with a note, nothing invalid reaches the board', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('Other', { exact: true }).click();
    const delay = page.getByLabel('Wait before start, seconds', { exact: true });
    await delay.fill('9999');
    await delay.press('Tab');
    assert.equal(await delay.inputValue(), '600');
    assert.match(await question(page, 'autostart_delay').locator('.st-fnote').innerText(), /allowed 0–600/);
    await delay.fill('abc');
    await delay.press('Tab');
    assert.match(await delay.inputValue(), /^\d+$/);
    // the special 0 is never typed: the cut-off box turns 0 into the lowest real value
    await openMore(page);
    const cut = page.getByRole('textbox', { name: 'Stop voltage per cell, volts', exact: true });
    await cut.fill('0');
    await cut.press('Tab');
    assert.equal(await value(page, 'autostart_cell_cutoff'), '250');
    await page.close();
});

test('negative control: the board answers "Invalid value" → an error, never "Saved and checked"', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockInvalid=autostart_delay');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('30 s', { exact: true }).click();
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="error"]').waitFor({ timeout: 15000 });
    const text = await page.locator('.st-settings').innerText();
    assert.match(text, /The board refused autostart_delay = 30\. Nothing was saved\./);
    assert.doesNotMatch(text, /Saved and checked/);
    await page.locator('.st[data-phase="ready"]').waitFor();
    assert.ok(await page.locator('.st-conn').isVisible(), 'still connected and usable');
    await page.close();
});

test('negative control: the board never comes back after saving → a clear timeout message', async () => {
    const { page } = await open('mock=1&mockNoReturn=1&mockReconnectTimeout=1500');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('60 s', { exact: true }).click();
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="error"]').waitFor({ timeout: 15000 });
    const text = await page.locator('.st-settings').innerText();
    assert.match(text, /did not come back after restarting/);
    assert.doesNotMatch(text, /Saved and checked/);
    assert.match(await page.locator('.st-status').innerText(), /Plug it back in/);
    assert.ok(await page.locator('.st-stopbar').isVisible(), 'STOP stays while reconnecting');
    await page.close();
});

test('miscalibrated board: Motor status says so, More settings opens at the calibration, the scale is saved and verified', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockScale=120&mockEsc=bidir');
    await connect(page);
    await page.locator('.st-live').getByText(/doesn’t fit the battery/).waitFor({ timeout: 5000 });
    await page.locator('.st-live').getByText(/the ESC measures 24[.,]\d+ V/).waitFor({ timeout: 5000 });
    await page.locator('.st-live').getByRole('button', { name: 'Calibrate' }).first().click();
    await page.locator('.st-form').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.st-live').getByText(/13[.,]9\d V doesn’t fit 6S/).waitFor({ timeout: 5000 });
    assert.equal(await moreOpen(page), true);
    await page.getByRole('textbox', { name: 'Your multimeter shows, volts', exact: true }).fill('24,4');
    await page.getByRole('button', { name: 'Use this reading' }).click();
    assert.match(await page.locator('.st-cal').innerText(), /New scale 210 \(was 120\)/);
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    await page.locator('.st-live').getByText('24.40 V', { exact: true }).waitFor({ timeout: 5000 });
    await page.close();
});

test('firmware 1.0: what it lacks is not drawn; one note in Step 3 and in Motor status', async () => {
    const { page } = await open('mock=1&mockReboot=150&mockFw=1.0');
    await connectAndRead(page);
    assert.match(await page.locator('.st-settings').innerText(), /Firmware 1\.0 on this board: no battery protection/);
    await page.locator('.st-live').getByText('Firmware 1.0 has no battery protection. Update to 1.1.').waitFor({ timeout: 5000 });
    for (const n of ['autostart_run_time', 'autostart_pattern', 'autostart_cells', 'autostart_throttle_limit', 'autostart_gust_min']) assert.equal(await page.locator(`.st [data-name="${n}"]`).count(), 0, n);
    assert.equal(await page.getByText('Needs firmware 1.1', { exact: true }).count(), 0);
    assert.match(await page.locator('.st-form > .st-program').innerText(), /firmware 1\.0 has no battery protection/);
    await page.close();
});

test('stock Betaflight: no automatic read, an explicit "Check this board", then one banner; Motor status and Step 3 hidden', async () => {
    const { page } = await open('mock=1&mockReboot=150&mockFw=stock');
    await connect(page);
    await page.locator('.st-banners').getByText(/This doesn’t look like a Shramko Motor Autostart build/).waitFor();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('.st').getAttribute('data-phase'), 'ready', 'nothing read by itself');
    assert.ok(!(await page.locator('.st-live').isVisible()) && !(await page.locator('.st-settings').isVisible()));
    await page.getByRole('button', { name: 'Check this board' }).click();
    await page.locator('.st-banners').getByText('This board has no autostart yet. Install the firmware first (step 1).').waitFor({ timeout: 10000 });
    assert.ok(!(await page.locator('.st-settings').isVisible()));
    await page.close();
});

test('375 px wide in all 4 languages: no horizontal scroll with More settings open, STOP fits and covers nothing in focus', async () => {
    for (const lang of ['en', 'es', 'pl', 'ru']) {
        const { page, errors } = await open(`mock=1&mockReboot=150&lang=${lang}&mockSet=autostart_cell_cutoff:0`, { width: 375, height: 740 });
        await connectAndRead(page);
        await openMore(page);
        await page.waitForTimeout(200);
        const w = await page.evaluate(() => document.documentElement.scrollWidth);
        assert.ok(w <= 375, `${lang}: page is ${w}px wide`);
        const bar = (await page.locator('.st-stopbar').boundingBox())!;
        const stop = (await page.locator('.st-stopbar .st-stop').boundingBox())!;
        assert.ok(bar.y + bar.height <= 740.5 && stop.height >= 44 && stop.width >= 44 && stop.x + stop.width <= 375, `${lang}: STOP inside the screen`);
        // the bar keeps the Power % when the state words are too long for the phone (they ellipsize instead)
        const pct = await page.locator('.st-stoppct').evaluate(e => {
            const r = e.getBoundingClientRect();
            const box = e.parentElement!.getBoundingClientRect();
            return { text: e.textContent ?? '', right: r.right, boxRight: box.right, w: r.width, cut: e.scrollWidth > e.clientWidth + 1 };
        });
        assert.ok(/%/.test(pct.text) && pct.w > 10 && !pct.cut && pct.right <= pct.boxRight + 0.5, `${lang}: the Power % in the bar ${JSON.stringify(pct)}`);
        // the last control of the tool, focused, sits above the bar
        await page.locator('.st-reload .st-btn').focus();
        const r = (await page.locator('.st-reload .st-btn').boundingBox())!;
        assert.ok(r.y + r.height <= bar.y + 0.5, `${lang}: the focused button is not under STOP (${r.y + r.height} > ${bar.y})`);
        assert.deepEqual(errors, [], lang);
        await page.close();
    }
});

test('unsupported browser: Connect is disabled and the message says which browsers work', async () => {
    const page = await browser.newPage();
    // like Safari / Firefox / iOS: no Web Serial and no WebUSB
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'serial', { value: undefined, configurable: true });
        Object.defineProperty(navigator, 'usb', { value: undefined, configurable: true });
    });
    await page.goto(base);
    const btn = page.getByRole('button', { name: 'Connect', exact: true });
    await btn.waitFor();
    assert.ok(await btn.isDisabled());
    assert.match(await page.locator('.st-connect').innerText(), /iPhone and iPad can’t do it/);
    await page.close();
});

test('Polish page: the tool speaks Polish', async () => {
    const p = await browser.newPage();
    await p.goto(`${base}?mock=1&lang=pl`);
    await p.locator('.st-connect h3').waitFor();
    assert.equal(await p.locator('.st-connect h3').innerText(), 'Krok 2 · Podłącz płytkę');
    await p.close();
});

// ---------- the fixes of 2026-10-20 (real-hardware facts, the adversarial review): each with a negative control ----------

type Mocks = { __mocks?: { unplug(ms?: number): void; boot(): void; mspLog: number[]; opts: Record<string, unknown>; reboots: number }[] };
const saveMsg = (page: Page) => page.locator('.st-actions > .st-msg');
const liveSub = (page: Page) => page.locator('.st-livemore .st-meter .st-small').first();
const openLiveMore = (page: Page) => page.locator('details.st-livemore').evaluate(d => ((d as HTMLDetailsElement).open = true));

test('K1: an edit after "Saved and checked" (or Undo) clears the old result and its Run now; the calibration result goes with Undo', async () => {
    const { page, errors } = await open('mock=1&mockReboot=300');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('30 s', { exact: true }).click();
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    assert.ok(await saveMsg(page).getByRole('button', { name: 'Run now…' }).isVisible());
    await question(page, 'autostart_throttle').getByText('50 %', { exact: true }).click();
    assert.equal((await saveMsg(page).innerText()).trim(), '', 'the old result is gone');
    assert.equal(await saveMsg(page).getByRole('button', { name: 'Run now…' }).count(), 0);
    await page.getByRole('button', { name: 'Undo changes' }).click();
    assert.match(await saveMsg(page).innerText(), /Changes undone/);
    await question(page, 'autostart_throttle').getByText('80 %', { exact: true }).click();
    assert.equal((await saveMsg(page).innerText()).trim(), '', 'the Undo note is gone with the next edit');
    // negative control: a result with no edit after it stays
    await page.getByRole('button', { name: 'Undo changes' }).click();
    await page.waitForTimeout(300);
    assert.match(await saveMsg(page).innerText(), /Changes undone/);
    // calibration: the same scale says so; a new one is forgotten by Undo
    await openMore(page);
    const cal = page.getByRole('textbox', { name: 'Your multimeter shows, volts', exact: true });
    await cal.fill('24.4');
    await cal.press('Enter');
    assert.match(await page.locator('.st-cal').innerText(), /The scale already matches \(210\)/);
    await cal.fill('26');
    await cal.press('Enter');
    assert.match(await page.locator('.st-cal').innerText(), /New scale 224 \(was 210\)/);
    await page.getByRole('button', { name: 'Undo changes' }).click();
    assert.doesNotMatch(await page.locator('.st-cal').innerText(), /New scale/);
    assert.equal(await value(page, 'vbat_scale'), '210');
    assert.deepEqual(errors, []);
    await page.close();
});

test('K2: Battery 8S on a 24.4 V pack is below its stop voltage — never "fits", never a green "Protected"; Use 6S fixes it', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockSpeed=4');
    await connectAndRead(page);
    const battery = question(page, 'autostart_cells');
    await battery.locator('label.st-chip', { hasText: /^8S$/ }).click();
    await battery.getByText(/24\.4 V is below the stop voltage 26\.4 V of 8S: the motor would stop at once/).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await battery.innerText(), /fits 8S/);
    assert.equal(await battery.locator('.st-qline.st-tone-ok').count(), 0, 'no green protection line');
    assert.equal(await battery.locator('.st-qline.st-tone-bad').count(), 1);
    await battery.getByRole('button', { name: 'Use 6S' }).click();
    await battery.getByText('24.4 V fits 6S').waitFor();
    assert.equal(await battery.locator('.st-qline.st-tone-ok').count(), 1, 'negative control: 6S is green');
    // a 6S pack at 19.0 V is below 19.8 V too; Motor status says so after the read
    const low = await open('mock=1&mockReboot=200&mockSpeed=4&mockVolts=19.0');
    await connectAndRead(low.page);
    await question(low.page, 'autostart_cells').getByText(/19\.0 V is below the stop voltage 19\.8 V of 6S/).waitFor({ timeout: 5000 });
    await low.page.locator('.st-live .st-warns').getByText(/19\.0 V is below the stop voltage 19\.8 V \(6S\): the motor stops at once/).waitFor({ timeout: 5000 });
    await low.page.close();
    await page.close();
});

test('K8.1: a stale ESC voltage after a restart (TX wire, 14.81 V kept by MSP) is never warned about, auto-opened or offered; once the motor turned it is used', async () => {
    // correct scale: nothing to warn about before or after the motor turned
    const { page, errors } = await open('mock=1&mockReboot=300&mockSpeed=4&mockEsc=sensor&mockEscVolts=14.81');
    await connect(page);
    await openLiveMore(page);
    await liveSub(page).getByText(/ESC last sent 14\.81 V \(old reading\)/).waitFor({ timeout: 5000 });
    await page.waitForTimeout(800);
    assert.doesNotMatch(await page.locator('.st-live .st-warns').innerText(), /ESC measures/, 'no mismatch warning from an old value');
    // the motor turns (10 s wait at 4×): the ESC sends live values now — the same as the board
    await page.locator('.st-state[data-state="2"], .st-state[data-state="3"]').first().waitFor({ timeout: 10000 });
    await liveSub(page).getByText(/ESC measures 24\.\d\d V/).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await page.locator('.st-live .st-warns').innerText(), /ESC measures/);
    assert.deepEqual(errors, []);
    await page.close();
    // the same with a board that reads high: no warning from the stale value, the real one warns (stop too late)
    const hi = await open('mock=1&mockReboot=300&mockSpeed=4&mockEsc=sensor&mockEscVolts=14.81&mockScale=250');
    await connect(hi.page);
    await hi.page.waitForTimeout(1500);
    assert.doesNotMatch(await hi.page.locator('.st-live .st-warns').innerText(), /ESC measures/, 'stale: never');
    await hi.page.locator('.st-live .st-warns').getByText(/the ESC measures 24\.\d\d V .* the board reads high, so the battery stop comes too late/).waitFor({ timeout: 12000 });
    await hi.page.close();
});

test('C02: a slipped decimal point in the multimeter box is refused (244, 2.44); a real reading is used', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockScale=200');
    await connectAndRead(page);
    await openMore(page);
    const cal = page.getByRole('textbox', { name: 'Your multimeter shows, volts', exact: true });
    for (const typo of ['244', '2.44']) {
        await cal.fill(typo);
        await cal.press('Enter');
        assert.match(await page.locator('.st-cal').innerText(), /doesn’t fit 6S\. 24\.4 or 2\.44\? A 6S pack reads 15\.0–26\.7 V\. Nothing changed/, typo);
        assert.equal(await value(page, 'vbat_scale'), '200', `${typo}: the scale is untouched`);
    }
    assert.deepEqual(await changeKeys(page), []);
    await cal.fill('24.4');
    await cal.press('Enter');
    assert.match(await page.locator('.st-cal').innerText(), /New scale 210 \(was 200\)/);
    assert.deepEqual(await changeKeys(page), ['vbat_scale']);
    await page.close();
});

test('K8.4: sparse TX-wire samples never flicker "No answer from an ESC"; no "bad frames" over the TX wire', async () => {
    const { page } = await open('mock=1&mockReboot=300&mockSpeed=10&mockEsc=sensor&mockEscSparse=0.5');
    await connect(page);
    await openLiveMore(page);
    await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
    await liveSub(page).getByText(/output 1/).waitFor({ timeout: 5000 });
    const seen = await page.evaluate(async () => {
        const el = document.querySelector('.st-livemore .st-meter .st-small')!;
        const out = new Set<string>();
        for (let i = 0; i < 30; i++) {
            out.add(el.textContent ?? '');
            await new Promise(r => setTimeout(r, 100));
        }
        return [...out];
    });
    assert.ok(seen.every(t => /^output 1/.test(t)), JSON.stringify(seen));
    assert.ok(!seen.some(t => /No answer|bad frames/.test(t)), JSON.stringify(seen));
    await page.close();
});

test('K8.2: after Run the ESC only beeps (BLHeli_32 on the battery, dshot_bidir ON): Motor status says replug the battery; never without the lock', async () => {
    for (const locked of [true, false]) {
        const { page } = await open(`mock=1&mockReboot=300&mockSpeed=10&mockEsc=bidir${locked ? '&mockEscLocked=1' : ''}`);
        await connect(page);
        await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
        await page.getByRole('button', { name: 'Run the program…' }).click();
        await page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
        await page.getByRole('button', { name: 'Run now', exact: true }).click();
        await page.locator('.st-live .st-msg').getByText(/Motor only beeps and does not turn after a Save or Run\? Unplug the battery/).waitFor({ timeout: 10000 });
        await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
        const warn = page.locator('.st-live .st-warns').getByText(/The motor only beeps and does not turn\? Unplug the battery and plug it back in/);
        if (locked) await warn.waitFor({ timeout: 8000 });
        else {
            await page.waitForTimeout(4500);
            assert.equal(await warn.count(), 0, 'a turning ESC: no warning');
        }
        await page.close();
    }
});

test('K8.3: no ESC telemetry wired: the advice puts the TX wire first and names the BLHeli_32 caveat of bidirectional DShot', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockEsc=none');
    await connectAndRead(page);
    await openLiveMore(page);
    await liveSub(page).getByText(/connect the ESC’s TX pad to the cable’s yellow wire \(feature ESC_SENSOR\) — recommended\. Bidirectional DShot .* can lock with it: replug the battery/).waitFor({ timeout: 5000 });
    await page.close();
    // negative control: the TX wire is configured — the ESC just has not turned yet
    const s = await open('mock=1&mockReboot=200&mockEsc=sensor&mockSet=autostart_delay:60');
    await connectAndRead(s.page);
    await openLiveMore(s.page);
    await liveSub(s.page).getByText(/the ESC answers only after the motor has turned once/).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await liveSub(s.page).innerText(), /Bidirectional/);
    await s.page.close();
});

test('C09: a run longer than 655 s keeps counting down after the firmware counter stops', async () => {
    const { page } = await open('mock=1&mockReboot=300&mockSpeed=60&mockSet=autostart_run_time:1200');
    // the countdown needs the saved run time: read, then run the program from the start
    await connectAndRead(page);
    await page.getByRole('button', { name: 'Run the program…' }).click();
    await page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
    await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
    const left = async () => Number(/Stops in (\d+) s/.exec(await page.locator('.st-state-sub').innerText())?.[1] ?? NaN);
    // past 655 s in RUN (60×: ~11 s), the counter stopped: the page counts on with the board's uptime
    await page.waitForFunction(() => /Stops in ([1-4]\d\d) s/.test(document.querySelector('.st-state-sub')?.textContent ?? ''), null, { timeout: 20000 });
    const a = await left();
    await page.waitForTimeout(1500);
    const b = await left();
    assert.ok(a < 545 && b < a - 40, `the countdown moves on past 655 s: ${a} → ${b}`);
    await page.close();
});

test('C15: firmware 1.0 ignores STOP in the countdown — the page notices, stops it through the CLI and never says "stays stopped until Run"', async () => {
    const { page } = await open('mock=1&mockReboot=300&mockSpeed=4&mockFw=1.0&mockSet=autostart_delay:20');
    await connect(page);
    await page.locator('.st-state[data-state="1"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'STOP motor' }).click();
    await page.locator('.st-live .st-msg').getByText(/Stopped\. This firmware does not hold the program/).waitFor({ timeout: 8000 });
    // the emulated countdown (20 s at 4× = 5 s) would have ramped by now if the stop had not taken
    await page.waitForTimeout(5500);
    assert.equal(await page.locator('.st-state').getAttribute('data-state'), '0');
    assert.doesNotMatch(await page.locator('.st-live .st-msg').innerText(), /stays stopped until/);
    await page.close();
    // negative control: firmware 1.1 holds — "stays stopped until you press Run"
    const v11 = await open('mock=1&mockReboot=300&mockSpeed=4');
    await connect(v11.page);
    await v11.page.locator('.st-state[data-state="1"]').waitFor({ timeout: 5000 });
    await v11.page.getByRole('button', { name: 'STOP motor' }).click();
    await v11.page.locator('.st-live .st-msg').getByText(/Stopped\. It stays stopped until you press Run the program/).waitFor({ timeout: 5000 });
    await v11.page.close();
});

test('C13/C43: a double click on Connect makes one board; Disconnect while reconnecting, then Connect at once: the new session works', async () => {
    const { page, errors } = await open('mock=1&mockReboot=300&mockSpeed=4');
    await page.locator('.st-connect .st-primary').dblclick();
    await page.locator('.st-conn').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => (window as unknown as Mocks).__mocks!.length), 1, 'one emulated board');
    await page.evaluate(() => (window as unknown as Mocks).__mocks!.at(-1)!.unplug(20000));
    await page.locator('.st[data-phase="reconnecting"]').waitFor({ timeout: 5000 });
    await page.evaluate(() => {
        (document.querySelector('.st-connrow .st-ghost') as HTMLButtonElement).click(); // Disconnect
        setTimeout(() => (document.querySelector('.st-connect .st-primary') as HTMLButtonElement).click(), 30); // Connect
    });
    await page.waitForTimeout(400);
    // Connect waited for the Disconnect to finish; a second click now connects a new board
    if (!(await page.locator('.st-conn').isVisible())) await page.locator('.st-connect .st-primary').click();
    await page.locator('.st-conn').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByRole('button', { name: 'Disconnect' }).waitFor();
    const s1 = await page.locator('.st-state').innerText();
    await page.waitForFunction(old => document.querySelector('.st-state')?.textContent !== old || /Starts in/.test(document.querySelector('.st-state-sub')?.textContent ?? ''), s1, { timeout: 8000 });
    assert.ok(await page.locator('.st-live').isVisible(), 'Motor status is shown and updates');
    assert.deepEqual(errors, []);
    await page.close();
});

test('C11: a CLI left open with unsaved values in RAM — Change settings shows the board’s saved program, not the half-written values', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockCliUnsaved=autostart_delay:45,autostart_throttle:60');
    await connectAndRead(page);
    assert.equal(await value(page, 'autostart_delay'), '10');
    assert.equal(await value(page, 'autostart_throttle'), '15');
    assert.match(await page.locator('.st-changes').innerText(), /Nothing changed/);
    await page.close();
});

test('C16: a bug report carries the configurator state and its log', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await connect(page);
    const d = (await page.evaluate(() => (window as unknown as { __diag: () => Promise<unknown> }).__diag())) as { tool: Record<string, unknown>; log: string[] };
    assert.equal(d.tool.phase, 'ready');
    assert.equal(d.tool.board, 'HGLRC_F405_S8');
    assert.equal(d.tool.verdict, 'autostart');
    assert.ok((d.tool.log as string[]).length > 0 && d.log.some(l => /tool phase: ready/.test(l)), JSON.stringify(d.log.slice(-5)));
    await page.close();
});

test('C44: leaving the page with unsaved changes asks first; with none it does not', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await connectAndRead(page);
    const asks = () =>
        page.evaluate(() => {
            const ev = new Event('beforeunload', { cancelable: true });
            window.dispatchEvent(ev);
            return ev.defaultPrevented;
        });
    assert.equal(await asks(), false, 'nothing unsaved: no question');
    await question(page, 'autostart_delay').getByText('30 s', { exact: true }).click();
    assert.equal(await asks(), true, 'unsaved: the page asks');
    await page.getByRole('button', { name: 'Undo changes' }).click();
    assert.equal(await asks(), false, 'negative control: undone, no question');
    await page.close();
});

test('C45: the STOP bar is there while a board is being connected (its CLI was left open: a few seconds)', async () => {
    const { page } = await open('mock=1&mockReboot=300&mockCliOpen=1');
    await page.locator('.st-connect .st-primary').click();
    await page.locator('.st[data-phase="connecting"] .st-stopbar:not([hidden])').waitFor({ timeout: 3000 });
    assert.match(await page.locator('.st-stopstate').innerText(), /Connecting to the board/);
    await page.locator('.st-conn').waitFor({ state: 'visible', timeout: 15000 });
    await page.close();
});

test('held and finished states in words: an unknown hold, DONE while held, a mode OFF Run, a battery under "counts as plugged in from", the ESC wake, a cut-off of 1.00 V', async () => {
    // a hold this page did not make (a reload, the Betaflight App): not "Stopped with STOP"
    const held = await open('mock=1&mockReboot=200&mockHeld=1');
    await connect(held.page);
    await held.page.locator('.st-state').getByText('Held by the computer').waitFor({ timeout: 5000 });
    await held.page.close();
    // DONE, then Change settings: the board holds it in DONE — a battery replug alone does nothing now
    const done = await open('mock=1&mockReboot=200&mockSpeed=20&mockSet=autostart_run_time:1');
    await connect(done.page);
    await done.page.locator('.st-state[data-state="4"]').waitFor({ timeout: 10000 });
    assert.match(await done.page.locator('.st-state-sub').innerText(), /Press Run the program, or replug the battery/, 'not held yet');
    await openSettings(done.page);
    await done.page.locator('.st-state-sub').getByText(/Held by the computer: press Run the program/).waitFor({ timeout: 5000 });
    await done.page.close();
    // mode OFF: Run says nothing runs
    const off = await open('mock=1&mockReboot=200&mockSet=autostart_mode:OFF');
    await connectAndRead(off.page);
    await off.page.getByRole('button', { name: 'Run the program…' }).click();
    await off.page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await off.page.getByRole('button', { name: 'Run now', exact: true }).click();
    await off.page.locator('.st-live .st-msg').getByText('Board restarted. Autostart is off: nothing runs.').waitFor({ timeout: 10000 });
    await off.page.close();
    // a battery below "counts as plugged in from": never "Plug in the battery"; the field and the program say why
    const vmin = await open('mock=1&mockReboot=200&mockSet=autostart_vbat_min:300');
    await connectAndRead(vmin.page);
    assert.match(await vmin.page.locator('.st-form > .st-program').innerText(), /Never: a 6S pack never reaches 30\.0 V/);
    await openMore(vmin.page);
    assert.match(await vmin.page.locator('.st [data-name="autostart_vbat_min"]').innerText(), /A 6S pack never reaches 30\.0 V/);
    await vmin.page.getByRole('button', { name: 'Run the program…' }).click();
    await vmin.page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await vmin.page.getByRole('button', { name: 'Run now', exact: true }).click();
    await vmin.page.locator('.st-state-sub').getByText(/The battery shows 24\.\d V, below “Battery counts as plugged in from” \(30\.0 V\)/).waitFor({ timeout: 10000 });
    await vmin.page.close();
    // a wait of 0 s: the ESC arms first
    const zero = await open('mock=1&mockReboot=200&mockSet=autostart_delay:0');
    await connectAndRead(zero.page); // the countdown needs the saved wait: read, then run from the start
    await zero.page.getByRole('button', { name: 'Run the program…' }).click();
    await zero.page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await zero.page.getByRole('button', { name: 'Run now', exact: true }).click();
    await zero.page.locator('.st-state-sub').getByText(/Starts in \d s \(the ESC arms first\)/).waitFor({ timeout: 5000 });
    await zero.page.close();
    // a cut-off of 1.00 V per cell: the firmware uses 2.50 V — the page says 15.0 V everywhere
    const cut = await open('mock=1&mockReboot=200&mockSet=autostart_cell_cutoff:100');
    await connectAndRead(cut.page);
    await cut.page.locator('.st-live').getByText(/6S · stops at 15\.0 V/).waitFor({ timeout: 5000 });
    await openMore(cut.page);
    assert.match(await cut.page.locator('.st [data-name="autostart_cell_cutoff"]').innerText(), /the firmware uses 2\.50 V/);
    await cut.page.getByRole('button', { name: 'Run the program…' }).click();
    assert.match(await cut.page.locator('dialog[open]').innerText(), /below 15\.0 V \(6 × 2\.50 V\)/);
    assert.doesNotMatch(await cut.page.locator('dialog[open]').innerText(), /1\.00 V/);
    await cut.page.close();
});

test('drawer details: an unknown RC id, USER1 on this board, gusts raised to Power, no-gust note, swapped pair, 0.333 s, rounding and parse notes, "1 unsaved change", cells counted automatically', async () => {
    const box = await open('mock=1&mockReboot=200&mockSet=autostart_box:0');
    await connectAndRead(box.page);
    const summary = await box.page.locator('details.st-more > summary').innerText();
    assert.match(summary, /RC switch: id 0 \(ignored by the firmware\)/);
    assert.doesNotMatch(summary, /USER-39/);
    await openMore(box.page);
    const sel = box.page.locator('.st [data-name="autostart_box"] select');
    assert.match(await sel.locator('option[value="40"]').innerText(), /USER1 \(also switches PINIO1 — use USER3 or USER4\)/);
    await sel.selectOption('40');
    assert.match(await box.page.locator('.st [data-name="autostart_box"]').innerText(), /On this board USER1 also switches PINIO1/);
    await sel.selectOption('42');
    assert.doesNotMatch(await box.page.locator('.st [data-name="autostart_box"]').innerText(), /also switches PINIO1 \(another/, 'USER3: no warning');
    await box.page.close();

    const g = await open('mock=1&mockReboot=200&mockSet=autostart_pattern:GUSTS,autostart_throttle:30,autostart_gust_min:10');
    await connectAndRead(g.page);
    await openMore(g.page);
    assert.match(await g.page.locator('#tool-more-gusts > legend').innerText(), /30–80 %/, 'the legend as the firmware runs it');
    const strongest = g.page.getByRole('textbox', { name: 'Strongest gust, percent', exact: true });
    await strongest.fill('5'); // below Weakest gust (10): the firmware swaps them
    await strongest.press('Tab');
    assert.match(await g.page.locator('.st [data-name="autostart_gust_max"]').innerText(), /Swapped so the smaller value comes first/);
    assert.match(await g.page.locator('.st [data-name="autostart_gust_min"]').innerText(), /Swapped so the smaller value comes first/);
    assert.match(await g.page.locator('.st [data-name="autostart_gust_max"]').innerText(), /No gust is above Power \(30 %\)/);
    assert.match(await g.page.locator('.st-form > .st-program').innerText(), /no gust is above Power/);
    const shortest = g.page.getByRole('textbox', { name: 'Shortest gust, seconds', exact: true });
    await shortest.fill('0.333');
    await shortest.press('Tab');
    assert.equal(await shortest.inputValue(), '0.333');
    assert.equal(await value(g.page, 'autostart_gust_len_min'), '333');
    await question(g.page, 'autostart_delay').getByText('Other', { exact: true }).click();
    const delay = g.page.getByLabel('Wait before start, seconds', { exact: true });
    await delay.fill('3,3');
    await delay.press('Tab');
    assert.match(await question(g.page, 'autostart_delay').innerText(), /Rounded to 3 s/);
    await delay.fill('12abc');
    await delay.press('Tab');
    assert.match(await question(g.page, 'autostart_delay').innerText(), /Not a number — set to 3 s/);
    await g.page.close();

    const one = await open('mock=1&mockReboot=200');
    await connectAndRead(one.page);
    await openMore(one.page);
    const ramp = one.page.getByRole('textbox', { name: 'Speed-up time, seconds', exact: true });
    await ramp.fill('5');
    await ramp.press('Tab');
    assert.match(await one.page.locator('details.st-more > summary').innerText(), /1 unsaved change inside/);
    await one.page.close();

    const auto = await open('mock=1&mockReboot=200&mockSet=autostart_cells:0');
    await connectAndRead(auto.page);
    assert.equal(await question(auto.page, 'autostart_cells').locator('input[value="other"]').isChecked(), false, 'counted automatically is not "Other"');
    await auto.page.close();
});

test('STOP while the board is unplugged says "not connected" and is sent and confirmed when it is back; a STOP that fails says the motor may still run', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockSpeed=4');
    await connect(page);
    await page.evaluate(() => (window as unknown as Mocks).__mocks!.at(-1)!.unplug(1500));
    await page.locator('.st[data-phase="reconnecting"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'STOP motor' }).click();
    assert.match(await page.locator('.st-live .st-msg').innerText(), /The board is not connected — the stop is sent the moment it is back/);
    await page.locator('.st-live .st-msg').getByText(/Stopped\. It stays stopped until you press Run the program/).waitFor({ timeout: 10000 });
    // the board stops answering: STOP cannot get through
    await page.evaluate(() => ((window as unknown as Mocks).__mocks!.at(-1)!.opts.noAnswer = true));
    await page.getByRole('button', { name: 'STOP motor' }).click();
    await page.locator('.st-live .st-msg').getByText('STOP did not reach the board — the motor may still be running. Unplug the battery now.').waitFor({ timeout: 8000 });
    assert.ok(await page.getByRole('button', { name: 'STOP motor' }).isEnabled(), 'STOP stays for another try');
    await page.close();
});

test('C14: unplugged while connecting — the right words, and nothing keeps polling in the background', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await Promise.all([
        page.locator('.st-connect .st-primary').click(),
        page.evaluate(async () => {
            const w = window as unknown as Mocks;
            for (let i = 0; i < 500 && !((w.__mocks?.at(-1)?.mspLog.length ?? 0) >= 2); i++) await new Promise(r => setTimeout(r, 5));
            w.__mocks!.at(-1)!.unplug(800);
        })
    ]);
    await page.locator('.st-error').getByText('The board disconnected while connecting. Plug it in and press Connect.').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    const n = await page.evaluate(() => (window as unknown as Mocks).__mocks!.at(-1)!.mspLog.length);
    await page.waitForTimeout(1500);
    assert.equal(await page.evaluate(() => (window as unknown as Mocks).__mocks!.at(-1)!.mspLog.length), n, 'no orphan polls the board');
    assert.ok(await page.locator('.st-connect .st-primary').isEnabled());
    await page.close();
});

test('C39: the board comes back late after a save (past the timeout): the save is checked then, and the page says so', async () => {
    const { page } = await open('mock=1&mockNoReturn=1&mockReconnectTimeout=1500');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('60 s', { exact: true }).click();
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="error"]').waitFor({ timeout: 15000 });
    assert.match(await saveMsg(page).innerText(), /did not come back after restarting/);
    // the board is back by itself: the page reads it back and shows the result (no stale "Will save")
    await page.evaluate(() => (window as unknown as Mocks).__mocks!.at(-1)!.boot());
    await saveMsg(page).getByText(/The board is back and the save is checked:\s*Saved and checked on the board: 1 value\./).waitFor({ timeout: 10000 });
    assert.equal(await value(page, 'autostart_delay'), '60');
    assert.doesNotMatch(await page.locator('.st-changes').innerText(), /Will save/);
    await page.close();
});

test('C10/C21: Disconnect during a Save (writing or the restart): no internal-error alarm, and the words say the board runs its program now', async () => {
    for (const phase of ['writing', 'rebooting']) {
        const { page, errors } = await open('mock=1&mockReboot=1500&mockLatency=20');
        await connectAndRead(page);
        await question(page, 'autostart_throttle').getByText('30 %', { exact: true }).click();
        await page.getByRole('button', { name: 'Save to board' }).click();
        await page.locator(phase === 'writing' ? '.st[data-phase="writing"]' : '.st[data-phase="rebooting"], .st[data-phase="reconnecting"]').first().waitFor({ timeout: 10000 });
        await page.getByRole('button', { name: 'Disconnect' }).click();
        await page.locator('.st[data-phase="idle"]').waitFor({ timeout: 10000 });
        await page.waitForTimeout(800);
        const text = await page.locator('.st').innerText();
        assert.doesNotMatch(text, /Something went wrong/, phase);
        assert.deepEqual(errors, [], phase);
        if (phase === 'rebooting') assert.match(await page.locator('.st-status').innerText(), /Disconnected while the board restarted: it runs its program now/);
        else assert.match(await page.locator('.st-status').innerText(), /Disconnected/);
        await page.close();
    }
});

// ---------- the final round of 2026-10-20 (N1–N6 of the diagnostics recheck): each with a negative control ----------

type Fc = {
    setBattery(v: number): void;
    unplug(ms?: number): void;
    motorOutputs(): number[];
    cliLog: string[];
    opts: Record<string, unknown>;
};
/** run fn against the page's emulated board (window.__mocks, the demo's own list) */
const onFc = <R>(page: Page, fn: (m: Fc) => R): Promise<R> => page.evaluate(`(${fn.toString()})(window.__mocks.at(-1))`) as Promise<R>;
const liveMsg = (page: Page) => page.locator('.st-live > .st-msg');
const runNowDialog = async (page: Page, from: 'live' | 'saved' = 'live') => {
    if (from === 'saved') await saveMsg(page).getByRole('button', { name: 'Run now…' }).click();
    else await page.getByRole('button', { name: 'Run the program…' }).click();
    await page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await page.getByRole('button', { name: 'Run now', exact: true }).click();
};

test('N1: a battery swapped with USB connected — the old pack’s ESC frame (MSP keeps it) is never warned about, auto-opened or offered; after a turn on the new pack it is used', async () => {
    for (const freeze of ['1', 'rpm']) {
        const { page, errors } = await open(`mock=1&mockReboot=300&mockSpeed=4&mockVolts=25.2&mockEsc=sensor&mockEscFreeze=${freeze}`);
        await connect(page);
        await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
        await openLiveMore(page);
        await liveSub(page).getByText(/ESC measures 25\.\d\d V/).waitFor({ timeout: 5000 });
        if (freeze === 'rpm') {
            // unplugged while the motor turns: the frame MSP keeps has the old rpm too; then Change settings
            await onFc(page, m => m.setBattery(0));
            await page.waitForTimeout(1000);
            await openSettings(page);
        } else {
            // Change settings (the motor stops, the ESC still sends at a stop), then the pack is swapped
            await openSettings(page);
            await page.waitForTimeout(800);
            await onFc(page, m => m.setBattery(0));
            await page.waitForTimeout(1500);
        }
        await onFc(page, m => m.setBattery(21.6));
        // the board's reading has settled long before this (3 s at 4×); MSP still shows the old pack's frame
        await page.waitForTimeout(4000);
        assert.match(await page.locator('.st-live .st-meters').first().innerText(), /21\.\d\d V/, `${freeze}: the board reads the new pack`);
        assert.match(await liveSub(page).innerText(), /ESC last sent 25\.\d\d V \(old reading\)/, `${freeze}: shown as old`);
        assert.doesNotMatch(await page.locator('.st-live .st-warns').innerText(), /ESC measures/, `${freeze}: no warning from the old frame`);
        assert.equal(await moreOpen(page), false, `${freeze}: More settings did not open by itself`);
        await openMore(page);
        const cal = page.locator('.st-cal');
        assert.match(await cal.innerText(), /ESC voltage not fresh yet \(25\.\d\d V may be an old reading\)/, freeze);
        assert.equal(await cal.getByRole('button', { name: /Use the ESC’s reading/ }).count(), 0, `${freeze}: not offered`);
        assert.deepEqual(await changeKeys(page), [], 'nothing changed');
        // negative control: the motor turns on the new pack — the ESC sends again, its reading is used (and agrees)
        await runNowDialog(page);
        await page.locator('.st-state[data-state="2"], .st-state[data-state="3"]').first().waitFor({ timeout: 10000 });
        await liveSub(page).getByText(/ESC measures 21\.\d\d V/).waitFor({ timeout: 5000 });
        assert.doesNotMatch(await page.locator('.st-live .st-warns').innerText(), /ESC measures/);
        assert.deepEqual(errors, [], freeze);
        await page.close();
    }
});

test('N2: STOP while connecting is queued — never typed into a CLI left open, no false "did not reach"; a port that never answers still gives up in seconds', async () => {
    const typed = (log: string[]) => log.join('').split('$M<').length - 1;
    // control: the same board without STOP (the identification itself types a few frames into the open CLI)
    const c = await open('mock=1&mockSpeed=4&mockReboot=1500&mockCliOpen=1&mockSet=autostart_delay:0');
    await connect(c.page);
    await c.page.waitForTimeout(500);
    const control = typed(await onFc(c.page, m => m.cliLog));
    await c.page.close();
    const { page, errors } = await open('mock=1&mockSpeed=4&mockReboot=1500&mockCliOpen=1&mockSet=autostart_delay:0');
    await page.locator('.st-connect .st-primary').click();
    await page.locator('.st[data-phase="connecting"] .st-stopbar:not([hidden])').waitFor({ timeout: 3000 });
    await page.waitForTimeout(300);
    await page.locator('.st-stopbar .st-stop').click();
    await page.locator('.st-conn').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('.st-state').filter({ hasText: 'Stopped with STOP' }).waitFor({ timeout: 5000 });
    await liveMsg(page).getByText(/Stopped\. It stays stopped until you press Run the program/).waitFor({ timeout: 5000 });
    assert.equal(typed(await onFc(page, m => m.cliLog)), control, 'no STOP frame typed into the open CLI');
    assert.doesNotMatch(await page.locator('.st-live').innerText(), /did not reach the board/);
    assert.deepEqual(await onFc(page, m => m.motorOutputs().slice(0, 2)), [1000, 1000]);
    assert.deepEqual(errors, []);
    await page.close();
    // a port that never answers, STOP pressed again and again: Connect still ends in seconds and says the STOP did not get through
    const dead = await open('mock=1&mockSpeed=4&mockNoAnswer=1');
    await dead.page.locator('.st-connect .st-primary').click();
    const t0 = Date.now();
    await dead.page.locator('.st[data-phase="connecting"] .st-stopbar:not([hidden])').waitFor({ timeout: 3000 });
    while (Date.now() - t0 < 20000 && (await dead.page.locator('.st').getAttribute('data-phase')) === 'connecting') {
        await dead.page.locator('.st-stopbar .st-stop').click({ timeout: 300 }).catch(() => undefined);
        await dead.page.waitForTimeout(150);
    }
    const took = Date.now() - t0;
    assert.ok(took < 12000, `connecting lasted ${took} ms`);
    const err = await dead.page.locator('.st-error').innerText();
    assert.match(err, /STOP did not reach the board — the motor may still be running\. Unplug the battery now\./);
    assert.match(err, /doesn’t answer like a Betaflight flight controller/);
    await dead.page.close();
});

test('N2: "STOP did not reach the board" goes once a later answer shows the motor stopped (outputs 1000, held); it stays while the motor runs', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockSpeed=4');
    await connect(page);
    await page.getByRole('button', { name: 'STOP motor' }).click();
    await liveMsg(page).getByText(/Stopped\. It stays stopped until you press Run the program/).waitFor({ timeout: 5000 });
    await onFc(page, m => (m.opts.noAnswer = true));
    await page.getByRole('button', { name: 'STOP motor' }).click();
    await liveMsg(page).getByText('STOP did not reach the board — the motor may still be running. Unplug the battery now.').waitFor({ timeout: 8000 });
    // the board answers again: held, every output at 1000 — the alarm is not true any more
    await onFc(page, m => (m.opts.noAnswer = false));
    await liveMsg(page).getByText(/Stopped\. It stays stopped until you press Run the program/).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await page.locator('.st-live').innerText(), /did not reach the board/);
    await page.close();
    // negative control: the board runs (outputs above 1000) — the failure stays
    const run = await open('mock=1&mockReboot=200&mockSpeed=10');
    await connect(run.page);
    await run.page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
    await onFc(run.page, m => (m.opts.noAnswer = true));
    await run.page.getByRole('button', { name: 'STOP motor' }).click();
    await liveMsg(run.page).getByText(/STOP did not reach the board/).waitFor({ timeout: 8000 });
    await onFc(run.page, m => (m.opts.noAnswer = false));
    await run.page.locator('.st-state[data-state="3"]').waitFor({ timeout: 5000 });
    await run.page.waitForTimeout(1500);
    assert.match(await liveMsg(run.page).innerText(), /STOP did not reach the board/);
    assert.match(await run.page.locator('.st-live .st-warns').innerText(), /STOP did not reach the board/);
    await run.page.close();
});

test('N3: an edit while the board restarts after Run now (from "Saved and checked") clears the old result at once', async () => {
    const { page, errors } = await open('mock=1&mockSpeed=4&mockReboot=1500');
    await connectAndRead(page);
    await question(page, 'autostart_delay').getByText('30 s', { exact: true }).click();
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    await runNowDialog(page, 'saved');
    await page.locator('.st[data-phase="rebooting"], .st[data-phase="reconnecting"]').first().waitFor({ timeout: 5000 });
    await question(page, 'autostart_throttle').getByText('50 %', { exact: true }).click();
    assert.match((await page.locator('.st').getAttribute('data-phase')) ?? '', /rebooting|reconnecting/, 'still restarting');
    assert.equal((await saveMsg(page).innerText()).trim(), '', 'no "Saved and checked … Run now" next to "Will save"');
    assert.match(await page.locator('.st-changes').innerText(), /Will save: Power: 15 % → 50 %/);
    // negative control: without an edit a result stays through a restart
    await page.locator('.st[data-phase="ready"]').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'Undo changes' }).click();
    assert.match(await saveMsg(page).innerText(), /Changes undone/);
    await runNowDialog(page);
    await page.locator('.st[data-phase="rebooting"], .st[data-phase="reconnecting"]').first().waitFor({ timeout: 5000 });
    await page.locator('.st[data-phase="ready"]').waitFor({ timeout: 15000 });
    assert.match(await saveMsg(page).innerText(), /Changes undone/);
    assert.deepEqual(errors, []);
    await page.close();
});

test('N4: unplugged in the first moments of Change settings — "disconnected, reconnects by itself", then "The board is back", never "Press Connect"', async () => {
    for (const at of [30, 150]) {
        const { page } = await open('mock=1&mockSpeed=1&mockReboot=300&mockLatency=30');
        await connect(page);
        await page.locator('.st-preread .st-primary').click();
        await page.locator('.st[data-phase="reading"]').waitFor({ timeout: 5000 });
        await page.waitForTimeout(at);
        await onFc(page, m => m.unplug(1500));
        await page.locator('.st[data-phase="ready"]').waitFor({ timeout: 10000 });
        await page.waitForTimeout(500);
        assert.match(await page.locator('.st-preread .st-msg').innerText(), /The board is back\./, `unplug ${at} ms into the read`);
        assert.doesNotMatch(await page.locator('.st').innerText(), /The board is not connected\. Press Connect\./, `${at} ms`);
        await page.close();
    }
});

test('N5: Run the program without reading the settings — the words come from the board after the restart (Off: it did not start), never "runs from the start"', async () => {
    const off = await open('mock=1&mockSpeed=4&mockReboot=300&mockSet=autostart_mode:OFF');
    await connect(off.page);
    await runNowDialog(off.page);
    await liveMsg(off.page).getByText(/Board restarted\. The program did not start: autostart is off, waits for a button, or is held while USB is connected/).waitFor({ timeout: 10000 });
    assert.doesNotMatch(await liveMsg(off.page).innerText(), /runs from the start/);
    await off.page.close();
    // no battery: plug it in
    const nob = await open('mock=1&mockSpeed=4&mockReboot=300&mockVolts=0');
    await connect(nob.page);
    await runNowDialog(nob.page);
    await liveMsg(nob.page).getByText(/Board restarted: plug in the battery to start the program\./).waitFor({ timeout: 10000 });
    await nob.page.close();
    // negative control: the factory program (POWER, a battery) — it does run from the start
    const on = await open('mock=1&mockSpeed=4&mockReboot=300');
    await connect(on.page);
    await runNowDialog(on.page);
    await liveMsg(on.page).getByText(/Board restarted: the program runs from the start\./).waitFor({ timeout: 10000 });
    await on.page.close();
});

test('N6: "Battery low" from a wrong cell count (8S saved, a charged 6S pack) points to the cell count, not to charging; an empty pack still says charge', async () => {
    const { page } = await open('mock=1&mockSpeed=4&mockReboot=300&mockSet=autostart_cells:8');
    await connect(page);
    await page.locator('.st-state[data-state="5"]').waitFor({ timeout: 10000 });
    const sub = page.locator('.st-state-sub');
    await sub.getByText(/Stopped for low battery at 24\.4 V\. If this is a charged 6S pack \(4\.07 V per cell\), the cell count or stop voltage saved on the board does not fit it: press Change settings and check Battery\. Otherwise the pack is empty: charge it\./).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await sub.innerText(), /Charge the battery/);
    await openSettings(page);
    await sub.getByText(/Stopped for low battery at 24\.4 V\. The board counts 8S\. If your pack is 6S \(4\.07 V per cell, charged\): set Battery to 6S in step 3 and save\. If it really is 8S: it is empty, charge it\./).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await sub.innerText(), /Charge the battery|will not help/);
    await page.close();
    // regression (final recheck 20.10): an EMPTY 6S at 19.5 V reads 3.90 V per cell for Betaflight's 5S guess.
    // Voltage alone cannot tell an empty 6S from a charged 5S: both readings are offered, never "charging will not help"
    const empty = await open('mock=1&mockSpeed=4&mockReboot=300&mockVolts=19.5&mockSet=autostart_cells:6');
    await connect(empty.page);
    await empty.page.locator('.st-state[data-state="5"]').waitFor({ timeout: 10000 });
    await openSettings(empty.page);
    const esub = empty.page.locator('.st-state-sub');
    await esub.getByText(/If it really is 6S: it is empty, charge it\./).waitFor({ timeout: 5000 });
    assert.doesNotMatch(await esub.innerText(), /will not help/);
    await empty.page.close();
    // negative control: an empty 6S pack (19.0 V, Betaflight guesses 5S at 3.80 V per cell) — charging is the advice
    const low = await open('mock=1&mockSpeed=4&mockReboot=300&mockVolts=19.0');
    await connect(low.page);
    await low.page.locator('.st-state[data-state="5"]').waitFor({ timeout: 10000 });
    assert.match(await low.page.locator('.st-state-sub').innerText(), /^Charge the battery, then plug it in again\.$/);
    await openSettings(low.page);
    await low.page.locator('.st-state-sub').getByText(/^Charge the battery, then switch the board off and on/).waitFor({ timeout: 5000 });
    await low.page.close();
});
