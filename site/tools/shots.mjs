// Screenshots + click checks of a built site (desktop 1440 and phone 375), for review before a hand-off.
//   node tools/shots.mjs <distDir> <outDir> [--base https://autostart.flyreelstudio.eu]
// Without --base it serves <distDir> itself (/api/* answers 204, /go/* answers 302 to "#go-<slug>"),
// or, with SMA_API=http://127.0.0.1:<port>, proxies /api/* and /go/* to a real local api/server.py.
// Checks: page errors and console errors, horizontal overflow, closed dialogs not visible, every
// external link opens in a new tab, the language switch, the Feedback dialog, the configurator mount,
// and the error banner both ways (a foreign script's error: no banner; ours: banner).
// The page of docs/wip/simplify-spec.md: section order = task order, the hero buttons on the first phone
// screen, folds closed by default and the JSON-LD matching the visible FAQ and install steps, the phone
// menu (link click, Esc), #hash links into folded content, Copy while the prompt is folded, and with the
// emulated board (?mock=1): the "Found on your board" badge, Feedback's own STOP, the Feedback button and
// the consent bar above the configurator's STOP bar (and back down after Disconnect).
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
    // SMA_API=http://127.0.0.1:8099: /api/* and /go/* go to a real local API (python api/server.py)
    const api = process.env.SMA_API ? new URL(process.env.SMA_API) : null;
    server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (api && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/go/'))) {
            const up = http.request({ host: api.hostname, port: api.port, path: req.url, method: req.method, headers: { ...req.headers, 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' } }, (r) => {
                res.writeHead(r.statusCode ?? 502, r.headers);
                r.pipe(res);
            });
            up.on('error', () => { res.writeHead(502); res.end(); });
            return req.pipe(up);
        }
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
const SECTION_ORDER = 'install tool wiring safety how support faq agent contact privacy';
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
        // DPR 1: Chrome repeats full-page shots taller than 16384 device pixels
        const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, isMobile: !!vp.mobile, hasTouch: !!vp.mobile, locale: lang });
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
        // page order = task order; nothing folded is open on arrival; JSON-LD = what the page shows
        const order = await page.evaluate(() => [...document.querySelectorAll('main > section[id]')].map((s) => s.id).join(' '));
        if (order !== SECTION_ORDER) fail(`${name}: section order "${order}", want "${SECTION_ORDER}"`);
        const openFolds = await page.evaluate(() => [...document.querySelectorAll('main details[open]')].map((d) => d.id || d.className));
        if (openFolds.length) fail(`${name}: open on arrival: ${openFolds.join(', ')}`);
        const ld = await page.evaluate(() => {
            const all = JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent);
            const norm = (s) => s.replace(/\s+/g, ' ').trim();
            const faq = all.find((x) => x['@type'] === 'FAQPage').mainEntity.map((q) => norm(q.name));
            const how = all.find((x) => x['@type'] === 'HowTo').step.map((s) => norm(s.name));
            return {
                faq, how,
                faqShown: [...document.querySelectorAll('#faq details > summary')].map((s) => norm(s.textContent)),
                howShown: [...document.querySelectorAll('#install .steps > li > h3')].map((h) => norm(h.textContent))
            };
        });
        if (JSON.stringify(ld.faq) !== JSON.stringify(ld.faqShown)) fail(`${name}: FAQPage JSON-LD (${ld.faq.length}) differs from the visible FAQ (${ld.faqShown.length})`);
        if (JSON.stringify(ld.how) !== JSON.stringify(ld.howShown)) fail(`${name}: HowTo JSON-LD ${JSON.stringify(ld.how)} differs from the visible steps ${JSON.stringify(ld.howShown)}`);
        if (vp.mobile) {
            // both hero buttons on the first phone screen (the chart comes after them)
            const ctaBottom = await page.evaluate(() => document.querySelector('.cta-row').getBoundingClientRect().bottom);
            if (ctaBottom > vp.h) fail(`${name}: hero buttons end at ${Math.round(ctaBottom)} px, below the first screen (${vp.h})`);
            else notes.push(`${name}: hero buttons end at ${Math.round(ctaBottom)} px of ${vp.h}`);
        }
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
    const fbStatus = (await page.locator('#fb .form-status').textContent())?.trim() ?? '';
    if (process.env.SMA_API && !/R-\d{8}-\d{4}/.test(fbStatus)) fail(`feedback through the real API: no report id in "${fbStatus}"`);
    notes.push(`feedback send (${process.env.SMA_API ? 'real local API' : 'static stub, no JSON'}): status "${fbStatus}"`);
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

// smooth scrolling over a long phone page takes more than a second: wait until the page stops moving
const settle = async (page) => {
    let last = -1;
    for (let still = 0, i = 0; still < 3 && i < 40; i++) {
        await page.waitForTimeout(150);
        const y = await page.evaluate(() => scrollY);
        still = y === last ? still + 1 : 0;
        last = y;
    }
};

// ---- the phone menu: opens, 44 px links, closes on a link click (and lands there) and on Esc (focus back)
{
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page, 'menu');
    await page.goto(`${base}/en/`, { waitUntil: 'networkidle' });
    if (await page.locator('header .nav').isVisible()) fail('menu: the desktop nav is visible at 375 px');
    const summary = page.locator('header details.menu > summary');
    await summary.click();
    const links = page.locator('header .menu-nav a');
    if (!(await links.first().isVisible())) fail('menu: does not open');
    const sizes = await links.evaluateAll((as) => as.map((a) => [a.textContent, Math.round(a.getBoundingClientRect().height)]));
    if (sizes.length !== 8 || sizes.some(([, hgt]) => hgt < 44)) fail(`menu: links ${JSON.stringify(sizes)}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (wide > 1) fail(`menu: open menu makes the page ${wide}px wider`);
    await page.screenshot({ path: join(outDir, 'menu-open-375.png') });
    await page.keyboard.press('Escape');
    const esc = await page.evaluate(() => ({ open: document.querySelector('details.menu').open, focus: document.activeElement?.matches('details.menu > summary') }));
    if (esc.open || !esc.focus) fail(`menu: Esc ${JSON.stringify(esc)}`);
    await summary.click();
    await page.locator('header .menu-nav a[href="#faq"]').click();
    await settle(page);
    const landed = await page.evaluate(() => ({ open: document.querySelector('details.menu').open, top: Math.round(document.getElementById('faq').getBoundingClientRect().top) }));
    if (landed.open || landed.top < -2 || landed.top > 120) fail(`menu: FAQ link ${JSON.stringify(landed)}`);
    else notes.push(`menu: 8 links of ≥44 px, Esc closes and refocuses, FAQ link closes it and lands at ${landed.top} px`);
    // desktop: no menu button, the nav is there
    await page.setViewportSize({ width: 1440, height: 900 });
    if (await summary.isVisible() || !(await page.locator('header .nav').isVisible())) fail('menu: wrong header at 1440 px');
    await ctx.close();
}

// ---- the sticky header stays one row (its nav moves into the Menu when it would wrap) and a nav jump lands
// below it; a phone held sideways lets the header scroll away; the contact form says nothing before it is used
{
    const ctx = await browser.newContext({ viewport: { width: 800, height: 900 } });
    const page = await ctx.newPage();
    watch(page, 'header');
    const seen = [];
    for (const [lang, w, h] of [['en', 800, 900], ['en', 1024, 768], ['ru', 1024, 768], ['ru', 1280, 800], ['en', 1440, 900], ['ru', 812, 375]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(`${base}/${lang}/`, { waitUntil: 'networkidle' });
        const hd = await page.evaluate(() => {
            const t = document.querySelector('header.top');
            return { sticky: getComputedStyle(t).position === 'sticky', h: Math.round(t.getBoundingClientRect().height), nav: getComputedStyle(t.querySelector('.nav')).display !== 'none' };
        });
        if (hd.sticky && hd.h > 70) fail(`header ${lang} ${w}: the sticky header wraps to ${hd.h} px`);
        if (w >= 1366 && !hd.nav) fail(`header ${lang} ${w}: the nav went into the Menu although it fits`);
        if (h < 500 && hd.sticky) fail(`header ${lang} ${w}×${h}: sticky on a phone held sideways`);
        const link = hd.nav ? page.locator('header .nav a[href="#install"]') : page.locator('header .menu-nav a[href="#install"]');
        if (!hd.nav) await page.locator('header details.menu > summary').click();
        await link.click();
        await settle(page);
        const r = await page.evaluate(() => ({ top: Math.round(document.querySelector('#install h2').getBoundingClientRect().top), under: getComputedStyle(document.querySelector('header.top')).position === 'sticky' ? Math.round(document.querySelector('header.top').getBoundingClientRect().bottom) : 0 }));
        if (r.top < r.under) fail(`header ${lang} ${w}: the #install heading lands under the header (${r.top} < ${r.under})`);
        seen.push(`${lang} ${w}: ${hd.h} px${hd.nav ? '' : ' (Menu)'}${hd.sticky ? '' : ' scrolls away'}, #install at ${r.top}`);
    }
    notes.push(`header: ${seen.join('; ')}`);
    const said = await page.evaluate(() => document.querySelector('#lead .form-status').textContent.trim());
    if (said) fail(`contact form: the status region speaks before the form is used: "${said}"`);
    await ctx.close();
}

// ---- #hash into folded content opens it (load, hashchange, in-page click); Copy works while folded
{
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const page = await ctx.newPage();
    watch(page, 'hash');
    const state = (id) => page.evaluate((i) => {
        const el = document.getElementById(i);
        const r = el.getBoundingClientRect();
        return { open: !!el.closest('details')?.open, inView: r.top >= -2 && r.top < innerHeight - 40 };
    }, id);
    for (const [path, id] of [['/en/#faq-9', 'faq-9'], ['/ru/#install-dfu', 'install-dfu'], ['/pl/#how-tech', 'how-tech']]) {
        await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
        await settle(page);
        const s = await state(id);
        if (!s.open || !s.inView) fail(`hash ${path}: ${JSON.stringify(s)}`);
    }
    await page.goto(`${base}/en/`, { waitUntil: 'networkidle' });
    // Copy copies the folded prompt and leaves it folded
    const prompt = await page.evaluate(() => document.getElementById('agent-prompt').textContent);
    await page.locator('#agent button[data-copy]').click();
    const copied = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n');
    if (copied !== prompt || !prompt.includes('Shramko Motor Autostart')) fail('copy: the folded prompt was not copied');
    if (await page.evaluate(() => document.getElementById('agent-show').open)) fail('copy: opened the prompt');
    // an edited address (hashchange) into the folded prompt
    await page.evaluate(() => { location.hash = '#agent-prompt'; });
    await settle(page);
    const s1 = await state('agent-prompt');
    if (!s1.open || !s1.inView) fail(`hashchange #agent-prompt: ${JSON.stringify(s1)}`);
    // an in-page link to a fold (the page has none of its own yet: a test link is added)
    await page.evaluate(() => {
        const a = Object.assign(document.createElement('a'), { href: '#faq-2', textContent: 'test link', id: 'test-link' });
        document.querySelector('#how').prepend(a);
    });
    await page.locator('#test-link').click();
    await settle(page);
    const s2 = await state('faq-2');
    if (!s2.open || !s2.inView) fail(`in-page link #faq-2: ${JSON.stringify(s2)}`);
    // negative control: the other FAQ answers stayed closed
    const others = await page.evaluate(() => [...document.querySelectorAll('#faq details[open]')].map((d) => d.id));
    if (others.join() !== 'faq-2') fail(`hash: other folds opened too: ${others.join()}`);
    else notes.push('hash: #faq-9 / #install-dfu / #how-tech on load, #agent-prompt by hashchange, #faq-2 by click open their fold and scroll there; nothing else opens; Copy copies the folded prompt');
    await ctx.close();
}

// ---- with the emulated board: badge, Feedback's own STOP, floating parts above the STOP bar
const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
for (const [lang, vp] of [['en', { width: 375, height: 812, mobile: true }], ['ru', { width: 375, height: 812, mobile: true }], ['en', { width: 1440, height: 900 }]]) {
    const name = `board-${lang}-${vp.width}`;
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
    const page = await ctx.newPage();
    watch(page, name);
    await page.goto(`${base}/${lang}/?mock=1&mockSpeed=4`, { waitUntil: 'networkidle' });
    const rects = () => page.evaluate(() => {
        const r = (sel) => {
            const el = document.querySelector(sel);
            if (!el || el.hidden || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return null;
            const b = el.getBoundingClientRect();
            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        };
        return { fab: r('#fb-open'), bar: r('.st-stopbar'), consent: r('#consent') };
    });
    if (!(await page.locator('[data-fw-found]').isHidden()) || !(await page.locator('#fb-stop').isHidden())) fail(`${name}: badge or Feedback STOP shown before Connect`);
    const fabBefore = (await rects()).fab;
    await page.locator('#tool .st-connect .st-primary').click();
    await page.locator('html.sma-connected').waitFor({ timeout: 10000 });
    await page.locator('[data-fw-found]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail(`${name}: no "Found on your board" badge`));
    await page.locator('#tool .st-state[data-state="3"]').waitFor({ timeout: 15000 }).catch(() => fail(`${name}: the emulated motor never ran`));
    // the consent bar (shown only with a GA id) is forced on to check its place too
    await page.evaluate(() => { document.getElementById('consent').hidden = false; });
    await page.locator('#tool-settings').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const r = await rects();
    if (!r.bar || !r.fab) fail(`${name}: STOP bar ${!!r.bar}, Feedback button ${!!r.fab}`);
    if (overlap(r.fab, r.bar)) fail(`${name}: the Feedback button covers the STOP bar`);
    if (overlap(r.consent, r.bar)) fail(`${name}: the consent bar covers the STOP bar`);
    if (vp.mobile && overlap(r.consent, r.fab)) fail(`${name}: the consent bar covers the Feedback button`);
    await page.screenshot({ path: join(outDir, `${name}-connected.png`) });
    await page.evaluate(() => { document.getElementById('consent').hidden = true; });
    // Feedback is modal (the STOP bar is inert behind it): its own STOP stops the motor
    await page.locator('#fb-open').click();
    const fbStop = page.locator('#fb[open] #fb-stop');
    if (!(await fbStop.isVisible())) fail(`${name}: no STOP inside Feedback while connected`);
    else {
        const box = await fbStop.boundingBox();
        if (box.height < 44 || box.width < 44) fail(`${name}: Feedback STOP is ${Math.round(box.width)}×${Math.round(box.height)} px`);
        await page.screenshot({ path: join(outDir, `${name}-feedback-stop.png`) });
        await fbStop.click();
        await page.locator('#tool .st-state[data-state="0"]').waitFor({ timeout: 5000 }).catch(() => fail(`${name}: Feedback STOP did not stop the motor`));
        const said = (await page.locator('#fb .form-status').textContent())?.trim();
        if (!said) fail(`${name}: Feedback STOP gives no feedback`);
    }
    await page.locator('#fb-close').click();
    // keyboard through Step 3 with More settings open: no focused control comes to rest under the STOP bar
    // or the Feedback button (WCAG 2.4.11); the page reserves the room (html.sma-connected scroll-padding)
    await page.locator('#tool .st-preread .st-primary').click();
    await page.locator('#tool .st-form').waitFor({ state: 'visible', timeout: 15000 });
    if (!(await page.evaluate(() => document.getElementById('tool-more').open))) await page.locator('#tool-more > summary').click();
    // Random gusts on: the 6 gust fields lay out inside their box (they once collapsed beside the floated legend)
    await page.locator('fieldset[data-name=autostart_pattern] label', { has: page.locator('input[value="GUSTS"]') }).click();
    await page.waitForTimeout(300);
    const gusts = await page.evaluate(() => ({
        grid: Math.round(document.querySelector('#tool-more-gusts .st-grid').getBoundingClientRect().width),
        box: Math.round(document.getElementById('tool-more-gusts').getBoundingClientRect().width),
        wide: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    if (gusts.grid < gusts.box * 0.6 || gusts.wide > 1) fail(`${name}: Gust details with gusts on: ${JSON.stringify(gusts)}`);
    await page.locator('#tool-settings h3').first().evaluate((h) => { h.setAttribute('tabindex', '-1'); h.focus(); });
    const hiddenFocus = [];
    let tabs = 0;
    for (; tabs < 120; tabs++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(350); // smooth scrolling: judge where the control comes to rest
        const s = await page.evaluate(() => {
            const a = document.activeElement;
            if (!a || !document.getElementById('tool').contains(a)) return null;
            const r = a.getBoundingClientRect();
            const under = (sel) => {
                const el = document.querySelector(sel);
                if (!el || el.hidden || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.contains(a)) return false;
                const b = el.getBoundingClientRect();
                return r.left < b.right && b.left < r.right && r.top < b.bottom && b.top < r.bottom;
            };
            return { what: `${a.tagName.toLowerCase()} [${a.closest('[data-name]')?.dataset.name ?? ''}]`, stop: under('.st-stopbar'), fab: under('#fb-open') };
        });
        if (!s) break;
        if (s.stop || s.fab) hiddenFocus.push(`${s.what}${s.stop ? ' under STOP' : ''}${s.fab ? ' under Feedback' : ''}`);
    }
    if (tabs < 10) fail(`${name}: the keyboard walk reached only ${tabs} controls`);
    if (hiddenFocus.length) fail(`${name}: focused controls hidden: ${hiddenFocus.join('; ')}`);
    else notes.push(`${name}: ${tabs} focused controls in Step 3 (More settings open), none under STOP or Feedback`);
    // Disconnect: badge, Feedback STOP and the lifted Feedback button go back
    await page.locator('#tool .st-connrow .st-ghost').click();
    await page.waitForFunction(() => !document.documentElement.classList.contains('sma-connected'), null, { timeout: 5000 });
    const after = await page.evaluate(() => ({ badge: document.querySelector('[data-fw-found]').hidden, stop: document.getElementById('fb-stop').hidden }));
    const fabAfter = (await rects()).fab;
    if (!after.badge || !after.stop) fail(`${name}: after Disconnect ${JSON.stringify(after)}`);
    if (fabBefore && fabAfter && Math.abs(fabBefore.bottom - fabAfter.bottom) > 1) fail(`${name}: the Feedback button did not come back down (${fabBefore.bottom} → ${fabAfter.bottom})`);
    else notes.push(`${name}: badge shown, Feedback/consent above the STOP bar, Feedback's STOP stops the motor, all back after Disconnect`);
    await ctx.close();
}
// negative control: a stock Betaflight board is connected but has no module, so no badge
{
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    watch(page, 'board-stock');
    await page.goto(`${base}/en/?mock=1&mockFw=stock`, { waitUntil: 'networkidle' });
    await page.locator('#tool .st-connect .st-primary').click();
    await page.locator('html.sma-connected').waitFor({ timeout: 10000 });
    await page.waitForTimeout(1500);
    if (!(await page.locator('[data-fw-found]').isHidden())) fail('board-stock: "Found on your board" shown for a stock board');
    else notes.push('board-stock: no badge for a board without the module (negative control)');
    await ctx.close();
}

await browser.close();
server?.close();
console.log(notes.map((n) => `note: ${n}`).join('\n'));
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}` : 'OK: no page/console errors, no overflow, no visible closed dialogs, links open in new tabs, clicks work');
console.log(`screenshots: ${outDir}`);
process.exit(problems.length ? 1 : 0);
