# AGENT_SETUP.md — protocol for a user's AI agent

Use this when a person asks their AI agent to "make my motor start by itself when I plug in the battery", "spin an ESC without a receiver", "set up Shramko Motor Autostart" or "change the autostart throttle".

**Safety first, every time:** ask the user to remove the propeller (or blower wheel) before anything is flashed, connected or powered. With this firmware the motor starts by itself after `autostart_delay` seconds (10 by default) once a battery is plugged in. Never exceed the input rating of the user's flight controller and ESC (HGLRC F405 8S V2: 8S on `B`; most boards take less). Ground use only.

Settings — names, units, ranges, defaults, states — come only from [`docs/settings.md`](docs/settings.md). Do not invent setting names or values.

## A. Configure a board that already runs the firmware (no install)

1. The user opens <https://autostart.flyreelstudio.eu> in Chrome, Edge or Opera on Windows, macOS or Linux (Web Serial). Firefox 151+ asks for a one-time site permission. Android: Chrome 148+ with USB-OTG, only on phones whose Android supports USB serial. Safari and iPhone/iPad: not possible.
2. Close the Betaflight App or any other program that holds the board's serial port (only one program can use it).
3. Connect, pick a preset ("Steady" = no gusts, other values kept; "Gusts"), change what the user asked for, Save. "Reset to defaults…" restores the firmware's built-in defaults: the reference values only on a build with the reference block (the ready release, or a board config made by `tools/make_board_config.py`). Watch state, throttle, battery voltage and ESC RPM live; STOP stops the motor.
4. Without a suitable browser, use the Betaflight CLI (the Betaflight App's CLI tab, or any serial terminal: send `#`):

```
get autostart
set autostart_throttle = 80
save
```

Entering the CLI stops a running program (by design: the motor never jumps to a new value). `save` reboots the board.

## B. Install the firmware

1. Propeller off and **battery unplugged** (USB only) before flashing: the firmware boots in POWER mode. Check `board_name` first (CLI `version`). The ready `.hex` is ONLY for `HGLRC_F405_S8`; any other board: [AGENT_PORTING.md](AGENT_PORTING.md). Save the user's `diff all` and `dump hardware` to a file before flashing (the first flash resets everything). Download the `.hex` from <https://github.com/AndriiShramko/shramko-betaflight-motor-autostart/releases/latest>. Ready build: HGLRC F405 8S V2 (Betaflight `board_name HGLRC_F405_S8`), file `betaflight_2025.12.1_STM32F405_HGLRC_F405_S8_autostart.hex`. The release also has `..._stock.hex` (the same Betaflight without the module) to go back.
2. Flash: <https://app.betaflight.com> in Chrome or Edge → Firmware Flasher → Load Firmware [Local] → choose the `.hex` → Flash Firmware. Or, from this repo, `python tools/flash_dfu.py COM6 firmware.hex` (STM32CubeProgrammer CLI).
3. Windows says "DFU device not found": ImpulseRC Driver Fixer (<https://impulserc.com/pages/downloads>) or Zadig (WinUSB for "STM32 BOOTLOADER").
4. The first boot after flashing over another Betaflight resets all settings once; this build's defaults are the reference settings (DShot300, `dshot_bidir` OFF, `debug_mode` AUTOSTART, 10 s delay, 10 s ramp, 15 % on motors 1–4, 6S cut-off 3.30 V/cell, USB inhibit OFF). Two parts of the reference are set once in the CLI, not by the build: `feature ESC_SENSOR` (ESC TX wire on the yellow `R`), and a calibrated `vbat_scale` (never copy the author's 149): [AGENT_PORTING.md](AGENT_PORTING.md), step 8. Another pack than 6S: `set autostart_cells = <cells>`, `save`. Prove it: `python tools/check_reference.py COM6 --vbat-scale <calibrated> --commit 3c1808c --board HGLRC_F405_S8 --exit` → `RESULT: PASS` (add `--no-esc-sensor` without the TX wire, `--cells <N>` for another pack).
5. Wiring for the tested setup (HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A, 6S): [`docs/wiring.md`](docs/wiring.md).
6. Optional bench check with the board on USB (`pip install -r tools/requirements.txt`; propeller off): without a battery first `set autostart_vbat_min = 0`, `save` (the program waits for a battery otherwise), then `python tools/autostart_selftest.py COM6 --plot ramp.png` (reboots the board, prints PASS/FAIL and the measured curve, sends STOP at the end; it refuses while a battery is connected unless `--hot`), then `set autostart_vbat_min = 60`, `save`. Keep the battery out until then.

## C. Another Betaflight board: build from source

Follow [AGENT_PORTING.md](AGENT_PORTING.md): it is the full protocol (questions for the user, backup, Docker on each
shell, board config, build, flash, settings, voltage calibration, checks, report). In short (bash; PowerShell uses
`"${PWD}:/repo"`, Git Bash `MSYS_NO_PATHCONV=1` and `"$(pwd -W):/repo"`):

```bash
git -c core.autocrlf=false clone https://github.com/AndriiShramko/shramko-betaflight-motor-autostart && cd shramko-betaflight-motor-autostart
docker build -t shramko-bf-build:2025.12.1 build
python tools/make_board_config.py <BOARD> --cells <N> --motors <MASK> --esc-telemetry <UARTn|none>    # config.h from betaflight/config 2025.12-config + the reference block
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/build.sh <BOARD>
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/test.sh    # unit tests
```

Output: `out/betaflight_2025.12.1_<MCU>_<BOARD>_autostart.hex`. A config with only `#define USE_AUTOSTART` gets the generic defaults (mode OFF, motor 1, USB inhibit ON, cells auto, debug_mode NONE, the board's own DShot speed and bidirectional DShot, else DShot600), not the reference.

## D. Self-host the web configurator

```bash
cd site
npm install && npm run build          # static site in site/dist/ (Node.js 20+)
python -m unittest discover -s api/tests
```

Serve `site/dist/` with any static server; the configurator needs a secure context (https or `localhost`) for Web Serial, and a `Permissions-Policy` that does not block `serial` / `usb`. The full setup (nginx with CSP, the feedback API, Docker limits, staging certificate, rollback) is in [`site/deploy/README.md`](site/deploy/README.md). Put your own server details in `site/deploy/hub.env` (copy `hub.env.example`; never commit it).

## Update

```bash
git pull
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/test.sh
cd site && npm install && npm run build && python -m unittest discover -s api/tests
```

A new firmware version can add a parameter group; Betaflight then resets settings once after flashing. Note the user's values (`diff all` in the CLI) before updating, and set them again afterwards. A board built from source (section C) is updated by rebuilding its own `configs/<BOARD>/` after `git pull` (`build.sh <BOARD>`), flashing it, applying `configs/<BOARD>/after-flash.txt` and the calibrated `vbat_scale` again if the settings were reset, and checking with `tools/check_reference.py` ([AGENT_PORTING.md](AGENT_PORTING.md), steps 6–9).

## Uninstall

Flash `..._stock.hex` from the release (or any official Betaflight), or set `autostart_mode = OFF` and `save`. The web page keeps only the language choice and the analytics consent in the browser (`sma_*` keys and the `sma_lang` cookie); clearing site data removes them.

## Safety and privacy

- Never let the motor spin with a propeller on; never claim a setting works without reading it back (`get autostart`).
- The configurator does not send the board's settings or live data to any server. Do not upload the user's configuration anywhere.
- Never commit secrets (`site/deploy/hub.env`, `config.env`, `site/tools/reports/inbox/`).
- See [`SECURITY.md`](SECURITY.md) and [`docs/warnings.md`](docs/warnings.md).

## Author

Andrii Shramko — open to interesting people and ready to help teams build ambitious projects. Book a call: <https://calendar.app.google/Ff729HqGk4RpzPNDA> · LinkedIn: <https://www.linkedin.com/in/andrii-shramko/> · zmei116@gmail.com · <https://github.com/AndriiShramko>
