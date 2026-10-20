// Renders the social share card web/public/og.png (1200x630) with Playwright. No text in the image
// (WEB-PLAYBOOK §9: the title and description come from the page's own og: tags, in every language):
// a throttle ramp (delay -> linear ramp -> hold with gusts), a rotor, and Andrii's round photo.
//   node tools/og.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const avatar = readFileSync('web/public/img/andrii-shramko-320.webp').toString('base64');
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;overflow:hidden;background:radial-gradient(900px 600px at 78% 20%,#12352a 0,#0a0c0f 62%);position:relative}
svg{position:absolute;inset:0}
.author{position:absolute;right:64px;bottom:56px;width:120px;height:120px;border-radius:50%;border:5px solid #3ddc97;object-fit:cover;box-shadow:0 10px 40px rgba(61,220,151,.25)}
</style></head><body>
<svg viewBox="0 0 1200 630" width="1200" height="630">
  <defs>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3ddc97" stop-opacity=".32"/><stop offset="1" stop-color="#3ddc97" stop-opacity="0"/></linearGradient>
    <pattern id="g" width="60" height="60" patternUnits="userSpaceOnUse"><path d="M60 0H0V60" fill="none" stroke="#1b222b" stroke-width="1"/></pattern>
  </defs>
  <rect width="1200" height="630" fill="url(#g)" opacity=".7"/>
  <line x1="90" y1="520" x2="1110" y2="520" stroke="#34404d" stroke-width="3"/>
  <line x1="90" y1="90" x2="90" y2="520" stroke="#34404d" stroke-width="3"/>
  <path d="M370 520 L640 250 L1110 250 L1110 520 Z" fill="url(#f)"/>
  <path d="M720 250 L745 140 L770 250 M860 250 L880 175 L900 250 M985 250 L1002 160 L1019 250" fill="none" stroke="#3ddc97" stroke-width="5" stroke-dasharray="10 10" opacity=".5"/>
  <path d="M90 520 L370 520 L640 250 L1110 250" fill="none" stroke="#3ddc97" stroke-width="10" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="370" cy="520" r="12" fill="#0a0c0f" stroke="#3ddc97" stroke-width="5"/>
  <circle cx="640" cy="250" r="12" fill="#0a0c0f" stroke="#3ddc97" stroke-width="5"/>
  <g transform="translate(250 230) scale(5.2) translate(-16 -16)">
    <circle cx="16" cy="16" r="13.5" fill="none" stroke="#3ddc97" stroke-width="1.2" opacity=".85"/>
    <path d="M16 16C14.6 10.4 16.2 6.6 19.4 6.9c3 .3 2.4 6.1-3.4 9.1zM16 16c5.6-1.6 9.6 0 9.3 3.2-.3 3-6.1 2.4-9.3-3.2zM16 16c-4 4.2-8.2 5-9.7 2.2-1.4-2.7 3.9-5.2 9.7-2.2z" fill="#3ddc97" opacity=".9"/>
    <circle cx="16" cy="16" r="2.3" fill="#0a0c0f" stroke="#3ddc97" stroke-width=".9"/>
  </g>
</svg>
<img class="author" src="data:image/webp;base64,${avatar}">
</body></html>`;

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'load' });
writeFileSync('web/public/og.png', await page.screenshot({ type: 'png' }));
await browser.close();
console.log('wrote web/public/og.png (1200x630, no text)');
