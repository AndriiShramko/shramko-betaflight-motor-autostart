# Lane: site-shell (worktree C:/dev/sma-wt-shell, branch site-shell)

Web configurator site shell for https://autostart.flyreelstudio.eu: page, i18n, feedback,
diagnostics, API, deploy. The tool itself (web/src/fc/**, web/src/ui/tool.ts, tool.css,
web/src/i18n/tool.*.json) belongs to the serial-core lane; this lane ships only a stub tool.ts.

## Status

- [ ] 1. package.json, tsconfig.json, vite.config.mjs, gen-pages.mjs, post-build.mjs
- [ ] 2. template.html + styles.css + main.ts + ui/{feedback,diagnostics,api,i18n}.ts + stub tool.ts
- [ ] 3. i18n en.json (master) + es/pl/ru
- [ ] 4. web/public: favicon, robots, sitemap, llms.txt, og.png, img/
- [ ] 5. api/server.py (+ /go/<slug>) + tests
- [ ] 6. deploy/ (compose, nginx.conf, scripts, hub.env.example, README) + tools/reports/pull.py
- [ ] 7. repo files: AGENT_SETUP.md, AGENTS.md, SECURITY.md, docs/warnings.md, llms.txt, .gitignore
- [ ] 8. gates: npm install + build green, screenshots 1440/375 en+ru, lang switch, feedback dialog, no console errors

## Notes for the lead / serial-core lane

- Interface: `web/src/main.ts` calls `import('./ui/tool').then(m => m.mountTool(root, t, locale))`.
  `t(key)` returns the string for the current page; tool keys live in `web/src/i18n/tool.<locale>.json`
  and are merged into the page dictionary by `web/src/ui/i18n.ts` (glob import, missing file = fine).
- `web-serial-polyfill` is NOT added: add it to `site/package.json` dependencies in the serial lane if
  the Android/WebUSB path needs it.
