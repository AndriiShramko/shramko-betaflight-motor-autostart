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
const FAQ_COUNT = 8;
const INSTALL_STEPS = 5;

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readOpt = (p) => (existsSync(p) ? read(p) : {});
const template = readFileSync(join(web, 'template.html'), 'utf8');
const en = { ...read(join(web, 'src/i18n/en.json')), ...readOpt(join(web, 'src/i18n/tool.en.json')) };

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
    const txt = (k) => strip(dict[k] ?? '');

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
        { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq },
        {
            '@context': 'https://schema.org',
            '@type': 'HowTo',
            name: txt('install.title'),
            step: Array.from({ length: INSTALL_STEPS }, (_, i) => ({ '@type': 'HowToStep', name: txt(`install.s${i + 1}t`), text: txt(`install.s${i + 1}_html`) }))
        }
    ];

    const html = template.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_m, key) => {
        if (key === 'lang') return lang;
        if (key === 'jsonld') return JSON.stringify(jsonld).replace(/</g, '\\u003c');
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
