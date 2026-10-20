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
    assert.match((await page.locator('.st-stopstate').textContent()) ?? '', /Paused while settings are open · 0 %/);
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
    const { page, errors } = await open('mock=1&mockReboot=150&mockFw=1.0&mockScale=180');
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
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page.waitForFunction(() => !(window as unknown as { __board: { connected: boolean }[] }).__board.at(-1)!.connected);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('sma-connected')), false);
    assert.equal(await page.evaluate(() => document.body.style.paddingBottom), '');
    assert.match(await page.locator('.st-status').innerText(), /Disconnected\. The board keeps its program/);
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
    const { page } = await open('mock=1&mockReboot=200&mockScale=120');
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
