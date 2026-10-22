# AGENT_PORTING.md: build Shramko Motor Autostart for another board, set up like the reference

For an AI agent whose user wants this firmware on **their own** flight controller, set up the same way as the author's
board. Follow the steps in order. Do not invent setting names or values, and do not skip a check. Setting names,
ranges and meanings: [`docs/settings.md`](docs/settings.md). Reference values:
[`configs/reference/reference.json`](configs/reference/reference.json).

**The reference setup** is Andrii Shramko's own board: HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A (BLHeli_32) on
a 6S LiPo, firmware 1.1.1. When the battery is plugged in, it waits 10 s, ramps linearly over 10 s to 15 % and holds.
It stops the motor when the battery stays below 3.30 V per cell for 5 s. It needs no receiver.

**HGLRC F405 8S V2 (`board_name HGLRC_F405_S8`)?** Nothing needs building. Do steps 1–3, skip 4–6, flash the ready
release `.hex` in step 7, then do steps 8–10 (step 8.0 adapts it to the user's battery).

## The prompt (what the user gives you)

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

## 0. What "the same as the reference" means

| Layer | Reference value | How you reproduce it |
|---|---|---|
| Build defaults (the project block at the end of `config.h`) | all `autostart_*` values, DShot300, `dshot_bidir` OFF, `debug_mode` AUTOSTART | `tools/make_board_config.py` (step 5): identical, except what the user's hardware needs (`--cells`, `--motors`, and `--usb-inhibit` if chosen or forced) |
| Board-level CLI, set once after the first boot | `feature ESC_SENSOR` on, with the ESC's TX wire on a UART RX pad (function 1024) | `configs/<BOARD>/after-flash.txt` (step 8) |
| Per-unit calibration | `vbat_scale` makes the board's voltage match a multimeter (reference unit: 149) | measure (step 8). **Never copy 149** |
| Not part of the reference | the ESC's own settings (direction, timing, beeps), receiver, OSD, LED strip | leave them, or take them from the user's backup if the user wants them |

Values that follow the user's hardware. Never copy them blindly:
- `autostart_cells` is the series cell count of **their** pack (reference 6). A wrong count makes the cut-off wrong.
  For example, a full 4S (16.8 V) with 6 is below the 19.8 V cut-off: the program goes to LOW_BATTERY during the
  countdown, about 8 s after plug-in, and the motor never starts (beeps every 3 s).
- `autostart_motors` is a bitmask of the outputs **whose motor should spin**: 1 = output 1, 15 = outputs 1–4. The
  reference is 15 because the HGLRC build drives outputs 1–4 with the same signal, so any of its cable's four
  separate white wires works; only one ESC is attached. **With a 4-in-1 ESC or a quad, 15 spins every motor on
  outputs 1–4.** A 4-in-1 with one motor on M1: 1.
- `vbat_scale` is calibrated on **their** board.
- `autostart_usb_inhibit` is OFF in the reference: with a battery in, the motor may spin while a computer is
  connected. The battery gate keeps a USB-only bench safe. ON makes it never spin while USB is connected. That is
  safer, but then nothing can be measured over USB with the motor powered.

## 1. Rules

- **Propeller or blower wheel off** before anything is flashed, connected or powered. Ask the human to confirm it at
  the start of every session. In POWER mode the motor starts by itself 10 s after a battery is plugged in.
- **The battery stays unplugged** (USB only) while you flash, change settings or restart the board, unless a step
  says to plug it in. Before any save or restart that could start the program, prove there is no battery:
  `python tools/fc_peek.py <PORT> 3` must show `batt=` below 1 V and no `escV=` above 1 V.
- Never exceed the input voltage rating of the user's flight controller and ESC (the HGLRC F405 8S V2 takes 8S;
  most boards take less). Ground use only.
- Battery work: `autostart_mode = OFF` is saved before the battery goes in, test runs are capped with
  `autostart_run_time` of 15 s or less, and POWER goes back only with the battery unplugged. `tools/battery_test.py`
  works this way.
- Only one program can use the board's serial port. Close the Betaflight App and the web configurator before
  running a tool, and do not open the port while the human or another program uses it.
- Entering the CLI stops a running program and holds it until the board restarts. `save` and `exit` restart
  the board.
- Prove every claim by reading it back (`tools/check_reference.py`), not by "the command ran".
- You do the technical work. The human does the physical actions and makes the decisions.
- Never upload the user's configuration anywhere, never commit it (the `backup/` folder is git-ignored), never
  commit secrets.

## 2. Ask the human (one message, only what you cannot read yourself)

1. Is the propeller off? (always)
2. Board model, if the prompt does not name it. You read `board_name` yourself in step 3.
3. ESC: model and firmware family (table below). Single ESC or 4-in-1? Which motors are connected?
4. Which motor pad the ESC signal is soldered to (M1, M2, ...), and which motors should spin. This gives `--motors`.
5. Battery: cell count and chemistry. This gives `--cells`. The 3.30 V/cell cut-off suits LiPo and is conservative
   for Li-ion (it stops earlier).
6. The input rating (cells) of the flight controller and of the ESC. Stop if the pack exceeds either.
7. Is the ESC's TX (telemetry) pad wired to the board? To which pad? `R4`, `RX4` or `T4/R4` means UART4.
8. Does the board's battery pad (VBAT / `B`) get the same battery that powers the ESC? **If not, stop:** the battery
   gate and the cut-off measure that pad. A board on a BEC, or with VBAT not connected, never starts, or cuts off
   wrongly. Tell the human the wiring has to change.
9. Is there a multimeter for the voltage calibration? (Needed when there is no ESC TX wire.)
10. Should the motor be allowed to spin while a computer is connected (reference: yes)?

| ESC firmware | DShot300 | TX-wire telemetry (`feature ESC_SENSOR`) | Calibrate `vbat_scale` with |
|---|---|---|---|
| BLHeli_32 | yes | yes (the reference) | the ESC's voltage, or a multimeter |
| AM32 | yes | yes, if the ESC has a TX pad | the ESC's voltage, or a multimeter |
| BLHeli_S, Bluejay | yes (BLHeli_S 16.5+) | none: `--esc-telemetry none` | a multimeter only |
| PWM-only ("activation failed") | no: `set motor_pwm_protocol = PWM` | none | a multimeter only |

## 3. Get the tools, read the board, back it up (read-only)

1. Clone the repository and install the tool dependency. Docker is not needed yet:
   ```
   git -c core.autocrlf=false clone https://github.com/AndriiShramko/shramko-betaflight-motor-autostart
   cd shramko-betaflight-motor-autostart
   pip install -r tools/requirements.txt
   ```
2. Find the port (USB only, no battery): `python -m serial.tools.list_ports -v` and look for `VID:PID=0483:5740`.
   On Windows that is a `COMn`, on Linux `/dev/ttyACM0`, on macOS `/dev/cu.usbmodem*`.
3. Save the CLI output into `backup/`. This is the user's backup: the first flash of this firmware resets **all**
   settings. The final `exit` restarts the board without saving.
   ```
   mkdir backup
   python tools/bf_cli.py <PORT> "version" "status" "diff all" "dump hardware" "exit" > backup/<BOARD>-before.txt
   ```
   In Windows PowerShell use `| Out-File -Encoding utf8 backup/<BOARD>-before.txt` instead of `>`. Check the file:
   it must contain `board_name` and the `diff all` output (`# start the command batch`). Tell the human where it is.
4. From `version`, take `board_name` and the MCU (`Betaflight / STM32F405 ...`); on older firmware the MCU is on the
   `MCU:` line of `status`. Then check:
   - the MCU is in [appendix C](#appendix-c-mcu-support). Otherwise stop: Betaflight 2025.12.1 cannot build it.
     For any status other than "hardware-tested", tell the human and get a go-ahead before step 7.
   - `status` has a `GYRO:` line naming a chip, such as `GYRO: (1) ICM42688P enabled ...` (`GYRO=` on 4.x).
     `GYRO: None` means no gyro: stop, because Betaflight drives the motors only with a working gyro.
   - `board_name` is `HGLRC_F405_S8`: skip steps 4–6 and flash the ready release `.hex` in step 7.

The board is not connected yet? The config name is usually the vendor and model without punctuation
(`MATEKF722SE`). Build with that, confirm `board_name` in step 3 later, and rebuild if it differs.

## 4. Prepare the build machine

- Install Docker Desktop (Linux containers). Docker must be running: `docker version` has to print a `Server`
  section. On Windows, start it with `Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"`, then retry
  `docker info` until it answers.
- Build the image once: about 3 GB, 5–15 minutes. It holds Betaflight 2025.12.1 and the Arm toolchain.
  ```
  docker build -t shramko-bf-build:2025.12.1 build
  ```
  An image built before 2026-10-22 lacks `xxd`, which H730/H750 boards need. Check it with
  `docker run --rm shramko-bf-build:2025.12.1 bash -c "command -v xxd"`, and rebuild if nothing is printed.
  Apple Silicon or ARM Linux: add `--platform linux/amd64` here and to every `docker run` below.

The `docker run` volume flag differs by shell. Use the right form, or the container sees an empty `/repo`:

| Shell | `docker run` prefix |
|---|---|
| Linux / macOS (bash, zsh) | `docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1` |
| Windows PowerShell | `docker run --rm -v "${PWD}:/repo" shramko-bf-build:2025.12.1` |
| Windows Git Bash | `MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" shramko-bf-build:2025.12.1` |
| Windows cmd | `docker run --rm -v "%cd%:/repo" shramko-bf-build:2025.12.1` |

Below, `<RUN>` means the prefix for your shell.

## 5. Make the board config

```
python tools/make_board_config.py <BOARD> --cells <N> --motors <MASK> --esc-telemetry <UARTn|none> [--usb-inhibit ON]
```

It does the following:
1. Downloads `configs/<BOARD>/config.h` (and `config.c`, if the board has one) from betaflight/config branch
   `2025.12-config`, the flat layout Betaflight 2025.12.1 builds with. Do not use `master`: it nests boards
   as `configs/<MANUFACTURER_ID>/<BOARD>/` and targets newer firmware.
2. Comments out the board's own `DEFAULT_MOTOR_DSHOT_SPEED`, `DEFAULT_DSHOT_TELEMETRY` and `DEBUG_MODE`. A second
   `#define` fails the build (`-Werror`), and 20 boards turn bidirectional DShot on.
3. Appends the project block, **last** in the file. `build.sh --stock` cuts from its marker line to the end.
4. Writes `configs/<BOARD>/config.h` and `configs/<BOARD>/after-flash.txt` (the exact commands for steps 8 and 9).
   It prints notes, warnings, the source commit, the config's SHA-256 and the build command for every shell.

Read every `note:` and `WARNING:` line before you build:
- `no gyro driver of Betaflight 2025.12.1`: the board cannot run this firmware. Stop and tell the human.
- `EXST board`: the firmware lives in external flash and is written only through the board vendor's bootloader.
  This protocol does not cover that flashing: stop before step 7 and ask the human.
- `no ADC voltage meter`: no battery gate and no cut-off, so the countdown starts at boot. The tool then sets
  USB inhibit ON. Tell the human.
- `ESC telemetry UART preset by config.h: UART5 (RX pad PD2)`: that UART's RX pad is where the ESC TX goes.
  Otherwise the tool lists the UARTs that have an RX pad and no other preset function, with their pins. Pass the one
  the human wired. If the wired pad is not in the list (for example the receiver's UART), ask the human. Lines
  starting with `config.h says:` quote the board's own comments about ESC telemetry: read them.
- `--cells / --motors / --esc-telemetry not given`: the reference values were used. Decide them with the human.
- `BOARD_NAME is X`: a few folders differ from their `board_name` (`BROTHERHOBBYF405V2` reports `BHF405V2`).
  If a download fails, the tool lists folders with a similar name.
- `PINIO boxes 40 ...`: only matters if the user later wants an RC switch (`autostart_box`). Pick an unused id
  from 40–43.

Other cases:
- Not on `2025.12-config`: check the exact name, then see [appendix A](#appendix-a-the-board-is-not-in-betaflightconfig).
- Your own file: `--from path/to/config.h`.

## 6. Build and test

```
<RUN> bash /repo/build/build.sh <BOARD>
<RUN> bash /repo/build/test.sh
python -m unittest discover -s tools/tests
```

- The build ends with `>> built /repo/out/betaflight_2025.12.1_<MCU>_<BOARD>_autostart.hex`. The file is in
  `out/` of the clone. EXST boards also print `objcopy: warning: empty loadable segment`: harmless.
- `test.sh` prints 5 `PASS` lines: the module's googletest suite and the Betaflight suites it touches.
- The tool tests end with `OK`.
- Optional: `<RUN> bash /repo/build/build.sh <BOARD> --stock` builds the same Betaflight without the module, to
  go back later.
- A rebuild is never byte-identical to a release: the commit and the build time are embedded. Prove the setup in
  step 9 (`--commit`), not by comparing hashes.

## 7. Flash

1. Preconditions: the propeller is off, **the battery is unplugged** (the new firmware boots in POWER mode), and
   the backup from step 3 holds `board_name` and the `diff all` output. Ask the human to confirm.
2. Windows with STM32CubeProgrammer installed (the path is in `tools/flash_dfu.py`):
   `python tools/flash_dfu.py <PORT> <file.hex>`. It enters the bootloader, writes, verifies and starts the firmware.
   It refuses an EXST hex.
3. Otherwise the human uses the Betaflight App (<https://app.betaflight.com> in Chrome or Edge, or the desktop app);
   tell them each click: Firmware Flasher → **Load Firmware [Local]** → choose the `.hex` → **Flash Firmware**.
   If the board does not enter DFU, the human holds the BOOT button while plugging USB in.
4. Windows says "DFU device not found": install the ImpulseRC Driver Fixer
   (<https://impulserc.com/pages/downloads>), or Zadig (WinUSB for "STM32 BOOTLOADER").
5. EXST boards (H730/H750): only through the vendor's bootloader. Never the BOOT button or the ROM DFU, never a
   full chip erase: it wipes the vendor bootloader.
6. The first boot resets every setting to the build defaults. This is expected: the new parameter group is not in
   the board's memory yet. Receiver, OSD and so on are gone too; the backup has them.

## 8. Board-level settings and the voltage calibration

USB only, no battery:
0. **Ready release `.hex` only** (HGLRC_F405_S8): it is built for 6S, outputs 1–4 and USB inhibit OFF. Set what
   the user's hardware needs, for example
   `python tools/bf_cli.py <PORT> "set autostart_cells = 4" "set autostart_motors = 1" "save"`.
   `configs/HGLRC_F405_S8/after-flash.txt` has the rest.
1. Send the commands from `configs/<BOARD>/after-flash.txt`. The file has them as one `bf_cli.py` line, for
   example `python tools/bf_cli.py <PORT> "serial UART4 1024 115200 57600 0 115200" "feature ESC_SENSOR" "save"`.
   If it says "Nothing to send", skip this. `bf_cli.py` leaves without saving if a `set` is not confirmed; the
   `serial` and `feature` lines are checked in step 9.
2. From the backup, put back only what the user asks for, such as receiver or OSD. Never put back the old
   `dshot_bidir`, `motor_pwm_protocol`, `debug_mode`, `battery_meter`, `vbat_scale` or any `autostart_*` line:
   they would undo the reference.

Calibrate `vbat_scale`. This needs a battery, the propeller off and the human present:
1. Before the battery goes in: `python tools/bf_cli.py <PORT> "set autostart_mode = OFF" "save"`. Read the current
   value too: `python tools/bf_cli.py <PORT> "get vbat_scale" "exit"` (it is the board's config default, often
   110, 210 on the HGLRC: not the reference's 149).
2. The human plugs the battery in. Read the board: `python tools/fc_peek.py <PORT> 5` prints `batt=` and, with the
   ESC TX wire, the ESC's own `escV=`.
3. The real voltage comes from a multimeter on the battery leads, or from `escV`. Then
   `new = round(old × real / shown)`, `set vbat_scale = <new>`, `save`, and read it again: done when it is within
   2 %. With the ESC TX wire, `python tools/battery_test.py <PORT> --only 0,1 --apply-scale` does steps 2–3 for you
   and reports a FAIL when it cannot calibrate. Without a TX wire and without a multimeter, leave `vbat_scale`
   as it is and report the cut-off as **not calibrated**.
4. The human unplugs the battery. Confirm with `python tools/fc_peek.py <PORT> 3` (`batt=` below 1 V, no `escV`),
   then `python tools/bf_cli.py <PORT> "set autostart_mode = POWER" "save"`, or
   `python tools/battery_test.py <PORT> --finish`, which refuses while a battery is connected.

On the reference unit the config default 210 read 40.5 % high, and 149 fixed it. Your board has its own value.

## 9. Verify

1. **Settings** (USB only). Use the command at the end of `after-flash.txt`, completed:
   ```
   python tools/check_reference.py <PORT> --cells <N> --motors <MASK> --vbat-scale <calibrated> --commit <built commit> --board <board_name> --exit
   ```
   - `--no-esc-sensor`: no ESC TX wire.
   - `--usb-inhibit ON`: you chose it, or step 5 forced it.
   - `--no-vbat-meter`: step 5 warned about the voltage meter.
   - `--protocol PWM`: the ESC needs PWM.
   - Ready `.hex`: `--commit 3c1808c`.

   It must end with `RESULT: PASS`. It checks the firmware build and commit, `board_name`, the gyro, every
   `autostart_*` value, the motor protocol, `dshot_bidir` OFF, `debug_mode` AUTOSTART, `battery_meter`,
   `feature ESC_SENSOR` with its UART, and `vbat_scale`; a `WARN` on `vbat_scale` means it was never calibrated.
   `--exit` restarts the board (no save), so it is not left in the CLI. Without a port, the human can run
   `version`, `status`, `get autostart`, `get motor_pwm_protocol`, `get dshot_bidir`, `get debug_mode`,
   `get vbat_scale`, `get battery_meter`, `feature` and `serial` in the Betaflight App's CLI tab. Save the text to a
   file and run `python tools/check_reference.py --from-file cli.txt ...`.
2. **The ramp, measured** (USB only, ESC unpowered: nothing turns). Confirm no battery with `fc_peek.py`, then
   `set autostart_vbat_min = 0` and `save`. Run `python tools/autostart_selftest.py <PORT> --motor <first output of the mask>`
   (1-based). It must print PASS: the ramp starts after 10 s and reaches 15 % after 10 s more. It refuses if it sees
   a battery, and sends STOP at the end. **The battery stays out** until `set autostart_vbat_min = 60` and `save` are
   done. Then run 9.1 again. With USB inhibit ON, the program cannot run on USB: skip this and report "ramp not
   measured, seen in 9.3".
3. **With the battery** (propeller off, the human present):
   - Cap the run first (USB only): `set autostart_run_time = 15`, `save`.
   - The board must not be in the CLI: restart it (`check_reference.py --exit`, or replug USB). With USB inhibit
     ON, unplug USB.
   - The human plugs the battery in. The motor starts after 10 s, ramps for 10 s, runs 15 s and stops by itself.
   - The human unplugs the battery. Then, USB only: `set autostart_run_time = 0`, `save`, and run 9.1 again for the
     final `RESULT: PASS`.
   - Optional: `python tools/battery_test.py <PORT>`. It runs idle, voltage, capped run, gusts, STOP and cut-off, and
     leaves the mode OFF (`--finish` after unplugging). Tests 0–3 need ESC telemetry; without it use `--only 4,5`.
     Test 3 bursts up to `autostart_gust_max` (80 %) on every output of the mask. A full run takes minutes: give it a
     timeout of at least 10 minutes. An interrupted run leaves test values: run 9.1 again afterwards.

## 10. Report to the human

- Board, MCU, firmware file name, its SHA-256 and the repo commit it was built from.
- The `make_board_config.py` command line, the source commit of betaflight/config and the config's SHA-256, all
  printed by the tool.
- What was adapted, with the reason: `autostart_cells`, `autostart_motors`, `autostart_usb_inhibit`, the ESC
  telemetry UART, `vbat_scale` (shown vs measured voltage, or "not calibrated").
- The `check_reference.py` output and the self-test result.
- What was **not** verified, for example "no battery run yet". Only the HGLRC F405 8S V2 is tested on hardware.
- Where the backup is, and how to go back: flash the `--stock` build or the board's original firmware, then
  restore the backup's `diff all`.

## 11. Troubleshooting

| Symptom | Cause, fix |
|---|---|
| `docker: error during connect ... dockerDesktopLinuxEngine` | Docker Desktop is not running (step 4) |
| PowerShell: `Variable reference is not valid` | use `"${PWD}:/repo"` |
| Git Bash: `C:/Program Files/Git/repo/build/...: No such file` | prefix `MSYS_NO_PATHCONV=1`, use `$(pwd -W)` |
| `$'\r': command not found` / `git apply` fails | CRLF checkout: clone again with `-c core.autocrlf=false` |
| `"DEFAULT_MOTOR_DSHOT_SPEED" redefined` | the board's own line is still there: use `make_board_config.py` |
| `DEBUG_AUTOSTART undeclared` in a `--stock` build | the project block is not last, or lost its marker line |
| `xxd: not found` (H730/H750) | the image is older than 2026-10-22: rebuild it (step 4) |
| `check_reference.py`: `firmware ... FAIL` | the board runs other firmware (`version` has no `as-<commit>`) |
| `check_reference.py`: `gyro (status) FAIL` | no gyro detected: wrong config for this board, or a gyro without a 2025.12.1 driver |
| everything at the generic defaults (mode OFF, motors 1, DShot600 or the board's own) | the build had only `USE_AUTOSTART` or no block: rebuild with step 5 |
| the countdown never starts on USB | `autostart_vbat_min` 60 waits for a battery (by design), or USB inhibit ON, or the board is still in the CLI |
| the motor never starts, beeps every 3 s (`debug[0]` = 5, LOW_BATTERY) | `autostart_cells` too high for the pack, or `vbat_scale` reads low |
| the ESC beeps but never spins / "7 low beeps" | the ESC rejects DShot: `set motor_pwm_protocol = PWM`, `save`, replug the battery; again after every config reset; check with `--protocol PWM` |
| ESC stops answering after board restarts | `dshot_bidir` is ON: set it OFF (the reference) |
| `debug[4]` bit 32 / "voltage implausible" | wrong `vbat_scale` or `autostart_cells` |
| `check_reference.py --from-file`: "no `name = value` lines" | the file is empty or not CLI output (UTF-8 and UTF-16 are both read) |

## Appendix A: the board is not in betaflight/config

The author's board is such a case: `configs/HGLRC_F405_S8/config.h` was rebuilt from the vendor firmware's
`dump hardware`.
1. Keep the backup from step 3 (`version`, `status`, `dump hardware`, `diff all`), taken on the vendor firmware.
2. Copy the closest config of the same vendor and MCU from `2025.12-config` to `configs/<board_name>/config.h`, and
   set `BOARD_NAME` to the folder name.
3. Fix what differs, from `dump hardware`:
   - Each `resource` line maps to a pin define: `MOTOR n` → `MOTORn_PIN`, `SERIAL_TX/RX n` → `UARTn_TX/RX_PIN`,
     `LED 1` → `LED0_PIN`, `ADC_BATT 1` → `ADC_VBAT_PIN`, and so on.
   - `set` lines map too, for example `vbat_scale` → `DEFAULT_VOLTAGE_METER_SCALE` and
     `battery_meter = ADC` → `DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC`.
   - `serial` functions give `SERIALRX_UART`, `GPS_UART` and `ESC_SENSOR_UART`.
   - Each `timer` line becomes `TIMER_PIN_MAP(i, pin, occurrence, dmaopt)`. Get the occurrence from `timer <pin> list`
     on the board; dmaopt comes from `dma pin <pin>`.
4. Run `python tools/make_board_config.py <board_name> --from configs/<board_name>/config.h --force ...`, then build
   (step 6).
5. Proof: flash the `--stock` build first, run `dump hardware` and compare it line by line with the vendor's.
   Every difference in a `resource`, `timer` or `dma` line is a config error.

## Appendix B: the project block

| Macro | Reference | Without it (generic build) | CLI setting |
|---|---|---|---|
| `USE_AUTOSTART` | defined | stock Betaflight | the module itself |
| `AUTOSTART_DEFAULT_MODE` | `AUTOSTART_MODE_POWER` | `OFF` | `autostart_mode` |
| `AUTOSTART_DEFAULT_DELAY_S` | 10 | 10 | `autostart_delay` |
| `AUTOSTART_DEFAULT_RAMP_DS` | 100 (10.0 s) | 100 | `autostart_ramp` |
| `AUTOSTART_DEFAULT_THROTTLE_PCT` | 15 | 15 | `autostart_throttle` |
| `AUTOSTART_DEFAULT_MOTOR_MASK` | 0x0F (`--motors`) | 0x01 | `autostart_motors` |
| `AUTOSTART_DEFAULT_USB_INHIBIT` | 0 (`--usb-inhibit`) | 1 | `autostart_usb_inhibit` |
| `AUTOSTART_DEFAULT_VBAT_MIN_DV` | 60 (6.0 V) | 60 | `autostart_vbat_min` |
| `AUTOSTART_DEFAULT_CELLS` | 6 (`--cells`) | 0 (auto-detect) | `autostart_cells` |
| `AUTOSTART_DEFAULT_CELL_CUTOFF_CV` | 330 | 330 | `autostart_cell_cutoff` |
| `DEFAULT_MOTOR_DSHOT_SPEED` | `MOTOR_PROTOCOL_DSHOT300` | the board's own, else DShot600 | `motor_pwm_protocol` |
| `DEBUG_MODE` | `DEBUG_AUTOSTART` | `NONE` | `debug_mode` (the configurator's live view and the tools need it) |

Every build gets the rest without a macro: `autostart_cutoff_time` 5, `autostart_run_time` 0,
`autostart_throttle_limit` 100, `autostart_pattern` STEADY, `autostart_box` 255, gusts 40/80 %, 300/800 ms and
20/80 × 0.1 s. `dshot_bidir` is OFF by Betaflight's default unless the board's config sets
`DEFAULT_DSHOT_TELEMETRY` (20 boards set it ON); `make_board_config.py` comments that line out.

## Appendix C: MCU support

Only the HGLRC F405 8S V2 (STM32F405) is tested on hardware. The patch has no board-specific code.

| `FC_TARGET_MCU` | Status (2026-10-22) |
|---|---|
| STM32F405 | hardware-tested (HGLRC F405 8S V2); SpeedyBee F405 V4 and AocodaRC F405 AIO build |
| STM32F411, STM32F7X2, STM32F745, STM32H743, STM32G47X, AT32F435G, AT32F435M | build (MATEKF411, MATEKF722SE, FOXEERF745V4_AIO, MATEKH743, FLYCOLORH743, SPEDIXG473, DAKEFPVF435, SKYSTARSF435PRO), not tested on hardware. The module adds about 3–6 KB of flash |
| STM32H730, STM32H750 (EXST) | build (SPRACINGH7EVO) with the current image; flashing goes through the vendor's bootloader and is not covered here |
| STM32H723, STM32H725, STM32H735, STM32F446, APM32F405, APM32F407, RP2350A/B | have a platform, not built yet |
| STM32H563 | experimental: no DShot (PWM only), no USB serial port (CLI and tools only through a UART adapter), no beeper |
| anything else (STM32N657, STM32C562, ...) | no platform in Betaflight 2025.12.1: cannot be built |

Author: Andrii Shramko. Book a call: <https://calendar.app.google/Ff729HqGk4RpzPNDA> ·
<https://www.linkedin.com/in/andrii-shramko/> · zmei116@gmail.com. Open to teams that want to build on this.
