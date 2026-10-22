# Shramko Motor Autostart — Betaflight firmware that spins a motor on power-up, no receiver needed

**Plug in the battery → wait 10 s → the motor ramps up smoothly over 10 s to the throttle you set → it keeps running until the battery reaches its cut-off voltage or you unplug.**

**Configure it in the browser:** <https://autostart.flyreelstudio.eu> — plug the flight controller into USB, press Connect, change any value, save, watch it live. Firmware 1.1 adds a **battery cut-off** (6S: 3.30 V/cell), **run time**, **throttle limit** and **random gusts** that blow droplets off a lens. Full list: [docs/settings.md](docs/settings.md).
No transmitter, no receiver, no switch. A small, tested module for **Betaflight 2025.12.1** that turns a Betaflight flight controller into a standalone, configurable **motor / ESC driver** for blowers, fans, pumps, test stands and art installations — with DShot or PWM, and every number changeable from the Betaflight CLI without rebuilding. Ready firmware for the HGLRC F405 8S V2 (tested on hardware); other boards build from source (F405, F411, F722, F745, H743, G473, AT32F435 build).

Optional extras: a **single momentary push-button on two pads** (internal pull-up, no resistors or diodes), and a **standard RC receiver** (stock Betaflight behaviour, or an AUX switch that starts the same program).

![Command sent to the ESC after power-on: 10 s delay, linear 10 s ramp to 15 %, hold](docs/img/selftest-ramp-15pct.png)

*Measured on the real flight controller over USB: ramp starts at 10.0 s, reaches 15 % at 20.0 s, linearity R² = 0.9999, max deviation 1 µs.*

## Another flight controller? Give this prompt to your AI agent

Copy it into Claude Code, Codex, Cursor or any coding agent that can run commands on your computer. The agent follows [AGENT_PORTING.md](AGENT_PORTING.md): it builds the firmware for **your** board in Docker, flashes it, sets it up like the author's reference setup and proves it with [`tools/check_reference.py`](tools/check_reference.py). It asks you only to remove the propeller, plug things in and decide.

```text
Build and set up "Shramko Motor Autostart" for my flight controller, the same way as the author's reference setup.
Repository: https://github.com/AndriiShramko/shramko-betaflight-motor-autostart
Follow its AGENT_PORTING.md step by step. It is the protocol: do not invent settings and do not skip its checks.

My hardware (fill in what you know, ask me for the rest):
- Flight controller:
- ESC (model and firmware: BLHeli_32 / AM32 / BLHeli_S / Bluejay):
- Battery (cells, LiPo or Li-ion):
- Motor pad the ESC signal is soldered to:
- ESC TX (telemetry) wire soldered to (pad name, or "none"):
- My computer: Windows / macOS / Linux

Do the technical work yourself: clone, Docker build, tests, flashing, CLI. Ask me only for physical actions
(remove the propeller, plug USB or the battery, hold the BOOT button) and for decisions.
Stop and ask me before anything that can make the motor spin. Finish with the report from step 10.
```

The reference setup: battery plugged in → 10 s → linear ramp over 10 s to 15 % → hold, motor stopped below 3.30 V per cell; DShot300, bidirectional DShot off, ESC telemetry over the ESC's TX wire. Values: [`configs/reference/reference.json`](configs/reference/reference.json). Two of them follow your hardware: the battery's cell count and which motor outputs carry your ESC signal; the voltage calibration is measured on your board.

## Questions this answers

- How do I spin a brushless motor with Betaflight **without a receiver or transmitter**?
- Can a flight controller **start a motor automatically on power-up** after a delay?
- How do I make a **soft-start / slow linear throttle ramp** for an ESC (e.g. 0 → 15 % over 10 s)?
- How can I use a **flight controller as a fan or blower controller** with DShot and BLHeli_32 / AM32 ESCs?
- How do I start a motor program with **one push-button soldered to two pads**, no extra electronics?
- Why won't Betaflight arm without a receiver, and what is the safe workaround?
- How do I wire a **Flycolor X-Cross HV3 160A** ESC to an **HGLRC F405 8S** flight controller?
- How can my **AI agent build this firmware for my own flight controller** (SpeedyBee, Matek, Foxeer, …) and set it up like the author's?

## Why it exists

Built by [Andrii Shramko](#author--working-together) for the **META4 Tornado case**: a sealed 360° camera rig for storm chasing, where a blower must clear water from the optics as soon as the box is powered — nobody can reach a transmitter there. Stock Betaflight cannot do this: it refuses to arm without a valid receiver link, the CLI `motor` command only lasts while a computer is connected, INAV and ArduPilot have no target for this board (and no GPIO button input / no Lua on 1 MB F405), and BLHeli_32 has no autostart. Nothing on GitHub did it, so this module was written, reviewed and measured on hardware.

## How it works

The module writes the throttle into the same place the Configurator **Motors tab** uses while disarmed (`motor_disarmed[]`), so the stock output path stays untouched: DShot/PWM drivers, the ESC's stop-command arming at boot, bidirectional DShot telemetry. A 50 Hz task runs a tiny state machine:

`IDLE → DELAY (countdown) → RAMP (linear) → RUN (hold)`

**Battery gate.** ESCs without a BEC wake up only when the battery is plugged in, and a BLHeli_32 ESC will not arm if it powers up into a non-zero throttle. The board measures the battery voltage on its `B` pin, so the countdown starts **when the battery appears** (on battery-only power that is the boot itself). Unplugging the battery for > 0.5 s stops the program; plugging it back in starts the countdown again. That is what makes "hot" bench testing with the USB cable attached safe and predictable.

Arbitration, highest priority first:
1. **Armed** by a receiver, 3D mode, or (optionally) a **computer connected** → the program stops and stock Betaflight owns the motors.
2. **Receiver link valid** for 0.5 s → stock Betaflight; an AUX switch (`autostart_box`) can run the same program.
3. **No receiver** → `POWER` mode starts the program at boot; a **button click** starts it, the next click stops it.

Safety: the ESC always gets ≥ 3 s of stop frames after it is powered before the ramp; the program parameters are frozen when it starts (a CLI `set` while running never steps the throttle); entering the CLI, moving a slider in the Configurator Motors tab or the web configurator's STOP stops the program and hands the motor to you, and nothing starts by itself again until the board restarts (also when it was only waiting for the battery); never takes a pin owned by another driver; generic default is `OFF` (only the project board config enables `POWER`).

## CLI settings

| Setting | Default (this build) | Range | Meaning |
|---|---|---|---|
| `autostart_mode` | `POWER` | `OFF`, `POWER`, `BUTTON` | `POWER`: start when the battery is plugged in. `BUTTON`: wait for a click. `OFF`: stock Betaflight |
| `autostart_delay` | `10` | 0–600 s | delay before the ramp, counted **from battery plug-in** (POWER; a battery already there at boot counts from boot) or from the click |
| `autostart_ramp` | `100` | 0–6000 (0.1 s) | ramp time 0 → target; `100` = 10.0 s |
| `autostart_throttle` | `15` | 0–100 % | target throttle, % of the ESC range (1000–2000 µs / DShot 48–2047) |
| `autostart_motors` | `15` | bitmask | `15` = motors 1–4 (any of the four signal wires works), `1` = motor 1 only … |
| `autostart_vbat_min` | `60` | 0–600 (0.1 V) | battery counts as plugged in at ≥ 6.0 V; countdown starts then. `0` = don't check |
| `autostart_usb_inhibit` | `OFF` (generic builds: `ON`) | `OFF`, `ON` | `ON`: never spin while a USB host is connected |
| `autostart_box` | `255` (none) | 40–43 | `BOXUSER1..4` permanent id: an AUX switch runs the program while the receiver link is valid |
| `resource AUTOSTART 1 <pin>` | none | any free pin | push-button between that pad and GND (internal pull-up) |
| `dshot_bidir` | `OFF` | `OFF`, `ON` | keep `OFF` and take RPM/voltage from the ESC's TX wire. With `ON`, a BLHeli_32 ESC that stays powered while the board restarts (USB bench: every Save) sometimes stops answering until the battery is re-plugged — 2 of ~25 restarts on the real bench, 0 of 50+ with `OFF` (2026-10-20) |
| `debug_mode = AUTOSTART` | on in this build | — | debug[0..7] = state, % ×10, ms in state /10, uptime 0.1 s, flags (USB·RX·button·battery), battery 0.1 V, time since battery 0.1 s, source |

Change the target to 80 %:

```
set autostart_throttle = 80
save
```

## Wiring (HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A, 6S)

![Wiring diagram](docs/img/wiring-en.png)

- Use the 8-wire cable that comes with the FC (colours on the `4321RCGB` connector: white ×4, yellow, green, black, red). Three joints: ESC **yellow** → cable **white** (pin `1`; this build drives all four whites), ESC **black** → cable **black** (`G`), a new thin wire from **battery +** → cable **red** (`B`). **Recommended 4th joint:** ESC pad **`TX`** → cable **yellow** (`R`, telemetry input; on this board the yellow of either 8-pin cable works): the ESC's voltage, RPM and temperature, used by the web configurator to calibrate the battery voltage without a multimeter; turn it on once in the CLI: `feature ESC_SENSOR`, `save` (UART5 already has the ESC-sensor function in this build) — `TX` sits next to `V+`, no solder bridge. The green, the other whites (and the yellow without TX) are cut and insulated, each separately; the cable's red carries battery voltage.
- The FC's ground comes through the ESC's black signal wire (the ESC's `GND` pad is the battery minus); the ESC has no BEC. **Max 8S on `B`.**
- Optional button: top-side pads **`RX4`** (PA1) + the **`GND`** pad next to it; the full CLI sequence (it frees UART4 and its GPS function first) is in [docs/wiring.md](docs/wiring.md).
- Correct wiring = on battery the ESC plays 3 rising tones, then 1 low + 1 high tone (signal seen, armed).

Details and sources: [docs/wiring.md](docs/wiring.md).

## Install

1. Download the `.hex` from [Releases](https://github.com/AndriiShramko/shramko-betaflight-motor-autostart/releases) (or build it, below).
2. Flash with Betaflight Configurator (*Load firmware [Local]*) or `python tools/flash_dfu.py COM6 firmware.hex` (STM32CubeProgrammer CLI, no Configurator).
3. **Remove the propeller**, then check the settings in the CLI (`get autostart`). Flashing this firmware over another Betaflight resets all settings once (Betaflight does that when a parameter group is added) — this build's defaults already are the reference settings (DShot300, `dshot_bidir` OFF, `debug_mode` AUTOSTART, autostart 10 s / 10 s / 15 % on motors 1–4, 6S cut-off 3.30 V/cell, USB inhibit OFF).
4. Two settings are not in the build and are set once in the CLI: `feature ESC_SENSOR` (with the ESC TX wire), and `vbat_scale` calibrated against a multimeter or the ESC's voltage (the build's 210 read 40.5 % high on the author's unit, 149 fixed it; calibrate yours: AGENT_PORTING.md, step 8). Then `python tools/check_reference.py COM6 --vbat-scale <yours>` must say `RESULT: PASS`.
5. Bench check over USB (no battery: `set autostart_vbat_min = 0`, and back to `60` afterwards), or "hot" with the battery and ESC attached (props off):
   `python tools/autostart_selftest.py COM6 --plot ramp.png` (`pip install pyserial matplotlib`) — reboots the board and prints PASS/FAIL, the measured curve and the board's battery voltage (ESC RPM only with `dshot_bidir` ON).

## Verified on hardware (2026-10-19, HGLRC F405 8S V2, no ESC)

| Test | Result |
|---|---|
| Reconstructed board config vs vendor firmware | `dump hardware` identical (except compass support) |
| Power-on, 10 s / 10 s / 15 % | starts 10.0 s, target at 20.0 s, plateau 1150 µs exact, R² 0.9999 |
| 3 s / 5 s / 80 % | starts 3.0 s, target at 8.0 s, plateau 1800 µs, slope 160.2 µs/s |
| `autostart_usb_inhibit = ON` with USB connected | motor stays at stop (negative control) |
| `autostart_mode = OFF` | motor stays at stop (negative control) |
| No battery (USB only), battery gate 6.0 V | motor stays at stop (negative control) |
| Battery gate off, final firmware | starts 10.06 s, target at 19.95 s, max deviation 1.0 µs |
| Bidirectional DShot ON | same curve; telemetry correctly reports "no ESC" |
| CLI `set autostart_throttle = 80` while running (red-team case) | motor **stops** (no jump to 80 %), no restart |
| Configurator Motors tab writes 1300 µs while running | program yields, motor stays at 1300 µs, slider back → 1000 |
| Receiver (MSP receiver driven from the PC): link on, AUX off | autostart never drives the motor |
| … AUX2 → `autostart_box` | same program runs, target at 20.0 s |
| … link lost | motor stops, no restart |
| Reviewed firmware, final ramp | delay 10.01 s, ramp 10.00 s (host clock 10.03 s), max deviation 1.0 µs |

Tools: `tools/autostart_selftest.py` (timing measured on the FC clock, independent of the expected values; `--self-check` proves the evaluator rejects a ramp 1 s early/late or a wrong plateau), `tools/interference_test.py`, `tools/rx_arbitration_test.py`. Raw data: [docs/selftest/](docs/selftest/). 76 googletest cases of the state machine: 74 unit tests and 2 randomized property tests (1760 random sequences, 10.5 M ticks, 50 invariants checked every tick) (incl. battery plugged later / unplugged / glitch, settings change while running, CLI session, Motors-tab takeover, hold until reboot after CLI/STOP on a USB bench, EMI spikes on the button pin; the safety cases are checked with code mutants that must fail them) (Betaflight googletest harness) + regression tests of the touched modules: `docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/test.sh` (PowerShell: `"${PWD}:/repo"`). The board tools have their own tests: `python -m unittest discover -s tools/tests`.

### Web configurator on the real board (2026-10-20, Chrome on Windows 10, live site)

`site/tools/e2e-real.mjs` drives https://autostart.flyreelstudio.eu the way a visitor does: real Chrome,
Chrome's own port picker (answered through Windows UI Automation by `site/tools/pick-serial-port.ps1`),
mouse and keyboard on the page, then the board's own CLI checks the result with the browser closed.

| Step | Result |
|---|---|
| Port picker | lists only the board (`Betaflight STM32F405 (COM6)`); Bluetooth ports hidden, "Board not in the list? Show all ports" lists everything |
| Connect | board, firmware, build and "this build has the autostart module" shown |
| Live view, USB only | "Waiting for the battery", "No battery (USB power only)", "No answer from an ESC" |
| STOP | acknowledged; live view: "Program stopped" (held until a restart) |
| Restart program | dialog, *Restart now* blocked until the safety box is ticked; board reboots, page reconnects by itself |
| Read settings | every value matches the board |
| Change 6 values (number, %, choice, "until cut-off" box, volts, motor boxes) → Save | "Saved and verified: 6 values"; board CLI afterwards: exactly the new values |
| The same back to the defaults | "Saved and verified: 6 values"; board CLI: defaults again |
| Feedback (bug + diagnostics) | report number shown, stored with diagnostics, marked as a test (not sent to the owner's chat) |

Found and fixed by this run: picking a Bluetooth port gave a misleading "port is busy" (now the list is
filtered and a Bluetooth pick says so); *Read settings* or *STOP* on a USB bench did not keep the program
from starting when the battery was plugged in afterwards (firmware now holds it until a reboot, `debug[4]` bit 64).

## Build from source

```
git -c core.autocrlf=false clone https://github.com/AndriiShramko/shramko-betaflight-motor-autostart
cd shramko-betaflight-motor-autostart
docker build -t shramko-bf-build:2025.12.1 build
docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1 bash /repo/build/build.sh HGLRC_F405_S8
```

Windows: PowerShell `-v "${PWD}:/repo"`, Git Bash `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" ...`; Docker Desktop must be running. Apple Silicon: add `--platform linux/amd64`. Output: `out/betaflight_2025.12.1_STM32F405_HGLRC_F405_S8_autostart.hex`.

**Another board:** `python tools/make_board_config.py <BOARD> --cells <N> --motors <MASK>` takes the board's `config.h` from [betaflight/config](https://github.com/betaflight/config/tree/2025.12-config) (branch `2025.12-config`), replaces the lines the project sets itself and appends the reference block; then build with `<BOARD>`. Adding only `#define USE_AUTOSTART` gives the generic defaults (mode OFF, motor 1, USB inhibit ON, cells auto, DShot600), not the reference. The whole procedure, with flashing, settings and checks: [AGENT_PORTING.md](AGENT_PORTING.md).

## Limitations

- Not a flight firmware configuration: use it to drive motors on the ground.
- BLHeli_32 ESCs can still be configured (BLHeliSuite32 32.10) but no longer flashed; if an ESC reports "activation failed" it accepts PWM only — set `motor_pwm_protocol = PWM`.
- The HGLRC F405 8S pin map comes from the vendor's diagram and silkscreen; HGLRC publishes no schematic.

## Author & working together

<img src="docs/assets/andrii-shramko.webp" alt="Andrii Shramko" width="120" height="120" align="left">

**Andrii Shramko** — I build drone and 360° camera systems for extreme shoots (storm chasing, city-scale 3D/4D Gaussian-splat scans) and the tools around them. This firmware runs the water-clearing blower of a camera case that has to work with nobody touching it.

**Open to interesting people and ready to help teams build ambitious projects** — embedded and drone hardware, camera rigs, scanning pipelines, partnerships, licensing or funding. Get in touch:

- 📅 Book a call: <https://calendar.app.google/Ff729HqGk4RpzPNDA>
- 💼 LinkedIn: <https://www.linkedin.com/in/andrii-shramko/>
- ✉️ Email: zmei116@gmail.com
- 🐙 GitHub: <https://github.com/AndriiShramko>

<br clear="left">

## License & credits

GPL-3.0-or-later, like Betaflight — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). © 2026 Andrii Shramko. Built on [Betaflight](https://github.com/betaflight/betaflight). If you use it, please credit it — see [`CITATION.cff`](CITATION.cff). Not affiliated with Betaflight, HGLRC or Flycolor.
