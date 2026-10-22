# AGENT_PORTING.md: build Shramko Motor Autostart for another board, set up like the reference

For an AI agent whose user wants this firmware on **their own** flight controller, set up the same way as the author's
board. Follow the steps in order. Do not invent setting names or values, and do not skip a check. Setting names,
ranges and meanings: [`docs/settings.md`](docs/settings.md). Reference values:
[`configs/reference/reference.json`](configs/reference/reference.json). Risks: [`docs/warnings.md`](docs/warnings.md).

**The reference setup** is Andrii Shramko's own board: HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A (BLHeli_32) on
a 6S LiPo, firmware 1.1.1. When the battery is plugged in, it waits 10 s, ramps linearly over 10 s to 15 % and holds.
It stops the motor when the battery stays below 3.30 V per cell for 5 s. It needs no receiver.

**HGLRC F405 8S V2 (`board_name HGLRC_F405_S8`)?** Nothing needs building: no Docker, no build tests. Do steps 1–3,
skip 4–6, flash the ready release `.hex` in step 7, then do steps 8–10 (step 8.0 adapts it to the user's battery).
The file is `betaflight_2025.12.1_STM32F405_HGLRC_F405_S8_autostart.hex` (not `_stock`) from
<https://github.com/AndriiShramko/shramko-betaflight-motor-autostart/releases/latest>. Check its SHA-256 against the
release's `SHA256SUMS.txt` (`Get-FileHash` / `sha256sum`). The v1.1.1 firmware reports revision `as-3c1808c`: the
tag's later commits changed only tools and docs.

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
- `autostart_motors` is a bitmask of the outputs **whose motor should spin**: output n is 2^(n−1), so output 1 = 1,
  output 3 = 4, outputs 1–4 = 15. The default mixer (QUADX) drives outputs 1–4 only. The reference is 15 because
  the HGLRC build drives outputs 1–4 with the same signal, so any of its cable's four separate white wires works;
  only one ESC is attached. **With a 4-in-1 ESC or a quad, 15 spins every motor on outputs 1–4.** A 4-in-1 with one
  motor on M1: 1.
- `vbat_scale` is calibrated on **their** board.
- `autostart_usb_inhibit` is OFF in the reference: with a battery in, the motor may spin while a computer is
  connected. The battery gate keeps a USB-only bench safe. ON makes it never spin while 5 V is on USB (computer,
  charger, power bank). That is safer, but then nothing can be measured over USB with the motor powered.

## 1. Rules

- **Propeller or blower wheel off** before anything is flashed, connected or powered. Ask the human to confirm it at
  the start of every session. In POWER mode the motor starts by itself 10 s after a battery is plugged in.
- **The battery stays unplugged** (USB only) while you flash, change settings or restart the board, unless a step
  says to plug it in. Before any save or restart that could start the program, prove there is no battery:
  `python tools/fc_peek.py <PORT> 3` must end with `no battery` (exit code 0). `NO MSP ANSWER` (the board is in the
  CLI or rebooting) proves nothing: replug USB with the battery out and run it again. `NOT MEASURED` (no voltage
  meter) proves nothing either: there only the human's confirmation counts. `escV=` is the last value the ESC sent
  and stays after unplugging: never use it as proof.
- Never exceed the input voltage rating of the user's flight controller and ESC, and never go below the ESC's
  minimum. Ground use only.
- Battery work: `autostart_mode = OFF` is saved and read back before the battery goes in, test runs are capped
  with `autostart_run_time` of 15 s or less, and POWER goes back only with the battery unplugged.
  `tools/battery_test.py` works this way.
- Only one program can use the board's serial port. Close the Betaflight App and the web configurator before
  running a tool, and do not open the port while the human or another program uses it.
- Entering the CLI stops a running program and holds it until the board restarts. `save` and `exit` restart
  the board; `exit noreboot` leaves the CLI without a restart, and the program stays held.
- Every `bf_cli.py` call that sets something must exit 0. A non-zero exit means nothing was saved: stop there.
- Prove every claim by reading it back (`tools/check_reference.py`), not by "the command ran".
- You do the technical work. The human does the physical actions and makes the decisions.
- Never upload the user's configuration anywhere, never commit it (the `backup/` folder is git-ignored), never
  commit secrets.

## 2. Ask the human (one message, only what you cannot read yourself)

1. Is the propeller off? (always)
2. Board model, and the firmware it runs now (Betaflight, INAV, ArduPilot, other). You read `board_name` yourself in
   step 3. Not Betaflight: see the end of step 3.
3. ESC: model and firmware family (table below). Single ESC or 4-in-1? Which motors are connected?
4. Which motor pad the ESC signal is soldered to (M1/S1, M2/S2, ...: output n), and which motors should spin. This
   gives `--motors`.
5. Battery: cell count and chemistry. This gives `--cells`. The 3.30 V/cell cut-off suits LiPo and is conservative
   for Li-ion (it stops earlier).
6. The input rating (minimum and maximum cells) of the flight controller and of the ESC, from their labels or
   manuals. Stop if the pack is above either maximum or below the ESC's minimum.
7. Is the ESC's TX (telemetry) pad wired to the board? To which pad? `R4`, `RX4` or `T4/R4` means UART4.
8. Does the board's battery pad (VBAT / `B`) get the same battery that powers the ESC? **If not, stop:** the battery
   gate, the cut-off and the no-battery proof measure that pad. Tell the human the wiring has to change.
9. Is there a multimeter for the voltage calibration? (The multimeter is the reference; the ESC's voltage is the
   fallback.)
10. Should the motor be allowed to spin while a computer is connected (reference: yes)?
11. Every board other than `HGLRC_F405_S8` has never run this firmware: tell the human, and get a go-ahead for the
    flash (step 7).

| ESC firmware | DShot300 | TX-wire telemetry (`feature ESC_SENSOR`) | Calibrate `vbat_scale` with |
|---|---|---|---|
| BLHeli_32 | yes | yes (the reference) | a multimeter, or the ESC's voltage |
| AM32 | yes | yes, if the ESC has a TX pad | a multimeter, or the ESC's voltage |
| BLHeli_S, Bluejay | yes (BLHeli_S 16.5+) | none: `--esc-telemetry none` | a multimeter only |
| PWM-only ("activation failed") | no: `set motor_pwm_protocol = PWM` | none | a multimeter only |

## 3. Get the tools, read the board, back it up (read-only)

1. Clone the repository and install the tool dependency. Docker is not needed yet:
   ```
   git -c core.autocrlf=false clone https://github.com/AndriiShramko/shramko-betaflight-motor-autostart
   cd shramko-betaflight-motor-autostart
   python -m pip install -r tools/requirements.txt
   ```
2. Find the port (USB only, no battery): `python -m serial.tools.list_ports -v` and look for PID `5740` (VID `0483`
   STM32, `2E3C` AT32, `314B` APM32). On Windows that is a `COMn`, on Linux `/dev/ttyACM0`, on macOS
   `/dev/cu.usbmodem*`.
3. Save the CLI output into `backup/`. This is the user's backup: the first flash of this firmware resets **all**
   settings. The final `exit` restarts the board without saving.
   ```
   mkdir -p backup
   python tools/bf_cli.py <PORT> "version" "status" "diff all" "dump hardware" "exit" > backup/before.txt
   ```
   In Windows PowerShell: `New-Item -ItemType Directory -Force backup`, and `| Out-File -Encoding utf8
   backup/before.txt` instead of `>`. Check the file: it must contain `board_name`, the whole `diff all` (from
   `# start the command batch` to `batch end`) and `resource` lines from `dump hardware`. Otherwise run it again.
   Tell the human where it is.
4. From `version`, take `board_name` and the MCU (`Betaflight / STM32F405 ...`); on older firmware the MCU is on the
   `MCU:` line of `status`. Then check:
   - the MCU is in [appendix C](#appendix-c-mcu-support). Otherwise stop: Betaflight 2025.12.1 cannot build it.
   - `status` has a `GYRO:` line naming a chip, such as `GYRO: (1) ICM42688P enabled ...` (`GYRO=` on 4.x).
     `GYRO: None` means no gyro: stop, because Betaflight drives the motors only with a working gyro. Step 5
     (`--backup`) also checks that the new config has a 2025.12.1 driver for that chip.
   - `board_name` is `HGLRC_F405_S8`: skip steps 4–6 and flash the ready release `.hex` in step 7.

The board is not connected yet? The config name is usually the vendor and model without punctuation
(`MATEKF722SE`). Build with that, confirm `board_name` in step 3 later, and rebuild if it differs.

The board runs INAV, ArduPilot or other firmware? There is no Betaflight CLI: the human backs up its settings with
that firmware's own tool, the board is put into DFU with the BOOT button, and the Betaflight App flashes it
(step 7.3). There is no `diff all` to restore later. `board_name` and the gyro are known only after the flash: check
them in step 9.

## 4. Prepare the build machine

- Install Docker Desktop (Linux containers). Docker must be running: `docker version` has to print a `Server`
  section. On Windows, start it with `Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"`
  (PowerShell) or `"$PROGRAMFILES/Docker/Docker/Docker Desktop.exe" &` (Git Bash), then retry `docker info` until it
  answers.
- Build the image once: about 3 GB, 5–15 minutes. It holds Betaflight 2025.12.1 and the Arm toolchain.
  ```
  docker build -t shramko-bf-build:2025.12.1 build
  ```
  An image built before 2026-10-22 lacks `xxd`, which only H730/H750 boards need. Check it with
  `docker run --rm shramko-bf-build:2025.12.1 bash -c "command -v xxd"`; for those boards rebuild if nothing is
  printed. Apple Silicon or ARM Linux: add `--platform linux/amd64` here and to every `docker run` below.

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
python tools/make_board_config.py <CONFIG> --cells <N> --motors <MASK> --esc-telemetry <UARTn|none> --backup backup/before.txt [--usb-inhibit ON]
```

`<CONFIG>` is the config folder name in betaflight/config; it is usually the `board_name`, and the tool finds the
folder when they differ. It does the following:
1. Downloads `configs/<CONFIG>/config.h` (and `config.c`, if the board has one) from betaflight/config branch
   `2025.12-config`, the flat layout Betaflight 2025.12.1 builds with. Do not use `master`: it nests boards
   as `configs/<MANUFACTURER_ID>/<BOARD>/` and targets newer firmware.
2. Comments out the board's own `DEFAULT_MOTOR_DSHOT_SPEED`, `DEFAULT_DSHOT_TELEMETRY` and `DEBUG_MODE`. A second
   `#define` fails the build (`-Werror`), and 20 boards turn bidirectional DShot on.
3. Appends the project block, **last** in the file. `build.sh --stock` cuts from its marker line to the end.
4. Writes `configs/<CONFIG>/config.h` and `configs/<CONFIG>/after-flash.txt` (the exact commands for steps 8 and 9).
   It prints notes, warnings, the source commit, the config's SHA-256 and the build command for every shell.

Read every `note:` and `WARNING:` line before you build:
- Any `WARNING` about the backup (`board_name`, MCU, `gyro ... has no Betaflight 2025.12.1 driver`, `no gyro`):
  wrong config or a board this firmware cannot drive. Stop and tell the human.
- `no gyro driver of Betaflight 2025.12.1`: the board cannot run this firmware. Stop and tell the human.
- `EXST board`: the firmware lives in external flash and is written only through the board vendor's bootloader.
  This protocol does not cover that flashing: stop before step 7 and ask the human.
- `no battery pad in this config`: no battery gate, no cut-off, no no-battery proof, and the countdown starts at
  boot. The tool sets USB inhibit ON. Tell the human. (A board with the pad but the meter switched off gets it
  switched on by the block: a `note`.)
- `ESC telemetry UART preset by config.h: UART5 (RX pad PD2)`: that UART's RX pad is where the ESC TX goes.
  Otherwise the tool lists the UARTs that have an RX pad and no other preset function, with their pins. Pass the one
  the human wired. If the wired pad is not in the list (for example the receiver's UART), ask the human. Lines
  starting with `config.h says:` quote the board's own comments about ESC telemetry: read them.
- `--cells / --motors not given`: the reference 6 / 15 were used. `--esc-telemetry not given`: ESC telemetry was
  left undecided. Decide them with the human.
- `--motors includes outputs above 4`: the mixer drives outputs 1–4 only.
- `BOARD_NAME is X`: the firmware will report `board_name X`; it must equal the `board_name` from step 3.
- `PINIO boxes 40 ...`: only matters if the user later wants an RC switch (`autostart_box`). Pick an unused id
  from 40–43.

Other cases:
- Not on `2025.12-config`: check the exact name, then see [appendix A](#appendix-a-the-board-is-not-in-betaflightconfig).
- Your own file: `--from path/to/config.h`.

## 6. Build and test

```
<RUN> bash /repo/build/build.sh <CONFIG>
<RUN> bash /repo/build/test.sh
python -m unittest discover -s tools/tests
```

- The build ends with `>> built /repo/out/betaflight_2025.12.1_<MCU>_<CONFIG>_autostart.hex`. The file is in
  `out/` of the clone. EXST boards also print `objcopy: warning: empty loadable segment`: harmless.
- `test.sh` prints 5 `PASS` lines: the module's googletest suite and the Betaflight suites it touches.
- The tool tests end with `OK`.
- Optional: `<RUN> bash /repo/build/build.sh <CONFIG> --stock` builds the same Betaflight without the module, to
  go back later.
- A rebuild is never byte-identical to a release: the commit and the build time are embedded. Prove the setup in
  step 9 (`--commit`), not by comparing hashes.

## 7. Flash

1. Preconditions: the propeller is off, the human gave the go-ahead (step 2, question 11), the backup from step 3
   is complete, and **the battery is unplugged** (the new firmware boots in POWER mode):
   `python tools/fc_peek.py <PORT> 3` ends with `no battery`.
2. Windows, STM32 board, STM32CubeProgrammer installed (the path is in `tools/flash_dfu.py`):
   `python tools/flash_dfu.py <PORT> <file.hex>`. It checks the battery over MSP, enters the bootloader, writes,
   verifies and starts the firmware. It refuses an EXST hex. If the board is already in DFU, it cannot check the
   battery: confirm with the human and add `--battery-unplugged`.
3. Otherwise the human uses the Betaflight App (<https://app.betaflight.com> in Chrome or Edge, or the desktop app);
   tell them each click: Firmware Flasher → **Load Firmware [Local]** → choose the `.hex` → **Flash Firmware**.
   If the board does not enter DFU, the human holds the BOOT button while plugging USB in.
4. Windows says "DFU device not found" (the App) or `flash_dfu.py` says "DFU device did not appear": install the
   ImpulseRC Driver Fixer (<https://impulserc.com/pages/downloads>), or Zadig (WinUSB for "STM32 BOOTLOADER").
5. EXST boards (H730/H750): only through the vendor's bootloader. Never the BOOT button or the ROM DFU, never a
   full chip erase: it wipes the vendor bootloader.
6. Over stock Betaflight (or any other firmware) the first boot resets every setting to the build defaults: the
   new parameter group is not in the board's memory yet. Receiver, OSD and so on are gone too; the backup has them.
   Over an earlier Shramko release the settings are kept. Do step 8 either way and check with step 9.

## 8. Board-level settings and the voltage calibration

USB only, no battery:
0. **Ready release `.hex` only** (HGLRC_F405_S8): it is built for 6S, outputs 1–4 and USB inhibit OFF. Another
   pack: `python tools/bf_cli.py <PORT> "set autostart_cells = 4" "save"`. Keep `autostart_motors = 15` with one
   ESC on the HGLRC cable; change it only for a 4-in-1 or several ESCs. `configs/HGLRC_F405_S8/after-flash.txt`
   has the rest: the ESC TX on the yellow `R` of either 8-pin cable is UART5 (preset).
1. Send the commands from `configs/<CONFIG>/after-flash.txt`. The file has them as one `bf_cli.py` line, for
   example `python tools/bf_cli.py <PORT> "serial UART4 1024 115200 57600 0 115200" "feature ESC_SENSOR" "save"`.
   If it says "Nothing to send", skip this. The `serial` and `feature` lines are checked in step 9.
2. From the backup, put back only what the user asks for, such as receiver or OSD. Never put back the old
   `dshot_bidir`, `motor_pwm_protocol`, `debug_mode`, `battery_meter`, `vbat_scale`, `serial` or any `autostart_*`
   line: they would undo the reference.

Calibrate `vbat_scale` (propeller off, the human present). First pick the method:
- **Multimeter** (the reference) or the ESC's own voltage (`escV`, with the ESC TX wire):
  1. Before the battery goes in: `python tools/bf_cli.py <PORT> "set autostart_mode = OFF" "save"`, then
     `python tools/bf_cli.py <PORT> "get autostart_mode" "get vbat_scale" "exit"` must show `OFF`. The second value
     is the current `vbat_scale` (the board's config default, often 110, 210 on the HGLRC; not the reference's 149).
  2. The human plugs the battery in. Read the board: `python tools/fc_peek.py <PORT> 5` prints `batt=` and, with
     the ESC TX wire, `escV=`.
  3. Take the real voltage from the multimeter on the battery leads (or `escV`). Then
     `new = round(old × real / shown)`, `set vbat_scale = <new>`, `save`, and read it again: done when it is within
     2 %. With both, the multimeter decides; more than 2 % between it and `escV`: report it.
- **The automatic way** (ESC TX wire): USB only, battery out, run
  `python tools/battery_test.py <PORT> --only 0,1 --apply-scale` with a timeout of at least 10 minutes, and ask the
  human to plug the battery in when it prints `battery: plug it in now`. It sets mode OFF itself, calibrates to
  within 2 %, reports a FAIL when it cannot, and restores everything else.
- **Neither a multimeter nor the ESC TX wire**: no calibration. Still read `batt=` once with mode OFF on a
  charged pack and compare it with the pack's range (4S: 14.8–16.8 V). If it is clearly off, stop. Report
  `vbat_scale` as **not calibrated**, and tell the human not to rely on the cut-off and not to leave the device
  unattended: on the reference unit the uncalibrated value read 40.5 % high, so a 4S cut-off would come at about
  9.4 V real, deep-discharging the pack ([docs/warnings.md](docs/warnings.md)).

Afterwards, the human unplugs the battery. `python tools/fc_peek.py <PORT> 3` must end with `no battery`, then
`python tools/bf_cli.py <PORT> "set autostart_mode = POWER" "save"`, or `python tools/battery_test.py <PORT> --finish`,
which refuses while a battery is connected or an interrupted run still has to be restored (`--restore`).

## 9. Verify

1. **Settings** (USB only). Use the command at the end of `after-flash.txt`, completed:
   ```
   python tools/check_reference.py <PORT> --cells <N> --motors <MASK> --esc-uart <UARTn> --vbat-scale <calibrated> --commit <built commit> --board <board_name> --exit
   ```
   - `--no-esc-sensor`: no ESC TX wire, instead of `--esc-uart`.
   - `--usb-inhibit ON`: you chose it, or step 5 forced it.
   - `--no-vbat-meter`: step 5 warned about the battery pad.
   - `--protocol PWM`: the ESC needs PWM.
   - Ready `.hex`: `--commit 3c1808c --board HGLRC_F405_S8`.
   - Not calibrated: leave out `--vbat-scale` and expect `WARN vbat_scale` (it means: still the build default).

   It must end with `RESULT: PASS`, followed by what was adapted. It checks the firmware build and commit,
   `board_name`, the gyro, every `autostart_*` value, the motor protocol, `dshot_bidir` OFF, `debug_mode`
   AUTOSTART, `battery_meter`, `feature ESC_SENSOR` with function 1024 on the wired UART only, and `vbat_scale`.
   `--exit` restarts the board (no save), so it is not left in the CLI. Without a port, the human can run
   `version`, `status`, `get autostart`, `get motor_pwm_protocol`, `get dshot_bidir`, `get debug_mode`,
   `get vbat_scale`, `get battery_meter`, `feature` and `serial` in the Betaflight App's CLI tab. Save the text to a
   file and run `python tools/check_reference.py --from-file cli.txt ...`.
2. **The ramp, measured** (USB only, ESC unpowered: nothing turns). `fc_peek.py <PORT> 3` must end with
   `no battery`. The battery stays out until the end of this step.
   - USB inhibit OFF (the reference):
     `python tools/bf_cli.py <PORT> "set autostart_vbat_min = 0" "save"`, then
     `python tools/autostart_selftest.py <PORT> --motor <first output of the mask>` (1-based). It must print PASS:
     the ramp starts after 10 s and reaches 15 % after 10 s more.
   - USB inhibit ON: the same, but with `--expect-off`. It must PASS, which shows the motor stays at stop while USB
     is connected. That is the negative control of the user's safety choice; the ramp itself is seen in 9.3.

   The self-test refuses a battery and a board that does not answer MSP, and sends STOP at the end. Then
   `python tools/bf_cli.py <PORT> "set autostart_vbat_min = 60" "save"`, and run 9.1 again.
3. **With the battery** (propeller off, the human present):
   - Cap the run (USB only): `python tools/bf_cli.py <PORT> "set autostart_run_time = 15" "save"`. The `save`
     restarts the board; do not open the CLI again. With USB inhibit ON, unplug USB now.
   - Ask the human: propeller off, stand clear, go-ahead. The human plugs the battery in. With USB still connected,
     log it read-only: `python tools/fc_peek.py <PORT> 45`. You should see `DELAY`, then `RAMP` to 15 %, `RUN`
     for 15 s, then `DONE` with the outputs back at 1000.
   - The human unplugs the battery. Then, USB only, with `fc_peek.py` ending `no battery`:
     `python tools/bf_cli.py <PORT> "set autostart_run_time = 0" "save"`, and run 9.1 again for the final
     `RESULT: PASS`.
   - Optional: `python tools/battery_test.py <PORT>` (USB inhibit OFF only; with ON only `--only 0,1` works over
     USB). It runs idle, voltage, capped run, gusts, STOP and cut-off, and leaves the mode OFF (`--finish` after
     unplugging). Tests 0–3 need ESC telemetry; without it use `--only 4,5`. Test 3 bursts up to
     `autostart_gust_max` (80 %) on every output of the mask; test 5 is skipped on a pack at 4.15 V/cell or more.
     Give it a timeout of at least 10 minutes. An interrupted run leaves its settings in
     `tools/battery_test.keep.json`: run `--restore` (battery out), then 9.1.

## 10. Report to the human

- Board, MCU, firmware file name, its SHA-256 and the commit it reports. Ready `.hex`: the release tag, the
  `SHA256SUMS.txt` match and `as-3c1808c`.
- Built from source: the `make_board_config.py` command line, the betaflight/config source commit and the config's
  SHA-256, all printed by the tool.
- What was adapted, with the reason: `autostart_cells`, `autostart_motors`, `autostart_usb_inhibit`, the ESC
  telemetry UART, `vbat_scale` (shown vs measured voltage, or "not calibrated" with the warning from step 8).
- The `check_reference.py` output and the self-test result.
- What was **not** verified, for example "no battery run yet". Only the HGLRC F405 8S V2 is tested on hardware.
- Where the backup is, and how to go back: the release's `_stock.hex`, the `--stock` build or the board's original
  firmware, then restore the backup's `diff all`.

## 11. Troubleshooting

| Symptom | Cause, fix |
|---|---|
| `docker: error during connect ... dockerDesktopLinuxEngine` | Docker Desktop is not running (step 4) |
| PowerShell: `Variable reference is not valid` | use `"${PWD}:/repo"` |
| Git Bash: `C:/Program Files/Git/repo/build/...: No such file` | prefix `MSYS_NO_PATHCONV=1`, use `$(pwd -W)` |
| `pip: command not found` / not recognized | `python -m pip ...` |
| `$'\r': command not found` / `git apply` fails | CRLF checkout: clone again with `-c core.autocrlf=false` |
| `"DEFAULT_MOTOR_DSHOT_SPEED" redefined` | the board's own line is still there: use `make_board_config.py` |
| `DEBUG_AUTOSTART undeclared` in a `--stock` build | the project block is not last, or lost its marker line |
| `xxd: not found` (H730/H750) | the image is older than 2026-10-22: rebuild it (step 4) |
| `fc_peek.py`: `NO MSP ANSWER` | the board is in the CLI or rebooting: replug USB (battery out), run again |
| `check_reference.py`: `firmware ... FAIL` | the board runs other firmware (`version` has no `as-<commit>`) |
| `check_reference.py`: `gyro (status) FAIL` | no gyro detected: wrong config for this board, or a gyro without a 2025.12.1 driver |
| `check_reference.py`: `serial ESC_SENSOR (1024) FAIL` | function 1024 is missing, on another UART, or on two: fix with `serial UARTn 1024 ...` / `serial UARTm 0 ...` |
| everything at the generic defaults (mode OFF, motors 1, DShot600 or the board's own) | the build had only `USE_AUTOSTART` or no block: rebuild with step 5 |
| the countdown never starts on USB | `autostart_vbat_min` 60 waits for a battery (by design), or USB inhibit ON, or the board is still in the CLI |
| USB inhibit ON and it never starts on the battery alone | the board's USB detect sees 5 V (a charger, a power bank, or a BEC feeding VBUS): unplug it, or use inhibit OFF |
| the motor never starts, beeps every 3 s (`debug[0]` = 5, LOW_BATTERY) | `autostart_cells` too high for the pack, or `vbat_scale` reads low |
| the ESC beeps but never spins / "7 low beeps" | the ESC rejects DShot: `set motor_pwm_protocol = PWM`, `save`, replug the battery; again after every config reset; check with `--protocol PWM` |
| ESC stops answering after board restarts | `dshot_bidir` is ON: set it OFF (the reference) |
| `debug[4]` bit 32 / "voltage implausible" | wrong `vbat_scale` or `autostart_cells` |
| `bf_cli.py`: `!!! not confirmed by the board ... nothing saved` | the line was lost or rejected: run it again; never go on as if it was saved |

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
4. Run `python tools/make_board_config.py <board_name> --from configs/<board_name>/config.h --force --backup backup/before.txt ...`,
   then build (step 6).
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
| `DEFAULT_VOLTAGE_METER_SOURCE` | `VOLTAGE_METER_ADC`, only on a board whose config has the battery pad but the meter off | the board's own | `battery_meter` |

Every build gets the rest without a macro: `autostart_cutoff_time` 5, `autostart_run_time` 0,
`autostart_throttle_limit` 100, `autostart_pattern` STEADY, `autostart_box` 255, gusts 40/80 %, 300/800 ms and
20/80 × 0.1 s. `dshot_bidir` is OFF by Betaflight's default unless the board's config sets
`DEFAULT_DSHOT_TELEMETRY` (20 boards set it ON); `make_board_config.py` comments that line out.

## Appendix C: MCU support

Only the HGLRC F405 8S V2 (STM32F405) is tested on hardware. The patch has no board-specific code.

| `FC_TARGET_MCU` | Status (2026-10-22) |
|---|---|
| STM32F405 | hardware-tested (HGLRC F405 8S V2); SpeedyBee F405 V4, AocodaRC F405 AIO and BrotherHobby F405 V2 build |
| STM32F411, STM32F7X2, STM32F745, STM32H743, STM32G47X, AT32F435G, AT32F435M | build (MATEKF411, MATEKF722SE, FOXEERF745V4_AIO, MATEKH743, FLYCOLORH743, SPEDIXG473, DAKEFPVF435, SKYSTARSF435PRO), not tested on hardware. The module adds about 3–6 KB of flash |
| STM32H730, STM32H750 (EXST) | build (SPRACINGH7EVO) with the current image; flashing goes through the vendor's bootloader and is not covered here |
| STM32H723, STM32H725, STM32H735, STM32F446, APM32F405, APM32F407, RP2350A/B | have a platform, not built yet |
| STM32H563 | experimental: no DShot (PWM only), no USB serial port (CLI and tools only through a UART adapter), no beeper |
| anything else (STM32N657, STM32C562, ...) | no platform in Betaflight 2025.12.1: cannot be built |

`tools/flash_dfu.py` is for STM32 boards; AT32 and APM32 boards are flashed with the Betaflight App.

Author: Andrii Shramko. Book a call: <https://calendar.app.google/Ff729HqGk4RpzPNDA> ·
<https://www.linkedin.com/in/andrii-shramko/> · zmei116@gmail.com. Open to teams that want to build on this.
