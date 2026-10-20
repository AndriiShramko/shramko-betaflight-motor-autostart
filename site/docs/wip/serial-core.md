# Lane: serial-core + tool UI (branch `site-serial`, worktree `C:/dev/sma-wt-serial`)

Owns: `site/web/src/fc/**`, `site/web/src/ui/tool.ts`, `site/web/src/ui/tool.css`,
`site/web/src/i18n/tool.{en,es,pl,ru}.json`, `site/tools/fc-node/**`, `site/tests/**`,
and a minimal `site/package.json` (the lead merges it with the shell lane's one).

Hardware rule: never open a COM port here, test only against `mockfc.ts`.

## Status

- [x] 0. Worktree, status file
- [x] 1. package.json + deps (typescript, tsx, vite, playwright, serialport, web-serial-polyfill)
- [x] 2. fc/transport.ts, fc/msp.ts, fc/cli.ts, fc/settings.ts
- [x] 3. fc/mockfc.ts, fc/device.ts (typecheck clean; tests in step 4)
- [x] 4. unit + device e2e tests vs mock (node --test): 52/52 pass (msp 12, cli 8, settings 11, transport 7, device 14)
- [x] 5. ui/tool.ts + tool.css + i18n tool.{en,es,pl,ru}.json (i18n parity test: 5 pass)
- [x] 6. Playwright harness test (?mock=1) with negative controls: 8/8 pass in Chrome
- [ ] 7. tools/fc-node (serialport adapter, check.mjs) — compiled + passes vs mock, NOT run on hardware

## Notes for the next agent

- Commit after each step; tick the box in the same commit.
- `git add` explicit paths only (`site/node_modules` is not in any .gitignore yet).
