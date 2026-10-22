# AGENTS.md — notes for AI coding agents

Shramko Motor Autostart: a patch for Betaflight 2025.12.1 that turns a flight controller into a standalone motor driver (power on → delay → linear ramp → hold; optional gusts, run time, battery cut-off), plus a static web configurator (`site/`, live at https://autostart.flyreelstudio.eu) that edits the settings over Web Serial in the visitor's browser.

## Map

| Path | What |
|---|---|
| `patches/0001-shramko-motor-autostart.patch` | The firmware module (state machine, CLI parameters, debug mode) applied to Betaflight 2025.12.1. |
| `configs/HGLRC_F405_S8/config.h` | Board config of the tested board, with `USE_AUTOSTART` and the project defaults. |
| `build/` | Docker image (`Dockerfile`), `build.sh <BOARD> [--stock]`, `test.sh` (Betaflight googletest unit tests of the module and the files it touches). |
| `configs/reference/reference.json` | The reference setup (the author's board): every CLI value, the build block, what adapts to other hardware. |
| `AGENT_PORTING.md` | Protocol for a user's AI agent: build for another board, set it up like the reference, prove it. |
| `tools/` | Host tools (Python 3.8+, `pip install pyserial`; `matplotlib` for plots): `make_board_config.py` (board config from betaflight/config + the reference block; `--backup` checks board_name, MCU and gyro), `check_reference.py` (read-only: board vs reference, PASS/FAIL), `autostart_selftest.py` (measures the ramp on the board), `fc_peek.py` (read-only MSP snapshot: state, battery and ESC voltage; its last line and exit code say whether a battery is connected), `bf_cli.py` (CLI commands; a `set` the board does not confirm aborts without saving), `battery_test.py` (with a battery: idle, voltage calibration `--apply-scale`, capped run, gusts, STOP, cut-off; `--restore` after an interrupted run), `param_matrix_test.py` (every setting on the board), `esc_reboot_test.py`, `flash_dfu.py` (Windows + STM32CubeProgrammer), `interference_test.py`, `rx_arbitration_test.py`, `wiring_diagram.py`. Tests: `tools/tests/`. |
| `docs/settings.md` | **Single source of truth** for setting names, units, ranges, defaults, states and debug fields. Firmware, configurator and docs follow it. |
| `docs/wiring.md`, `docs/img/` | Wiring of the tested setup, diagrams. |
| `docs/selftest/` | Raw measurements from the board. |
| `site/web/` | The configurator site: `template.html` + `src/i18n/<lang>.json` → one page per language (`web/scripts/gen-pages.mjs`), `src/main.ts`, `src/ui/` (feedback, diagnostics, i18n, api), `src/ui/tool.ts` + `src/fc/` (the configurator itself: Web Serial, MSP/CLI). |
| `site/api/` | Python stdlib API: `/api/report`, `/api/lead`, `/api/e`, `/api/health`, `/go/<slug>` (allow-list `go-targets.json`). |
| `site/deploy/` | Docker compose, nginx.conf (CSP, Permissions-Policy allowing `serial`/`usb`), deploy/rollback scripts, neighbour snapshots, local tests. |
| `site/tools/` | Screenshots + click checks (`shots.mjs`), OG card (`og.mjs`), reports reader (`reports/pull.py`). |

## Rules that matter

- **Hardware safety.** Never spin a motor with a propeller on. Do not open the board's serial port while another program or person uses it. Tests that touch hardware need the owner's go-ahead.
- **Settings change in `docs/settings.md` first**, then in the patch, the configurator and the docs, in one change.
- **Every claim "it works" needs a measurement** with a negative control (the self-test rejects a ramp 1 s early/late; each unit test was checked with a code mutant that must fail it).
- **The site never sends the board's settings or live data to the server.** Error reports carry diagnostics only with the visitor's consent; the API whitelists and scrubs them.
- **Permissions-Policy must keep `serial=(self)` and `usb=(self)`** in `site/deploy/nginx.conf`, or the configurator silently stops working (`site/deploy/tests/nginx.sh` checks it).
- Strings: add keys to `site/web/src/i18n/en.json` first (configurator keys `tool.*` in `tool.en.json`), then ES/PL/RU; `npm run pages` warns about missing keys. Technical terms (Betaflight, DShot, ESC, CLI, `.hex`) stay untranslated. Everything on GitHub is in English.
- The page CSP forbids inline scripts. JSON-LD is fine (not executable) and must describe only visible text.
- New counter events must be added to `EVENTS` in `site/api/server.py` first; new `/go/` links to `site/api/go-targets.json` (a test fails otherwise).
- Never commit `site/deploy/hub.env`, `config.env`, `site/tools/reports/inbox/`, `site/api/data/`, `.hex` builds.

## Checks before a PR

```bash
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/test.sh   # firmware unit tests (PowerShell: "${PWD}:/repo")
python -m unittest discover -s tools/tests             # board tools: config generator, reference check
cd site
npm install && npm run build                         # typecheck + pages + bundle
python -m unittest discover -s api/tests             # API
node tools/shots.mjs dist docs/wip/shots             # screenshots, console errors, links, lang switch, Feedback
bash deploy/tests/nginx.sh                           # nginx.conf in the real image (Docker)
```

License: GPL-3.0-or-later (like Betaflight). Author: Andrii Shramko (zmei116@gmail.com).
