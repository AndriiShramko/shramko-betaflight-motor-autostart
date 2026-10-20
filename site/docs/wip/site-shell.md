# Lane: site-shell (worktree C:/dev/sma-wt-shell, branch site-shell)

Web configurator site shell for https://autostart.flyreelstudio.eu: page, i18n, feedback,
diagnostics, API, deploy. The tool itself (web/src/fc/**, web/src/ui/tool.ts, tool.css,
web/src/i18n/tool.*.json) belongs to the serial-core lane; this lane ships only a stub tool.ts.

## Status

- [x] 1. package.json, tsconfig.json, vite.config.mjs, gen-pages.mjs, post-build.mjs
- [x] 2. template.html + styles.css + main.ts + ui/{feedback,diagnostics,api,i18n}.ts + stub tool.ts
- [x] 3. i18n en.json (master) + es/pl/ru
- [x] 4. web/public: favicon, robots, sitemap, llms.txt, og.png, img/
- [x] 5. api/server.py (+ /go/<slug>) + tests (35 OK)
- [x] 6. deploy/ (compose, nginx.conf, scripts, hub.env.example, README) + tools/reports/pull.py
       (deploy/tests/nginx.sh 91/91, deploy/tests/fakehub.sh 108/108, pull.py --selftest OK)
- [x] 7. repo files: AGENT_SETUP.md, AGENTS.md, SECURITY.md, docs/warnings.md, llms.txt, .gitignore
- [x] 8. gates: npm install + build green; tools/shots.mjs: en/ru 1440+375, es/pl 375, lang switch
       (header + footer, remembered), Feedback dialog, error banner both ways, 0 console errors,
       no overflow, external links in new tabs; Feedback end-to-end through a real local API
       (R-20261020-0001 stored with diagnostics, no IP in log or record). NOT deployed.

## Notes for the lead / serial-core lane

- Interface: `web/src/main.ts` does `import('./ui/tool')` then `mountTool(root, t, lang)`:
  root = `<section id="tool">` (it holds an `<h2>`, a lead `<p>` and a `[data-tool-fallback]` card
  with the no-JS / unsupported-browser text: replace that card with the tool UI), `t(key, vars?)`
  returns the string for the page language (English fallback), lang = 'en'|'es'|'pl'|'ru'.
- Tool strings: `web/src/i18n/tool.<lang>.json`, keys `tool.*`; `ui/i18n.ts` merges them over
  `<lang>.json` (lazy chunk per language; a missing file is fine). `npm run pages` warns about
  missing keys in tool files too.
- `web/src/ui/tool.ts` is a STUB here: merging both lanes gives an add/add conflict on it; take
  the serial-core version. Its stub string `cfg.stub` can stay unused.
- Shared CSS tokens/classes in `styles.css` the tool can use: `--bg --bg2 --card --line --line2
  --text --text2 --muted --accent --accent-ink --accent2 --ok --warn --err --radius --mono`,
  `.btn .btn.primary .btn.danger .btn.ghost .btn.small .btn.big`, `.card`, `.banner.warn/.ok/.err`,
  `label`, `label.check`, inputs/selects, `fieldset/legend`, `.help`, `.row`.
- Diagnostics hooks (`ui/diagnostics.ts`): `logLine(text)`, `setDiagnostic(key, value)`,
  `showSiteError(err)` (friendly banner). They go into bug reports only with consent.
- Counter events the API accepts (`track()` in `ui/api.ts`): `tool_connect`, `tool_connect_fail`
  (reason), `tool_unsupported` (reason), `tool_save` (preset steady|gusts|custom), `tool_stop`,
  `tool_error` (reason). New names: add to `EVENTS` in `api/server.py` first.
- Phone layout: the round Feedback button sits bottom-left (48 px, 12 px from the edges); keep the
  STOP button out of that corner.
- `web-serial-polyfill` is NOT added: add it to `site/package.json` dependencies in the serial lane
  if the Android/WebUSB path needs it. nginx already allows `serial=(self), usb=(self)`.
- Wiring images: the page loads `/img/wiring-<lang>.svg` (1600x1050) — not in this branch; the
  lead adds them to `web/public/img/`. Until then the figure shows the alt text (shots.mjs reports
  the 404 as expected).
- GA4: `web/.env.production` has an empty `VITE_GA_ID` (no banner, no consent links). Create a
  GA4 property for this site and put its id there.
- Local `site/deploy/hub.env` (gitignored) exists in this worktree only, derived from SOG's with
  `SMA_BASE=/home/fpv/autostart`; the main checkout needs its own copy.
