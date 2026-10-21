// Generates one fully translated, crawlable HTML page per language from web/template.html and
// web/src/i18n/<lang>.json, merged with the configurator's own strings web/src/i18n/tool.<lang>.json
// when that file exists (missing keys fall back to English). Vite then builds each page as an entry.
//
//   node web/scripts/gen-pages.mjs
//
// Keys ending in "_html" hold trusted HTML (lists, <code>, <strong>, links); every other value is
// escaped. Links that leave the site open in a new tab (target="_blank" rel="noopener"): checked here.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://autostart.flyreelstudio.eu';
const REPO = 'https://github.com/AndriiShramko/shramko-betaflight-motor-autostart';
const LANGS = ['en', 'es', 'pl', 'ru'];
// must match the visible page (template.html): 9 FAQ items, 4 numbered install steps (the DFU fix is a fold inside step 3)
const FAQ_COUNT = 9;
const INSTALL_STEPS = 4;

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readOpt = (p) => (existsSync(p) ? read(p) : {});
const template = readFileSync(join(web, 'template.html'), 'utf8');
// the FAQPage and HowTo JSON-LD describe exactly what the page shows
const shown = (re) => new Set(template.match(re) ?? []).size;
if (shown(/\{\{faq\.q\d+\}\}/g) !== FAQ_COUNT) throw new Error(`template shows ${shown(/\{\{faq\.q\d+\}\}/g)} FAQ items, JSON-LD has ${FAQ_COUNT}`);
if (shown(/\{\{install\.s\d+t\}\}/g) !== INSTALL_STEPS) throw new Error(`template shows ${shown(/\{\{install\.s\d+t\}\}/g)} install steps, JSON-LD has ${INSTALL_STEPS}`);
// the reels of #video (web/src/reels.json, files in web/public/video/): one VideoObject per reel a page shows
const REELS = read(join(web, 'src/reels.json')).reels;
for (const r of REELS) {
    for (const f of [r.file, r.poster]) if (!existsSync(join(web, 'public', f))) throw new Error(`web/public${f} is missing`);
    if (!(r.seconds > 0) || !/^\d{4}-\d\d-\d\d$/.test(r.uploadDate) || !LANGS.includes(r.voice) || !r.transcript) throw new Error(`reels.json: ${r.id} is incomplete`);
}
const en = { ...read(join(web, 'src/i18n/en.json')), ...readOpt(join(web, 'src/i18n/tool.en.json')) };

/** width × height for the <img> of web/public/img/wiring-<lang>.svg: 1600 wide, the height from its viewBox */
const wiringSize = (lang) => {
    const f = join(web, 'public/img', `wiring-${lang}.svg`);
    const vb = existsSync(f) ? /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(readFileSync(f, 'utf8').slice(0, 4000)) : null;
    if (!vb || !(Number(vb[1]) > 0) || !(Number(vb[2]) > 0)) {
        console.warn(`[${lang}] wiring-${lang}.svg: no viewBox, the diagram box assumes 1600×1050`);
        return [1600, 1050];
    }
    return [1600, Math.round((1600 * Number(vb[2])) / Number(vb[1]))];
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

let missingTotal = 0;
for (const lang of LANGS) {
    const own = lang === 'en' ? en : { ...read(join(web, `src/i18n/${lang}.json`)), ...readOpt(join(web, `src/i18n/tool.${lang}.json`)) };
    if (lang !== 'en') {
        const missing = Object.keys(en).filter((k) => !(k in own));
        const extra = Object.keys(own).filter((k) => !(k in en));
        if (missing.length) {
            missingTotal += missing.length;
            console.warn(`[${lang}] ${missing.length} keys missing (English used): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '...' : ''}`);
        }
        if (extra.length) console.warn(`[${lang}] ${extra.length} keys not in English (stale?): ${extra.slice(0, 8).join(', ')}`);
    }
    const dict = { ...en, ...own };
    const txt = (k) => {
        if (dict[k] === undefined) throw new Error(`JSON-LD key "${k}" has no text`);
        return strip(dict[k]);
    };

    // the first reel this language shows stands beside the text (R01, on /pl/ its Polish version), the rest are cards
    const reels = REELS.filter((r) => !r.pages || r.pages.includes(lang));
    const [main, ...cards] = reels;
    if (main?.key !== 'r01') throw new Error(`[${lang}] the first reel is ${main?.id}, the page text is about R01`);
    const trLabel = (r) => esc(txt(r.voice === lang ? 'video.trOwn' : 'video.transcript'));
    const trText = (r) => `<p lang="${r.voice}">${esc(r.transcript)}</p>`;
    const cardsHtml = cards.map((r) => {
        const id = `reel-${r.key}`;
        return `<li class="reel"><figure class="reel-fig">`
            + `<video controls playsinline preload="none" data-video-id="${r.id}" poster="${r.poster}" width="270" height="480" aria-labelledby="${id}-t" aria-describedby="${id}-cap"><source src="${r.file}" type="video/mp4"></video>`
            + `<figcaption><span class="reel-t" id="${id}-t">${esc(txt(`video.${r.key}t`))}</span> <span class="reel-dur">${Math.round(r.seconds)} ${esc(txt('hero.artSec'))}</span>`
            + `<span class="reel-cap small muted" id="${id}-cap">${esc(txt(`video.${r.key}cap`))}</span></figcaption></figure>`
            + `<details class="fold reel-tr" id="${id}-tr"><summary>${trLabel(r)}</summary>${trText(r)}</details></li>`;
    }).join('');
    const videoLd = (r, name, description) => ({
        '@context': 'https://schema.org',
        '@type': 'VideoObject',
        name,
        description,
        thumbnailUrl: `${SITE}${r.poster}`,
        contentUrl: `${SITE}${r.file}`,
        uploadDate: r.uploadDate,
        duration: `PT${Math.round(r.seconds)}S`,
        inLanguage: r.voice,
        transcript: r.transcript
    });
    const special = {
        r01Id: main.id, r01File: main.file, r01Poster: main.poster, r01TrLabel: trLabel(main), r01Tr_html: trText(main), reelCards_html: cardsHtml
    };

    const faq = [];
    for (let i = 1; i <= FAQ_COUNT; i++) {
        faq.push({ '@type': 'Question', name: txt(`faq.q${i}`), acceptedAnswer: { '@type': 'Answer', text: txt(`faq.a${i}_html`) } });
    }
    const jsonld = [
        {
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'Shramko Motor Autostart',
            alternateName: txt('meta.alt'),
            url: `${SITE}/${lang}/`,
            applicationCategory: 'UtilitiesApplication',
            operatingSystem: 'Windows, macOS, Linux (Chrome, Edge or Opera with Web Serial)',
            browserRequirements: 'Web Serial API (Chrome, Edge or Opera on a desktop computer)',
            description: txt('meta.description'),
            inLanguage: lang,
            isAccessibleForFree: true,
            offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
            license: 'https://www.gnu.org/licenses/gpl-3.0.html',
            codeRepository: REPO,
            downloadUrl: `${REPO}/releases/latest`,
            author: {
                '@type': 'Person',
                name: 'Andrii Shramko',
                url: 'https://www.linkedin.com/in/andrii-shramko/',
                sameAs: ['https://github.com/AndriiShramko', 'https://www.linkedin.com/in/andrii-shramko/']
            }
        },
        videoLd(main, txt('video.ldname'), txt('video.lddesc')),
        ...cards.map((r) => videoLd(r, `Shramko Motor Autostart: ${txt(`video.${r.key}t`)}`, txt(`video.${r.key}cap`))),
        { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
        {
            '@context': 'https://schema.org',
            '@type': 'HowTo',
            name: txt('install.title'),
            step: Array.from({ length: INSTALL_STEPS }, (_, i) => ({ '@type': 'HowToStep', position: i + 1, name: txt(`install.s${i + 1}t`), text: txt(`install.s${i + 1}_html`) }))
        }
    ];

    const html = template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, key) => {
        if (key === 'lang') return lang;
        // the wiring diagram's box has the SVG's own proportions (they differ per language): a lazy image that
        // loads with other proportions moves everything below it, and a #hash jump lands off target
        if (key === 'wiringW' || key === 'wiringH') return String(wiringSize(lang)[key === 'wiringW' ? 0 : 1]);
        if (key === 'jsonld') return JSON.stringify(jsonld).replace(/</g, '\\u003c');
        if (key in special) return special[key];
        const v = dict[key];
        if (v === undefined) throw new Error(`template key "${key}" has no English text`);
        // %LANG% inside trusted HTML: the page language (counted links /go/<slug>?l=<lang>)
        return key.endsWith('_html') ? v.replaceAll('%LANG%', lang) : esc(v);
    });
    if (/\{\{/.test(html)) throw new Error(`unreplaced placeholder in ${lang}`);
    // every link that leaves the site (http(s)://, /go/<slug>) opens in a new tab (WEB-PLAYBOOK §3)
    for (const a of html.match(/<a\s[^>]*>/g) ?? []) {
        const href = /href="([^"]*)"/.exec(a)?.[1] ?? '';
        if (/^(https?:|\/go\/)/.test(href) && !(/target="_blank"/.test(a) && /rel="[^"]*noopener/.test(a))) {
            throw new Error(`[${lang}] external link without target="_blank" rel="noopener": ${a}`);
        }
    }
    mkdirSync(join(web, lang), { recursive: true });
    writeFileSync(join(web, lang, 'index.html'), html);
    console.log(`wrote web/${lang}/index.html (${(html.length / 1024).toFixed(0)} KB, title: ${txt('meta.title')})`);
}

// root page: nginx redirects "/" by cookie / Accept-Language; this is the fallback (no inline JS: CSP)
writeFileSync(join(web, 'index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Shramko Motor Autostart</title><meta http-equiv="refresh" content="0; url=/en/"><link rel="canonical" href="${SITE}/en/">
<link rel="alternate" hreflang="en" href="${SITE}/en/"><link rel="alternate" hreflang="es" href="${SITE}/es/">
<link rel="alternate" hreflang="pl" href="${SITE}/pl/"><link rel="alternate" hreflang="ru" href="${SITE}/ru/">
<link rel="alternate" hreflang="x-default" href="${SITE}/">
</head><body><p><a href="/en/">English</a> · <a href="/es/">Español</a> · <a href="/pl/">Polski</a> · <a href="/ru/">Русский</a></p></body></html>
`);
if (missingTotal) console.warn(`${missingTotal} translations missing in total`);
