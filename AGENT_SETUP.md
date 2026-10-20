# AGENT_SETUP.md — protocol for a user's AI agent

Use this when a person asks their AI agent to "make my motor start by itself when I plug in the battery", "spin an ESC without a receiver", "set up Shramko Motor Autostart" or "change the autostart throttle".

**Safety first, every time:** ask the user to remove the propeller (or blower wheel) before anything is flashed, connected or powered. With this firmware the motor starts by itself after `autostart_delay` seconds (10 by default) once a battery is plugged in. Never more than 8S on the board's `B` pin. Ground use only.

Settings — names, units, ranges, defaults, states — come only from [`docs/settings.md`](docs/settings.md). Do not invent setting names or values.

## A. Configure a board that already runs the firmware (no install)

1. The user opens <https://autostart.flyreelstudio.eu> in Chrome, Edge or Opera on Windows, macOS or Linux (Web Serial; not Firefox/Safari; Android with USB-OTG not confirmed; iPhone/iPad impossible).
2. Close the Betaflight App or any other program that holds the board's serial port (only one program can use it).
3. Connect, pick a preset ("Steady" = the defaults, or "Gusts"), change what the user asked for, Save. Watch state, throttle, battery voltage and ESC RPM live; STOP stops the motor.
4. Without a suitable browser, use the Betaflight CLI (the Betaflight App's CLI tab, or any serial terminal: send `#`):

```
get autostart
set autostart_throttle = 80
save
```

Entering the CLI stops a running program (by design: the motor never jumps to a new value). `save` reboots the board.

## B. Install the firmware

1. Download the `.hex` from <https://github.com/AndriiShramko/shramko-betaflight-motor-autostart/releases/latest>. Ready build: HGLRC F405 8S V2 (Betaflight `board_name HGLRC_F405_S8`), file `betaflight_2025.12.1_STM32F405_HGLRC_F405_S8_autostart.hex`. The release also has `..._stock.hex` (the same Betaflight without the module) to go back.
2. Flash: <https://app.betaflight.com> in Chrome or Edge → Firmware Flasher → Load Firmware [Local] → choose the `.hex` → Flash Firmware. Or, from this repo, `python tools/flash_dfu.py COM6 firmware.hex` (STM32CubeProgrammer CLI).
3. Windows says "DFU device not found": ImpulseRC Driver Fixer (<https://impulserc.com/pages/downloads>) or Zadig (WinUSB for "STM32 BOOTLOADER").
4. The first boot after flashing over another Betaflight resets all settings once; this build's defaults are the project settings (DShot300, bidirectional DShot, 10 s delay, 10 s ramp, 15 %).
5. Wiring for the tested setup (HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A, 6S): [`docs/wiring.md`](docs/wiring.md).
6. Optional bench check with the board on USB: `python tools/autostart_selftest.py COM6 --plot ramp.png` (reboots the board, prints PASS/FAIL and the measured curve). Propeller off.

## C. Another Betaflight board: build from source

```bash
git clone https://github.com/AndriiShramko/shramko-betaflight-motor-autostart && cd shramko-betaflight-motor-autostart
docker build -t shramko-bf-build:2025.12.1 build
# copy the board's config.h from https://github.com/betaflight/config into configs/<BOARD>/,
# add:  #define USE_AUTOSTART   (plus any AUTOSTART_DEFAULT_* values)
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/build.sh <BOARD>
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/test.sh    # unit tests
```

Output: `out/betaflight_2025.12.1_<MCU>_<BOARD>_autostart.hex`. Generic builds default to `autostart_mode = OFF` and `autostart_usb_inhibit = ON`; tell the user to set the mode they want.

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

A new firmware version can add a parameter group; Betaflight then resets settings once after flashing. Note the user's values (`diff all` in the CLI) before updating, and set them again afterwards.

## Uninstall

Flash `..._stock.hex` from the release (or any official Betaflight), or set `autostart_mode = OFF` and `save`. The web page keeps only the language choice and the analytics consent in the browser (`sma_*` keys and the `sma_lang` cookie); clearing site data removes them.

## Safety and privacy

- Never let the motor spin with a propeller on; never claim a setting works without reading it back (`get autostart`).
- The configurator does not send the board's settings or live data to any server. Do not upload the user's configuration anywhere.
- Never commit secrets (`site/deploy/hub.env`, `config.env`, `site/tools/reports/inbox/`).
- See [`SECURITY.md`](SECURITY.md) and [`docs/warnings.md`](docs/warnings.md).

## Author

Andrii Shramko — open to interesting people and ready to help teams build ambitious projects. Book a call: <https://calendar.app.google/Ff729HqGk4RpzPNDA> · LinkedIn: <https://www.linkedin.com/in/andrii-shramko/> · zmei116@gmail.com · <https://github.com/AndriiShramko>
