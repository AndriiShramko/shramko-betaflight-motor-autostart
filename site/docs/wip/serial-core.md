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
- [x] 7. tools/fc-node (serialport adapter, check.mjs) — compiled + passes vs mock (5 tests), NOT run on hardware

## Handoff (2026-10-20)

- Interface: `mountTool(root: HTMLElement, t: (key, vars?) => string, locale: 'en'|'es'|'pl'|'ru'): ToolHandle`
  (`ToolHandle = { destroy(), diagnostics() }`; also `toolDiagnostics()` for the feedback form). Missing keys
  fall back to the bundled tool.en.json; `{placeholders}` are filled by the tool itself.
- Tests (from `site/`): `npm run test:fc` (62 pass), `npm run test:tool-e2e` (8 pass, real Chrome),
  `npm run typecheck:fc`, `npm run fc:check:mock` (harness vs emulator).
- Bench (lead only, real board): `node tools/fc-node/check.mjs COM6 [--write-test]`.
- Demo on the site: `?mock=1` (+ `mockFw=1.0|stock|inav`, `mockInvalid=<name>`, `mockNoReturn=1`,
  `mockReboot=<ms>`, `mockSpeed=<x>`, `mockScale=<vbat_scale>`, `mockReconnectTimeout=<ms>`).

## Notes for the next agent

- Commit after each step; tick the box in the same commit.
- `git add` explicit paths only (`site/node_modules` is not in any .gitignore yet).
