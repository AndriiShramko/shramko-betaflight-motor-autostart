// Browser test of the tool UI against the emulated board (?mock=1), in real Chrome via Playwright.
// Success path + negative controls: the board refuses a value; the board never comes back after saving.

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

const open = async (query: string, viewport = { width: 1280, height: 900 }) => {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
        if (m.type() === 'error') errors.push(m.text());
    });
    await page.goto(`${base}?${query}`);
    await page.getByRole('button', { name: 'Connect', exact: true }).waitFor();
    return { page, errors };
};

const connectAndRead = async (page: Page) => {
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.st-status', { hasText: 'Connected.' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Read settings' }).click();
    await page.locator('.st-form').waitFor({ state: 'visible', timeout: 15000 });
};

test('connect, read, edit 3 values, save → "Saved and verified"', async () => {
    const { page, errors } = await open('mock=1&mockReboot=300');
    await connectAndRead(page);
    assert.equal(await page.locator('.st-facts').getByText('HGLRC_F405_S8').count(), 1);
    assert.ok(await page.getByRole('button', { name: 'STOP motor' }).isVisible());
    assert.ok(await page.getByRole('button', { name: 'Save to board' }).isDisabled(), 'Save is disabled until something changes');

    await page.getByLabel('Delay before the ramp').fill('12');
    await page.getByLabel('Delay before the ramp').press('Tab');
    await page.locator('label.st-preset', { hasText: 'Gusts' }).click();
    await page.getByLabel('Cut-off voltage per cell').fill('3,4');
    await page.getByLabel('Cut-off voltage per cell').press('Tab');
    assert.match(await page.locator('.st-actions').innerText(), /Changed: \d+/);
    assert.match(await page.locator('[data-name="autostart_cell_cutoff"]').innerText(), /20[.,]4 V for a 6S pack/);

    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    const msg = await page.locator('.st-msg[data-result="saved"]').innerText();
    assert.match(msg, /Saved and verified: \d+ values/);
    // the form now shows the board's values
    assert.equal(await page.getByLabel('Delay before the ramp').inputValue(), '12');
    assert.ok(await page.getByRole('button', { name: 'Save to board' }).isDisabled());
    assert.deepEqual(errors, []);
    await page.close();
});

test('foolproof input: out of range is clamped with a note, nothing invalid reaches the board', async () => {
    const { page } = await open('mock=1&mockReboot=200');
    await connectAndRead(page);
    const delay = page.getByLabel('Delay before the ramp');
    await delay.fill('9999');
    await delay.press('Tab');
    assert.equal(await delay.inputValue(), '600');
    assert.match(await page.locator('[data-name="autostart_delay"] .st-fnote').innerText(), /allowed 0–600/);
    await delay.fill('abc');
    await delay.press('Tab');
    assert.match(await delay.inputValue(), /^\d+$/);
    await page.close();
});

test('negative control: the board answers "Invalid value" → an error, never "Saved and verified"', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockInvalid=autostart_delay');
    await connectAndRead(page);
    await page.getByLabel('Delay before the ramp').fill('15');
    await page.getByLabel('Delay before the ramp').press('Tab');
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="error"]').waitFor({ timeout: 15000 });
    const text = await page.locator('.st-settings').innerText();
    assert.match(text, /The board refused autostart_delay = 15\. Nothing was saved\./);
    assert.doesNotMatch(text, /Saved and verified/);
    // still connected and usable
    await page.locator('.st-status', { hasText: 'Connected.' }).waitFor();
    await page.close();
});

test('negative control: the board never comes back after saving → a clear timeout message', async () => {
    const { page } = await open('mock=1&mockNoReturn=1&mockReconnectTimeout=1500');
    await connectAndRead(page);
    await page.getByLabel('Delay before the ramp').fill('20');
    await page.getByLabel('Delay before the ramp').press('Tab');
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="error"]').waitFor({ timeout: 15000 });
    const text = await page.locator('.st-settings').innerText();
    assert.match(text, /did not come back after restarting/);
    assert.doesNotMatch(text, /Saved and verified/);
    assert.match(await page.locator('.st-status').innerText(), /Plug it back in/);
    await page.close();
});

test('live view moves, STOP and restart with the propeller confirmation', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockSpeed=10');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.st-state[data-state="3"]').waitFor({ timeout: 10000 });
    assert.match(await page.locator('.st-live').innerText(), /15 %/);
    await page.getByRole('button', { name: 'STOP motor' }).click();
    await page.getByText('Stop sent').waitFor();
    await page.locator('.st-state[data-state="0"]').waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Restart program…' }).click();
    const confirm = page.getByRole('button', { name: 'Restart now' });
    assert.ok(await confirm.isDisabled(), 'restart needs the propeller confirmation');
    await page.getByLabel('The propeller is off, or nothing and nobody is near it.').check();
    await confirm.click();
    await page.getByText('Board restarted.').waitFor({ timeout: 10000 });
    await page.close();
});

test('miscalibrated board: the live view says so, the helper computes vbat_scale and it is saved and verified', async () => {
    const { page } = await open('mock=1&mockReboot=200&mockScale=120');
    await connectAndRead(page);
    await page.getByText('the voltage looks wrong for 6S').waitFor({ timeout: 5000 });
    await page.getByLabel('Your multimeter shows').fill('24,4');
    await page.getByRole('button', { name: 'Use this reading' }).click();
    assert.match(await page.locator('.st-cal').innerText(), /New scale 210 \(was 120\)/);
    await page.getByRole('button', { name: 'Save to board' }).click();
    await page.locator('.st-msg[data-result="saved"]').waitFor({ timeout: 20000 });
    await page.locator('.st-live').getByText('24.40 V', { exact: true }).waitFor({ timeout: 5000 });
    await page.close();
});

test('375 px wide: no horizontal scroll, STOP visible, Connect usable (English and the longest locale, Russian)', async () => {
    const { page, errors } = await open('mock=1&mockReboot=200', { width: 375, height: 740 });
    await connectAndRead(page);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 375, `page is ${w}px wide`);
    assert.ok(await page.getByRole('button', { name: 'STOP motor' }).isVisible());
    assert.deepEqual(errors, []);
    await page.close();
    const ru = await browser.newPage({ viewport: { width: 375, height: 740 } });
    await ru.goto(`${base}?mock=1&mockReboot=200&lang=ru`);
    await ru.getByRole('button', { name: 'Подключить', exact: true }).click();
    await ru.locator('.st-status', { hasText: 'Подключено.' }).waitFor({ timeout: 10000 });
    await ru.getByRole('button', { name: 'Прочитать настройки' }).click();
    await ru.locator('.st-form').waitFor({ state: 'visible', timeout: 15000 });
    await ru.locator('.st-adv summary').click();
    const wr = await ru.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(wr <= 375, `ru page is ${wr}px wide`);
    await ru.close();
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
    const { page } = await (async () => {
        const p = await browser.newPage();
        await p.goto(`${base}?mock=1&lang=pl`);
        return { page: p };
    })();
    await page.locator('.st-connect h3').waitFor();
    const h = await page.locator('.st-connect h3').innerText();
    assert.notEqual(h, 'Connect your flight controller');
    await page.close();
});
