// Screenshots + click checks of a built site (desktop 1440 and phone 375), for review before a hand-off.
//   node tools/shots.mjs <distDir> <outDir> [--base https://autostart.flyreelstudio.eu]
// Without --base it serves <distDir> itself (/api/* answers 204, /go/* answers 302 to "#go-<slug>").
// Checks: page errors and console errors, horizontal overflow, closed dialogs not visible, every
// external link opens in a new tab, the language switch, the Feedback dialog, the configurator mount,
// and the error banner both ways (a foreign script's error: no banner; ours: banner).
// Exit code 1 when a check fails.

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const baseArg = args.includes('--base') ? args[args.indexOf('--base') + 1] : '';
const [distArg, outArg] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base');
const dist = resolve(distArg ?? 'dist');
const outDir = resolve(outArg ?? 'docs/wip/shots');
mkdirSync(outDir, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.map': 'application/json' };
let server = null;
let base = baseArg;
if (!base) {
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname.startsWith('/api/')) { res.writeHead(204); return res.end(); }
        if (url.pathname.startsWith('/go/')) { res.writeHead(302, { location: `/en/#go-${url.pathname.slice(4)}` }); return res.end(); }
        let p = join(dist, decodeURIComponent(url.pathname));
        if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
        if (!existsSync(p)) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
        createReadStream(p).pipe(res);
    }).listen(5190);
    base = 'http://localhost:5190';
}

const problems = [];
const notes = [];
const fail = (s) => problems.push(s);
const EXPECTED_MISSING = /\/img\/wiring-(en|es|pl|ru)\.svg$/; // the lead adds the diagrams

const browser = await chromium.launch({ channel: 'chrome' });
const watch = (page, name) => {
    page.on('pageerror', (e) => fail(`${name}: pageerror ${e.message}`));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const loc = m.location()?.url ?? '';
        if (/404/.test(m.text()) && EXPECTED_MISSING.test(loc)) return;
        fail(`${name}: console ${m.text().substring(0, 200)} ${loc}`);
    });
    page.on('response', (r) => {
        if (r.status() >= 400 && EXPECTED_MISSING.test(new URL(r.url()).pathname)) notes.push(`${name}: ${new URL(r.url()).pathname} ${r.status()} (expected until the lead adds it)`);
        else if (r.status() >= 400) fail(`${name}: ${r.status()} ${r.url()}`);
    });
};

// ---- full-page screenshots
for (const lang of ['en', 'ru', 'es', 'pl']) {
    for (const vp of [{ w: 1440, h: 900 }, { w: 375, h: 812, mobile: true }]) {
        if ((lang === 'es' || lang === 'pl') && !vp.mobile) continue; // es/pl: phone only (longest words)
        const name = `${lang}-${vp.w}`;
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.mobile ? 2 : 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile, locale: lang });
        const page = await ctx.newPage();
        watch(page, name);
        await page.goto(`${base}/${lang}/`, { waitUntil: 'networkidle' });
        await page.evaluate(() => document.querySelectorAll('img[loading=lazy]').forEach((i) => { i.loading = 'eager'; }));
        await page.waitForLoadState('networkidle');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) fail(`${name}: horizontal overflow ${overflow}px`);
        const visibleClosed = await page.evaluate(() => [...document.querySelectorAll('dialog:not([open]), [hidden]')].filter((e) => e.getClientRects().length > 0).map((e) => e.id || e.tagName));
        if (visibleClosed.length) fail(`${name}: closed/hidden elements visible: ${visibleClosed.join(', ')}`);
        const badLinks = await page.evaluate(() => [...document.querySelectorAll('a[href]')].filter((a) => {
            const h = a.getAttribute('href');
            return /^(https?:|\/go\/)/.test(h) && !(a.target === '_blank' && /noopener/.test(a.rel));
        }).map((a) => a.getAttribute('href')));
        if (badLinks.length) fail(`${name}: links leaving the site without a new tab: ${badLinks.join(' ')}`);
        const mounted = await page.locator('#tool [data-tool-fallback]').count();
        if (mounted) fail(`${name}: the configurator did not mount (fallback still there)`);
        await page.screenshot({ path: join(outDir, `${name}-full.png`), fullPage: true });
        await page.screenshot({ path: join(outDir, `${name}-top.png`) });
        await ctx.close();
    }
}

// ---- clicks: language switch, Feedback dialog, error banner (desktop, English)
{
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    watch(page, 'clicks');
    await page.goto(`${base}/en/`, { waitUntil: 'networkidle' });

    for (const [sel, want] of [['header .langs a[data-lang=ru]', 'ru'], ['header .langs a[data-lang=pl]', 'pl'], ['header .langs a[data-lang=es]', 'es'], ['footer .langs a[data-lang=en]', 'en']]) {
        await page.click(sel);
        await page.waitForLoadState('networkidle');
        const got = await page.evaluate(() => ({ lang: document.documentElement.lang, path: location.pathname, stored: localStorage.getItem('sma_lang'), cookie: document.cookie }));
        if (got.lang !== want || got.path !== `/${want}/` || got.stored !== want || !got.cookie.includes(`sma_lang=${want}`)) fail(`lang switch to ${want}: ${JSON.stringify(got)}`);
        else notes.push(`lang switch -> ${want}: page ${got.path}, remembered (localStorage + cookie)`);
    }

    await page.click('#fb-open');
    if (!(await page.locator('#fb').isVisible())) fail('feedback: dialog did not open');
    await page.screenshot({ path: join(outDir, 'feedback-open.png') });
    await page.click('#fb .tabs input[value=coop] + span');
    if (!(await page.locator('#fb .fb-coop').isVisible()) || (await page.locator('#fb .fb-msg').isVisible())) fail('feedback: Collaboration tab does not switch');
    await page.click('#fb .tabs input[value=bug] + span');
    await page.click('#fb-send');
    const empty = await page.locator('#fb .form-status').textContent();
    if (!empty?.trim()) fail('feedback: empty message gives no hint');
    await page.fill('#fb textarea[name=message]', 'shots.mjs test message');
    await page.click('#fb-send');
    await page.waitForFunction(() => /R-|number|Thank/i.test(document.querySelector('#fb .form-status')?.textContent ?? '') || /didn't work/.test(document.querySelector('#fb .form-status')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => undefined);
    notes.push(`feedback send (static server answers 204, no JSON): status "${(await page.locator('#fb .form-status').textContent())?.trim()}"`);
    await page.click('#fb-close');
    if (await page.locator('#fb').isVisible()) fail('feedback: dialog did not close');

    // error banner: a foreign script's error must not show it, ours must
    await page.evaluate(() => {
        dispatchEvent(new ErrorEvent('error', { message: 'Uncaught TypeError: x is not a function', filename: 'https://cdn.example.com/widget.js', lineno: 1, error: Object.assign(new TypeError('x is not a function'), { stack: 'TypeError: x\n    at https://cdn.example.com/widget.js:1:5' }) }));
        dispatchEvent(new ErrorEvent('error', { message: 'Uncaught AbortError: Transition was aborted because of invalid state', filename: `${location.origin}/assets/main.js`, lineno: 1 }));
        dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.', filename: '', lineno: 0 }));
    });
    if (await page.locator('#site-error').isVisible()) fail('error banner: shown for a foreign / noise error');
    else notes.push('error banner: foreign script error, aborted transition, ResizeObserver -> no banner (correct)');
    await page.evaluate(() => {
        dispatchEvent(new ErrorEvent('error', { message: 'Uncaught Error: own bug', filename: `${location.origin}/assets/main-abc.js`, lineno: 3, error: new Error('own bug') }));
    });
    if (!(await page.locator('#site-error').isVisible())) fail('error banner: NOT shown for an error of our bundle');
    else {
        notes.push('error banner: error from /assets/ -> banner shown (correct)');
        await page.screenshot({ path: join(outDir, 'error-banner.png') });
        await page.click('#site-error-report');
        const prefill = await page.locator('#fb textarea[name=message]').inputValue();
        if (!(await page.locator('#fb').isVisible()) || !prefill.includes('own bug')) fail(`error banner: "Send a report" did not open a prefilled dialog (${prefill})`);
        await page.click('#fb-close');
    }
    await ctx.close();
}

await browser.close();
server?.close();
console.log(notes.map((n) => `note: ${n}`).join('\n'));
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}` : 'OK: no page/console errors, no overflow, no visible closed dialogs, links open in new tabs, clicks work');
console.log(`screenshots: ${outDir}`);
process.exit(problems.length ? 1 : 0);
