# Warnings — what can go wrong

An honest list for anyone using Shramko Motor Autostart (firmware and web configurator). Settings referenced here are described in [`settings.md`](settings.md); the wiring in [`wiring.md`](wiring.md).

## The motor and the battery

- **It starts without warning.** In `POWER` mode the countdown begins the moment a battery is detected (`autostart_vbat_min`, 6.0 V). A propeller or a blower wheel on the bench can injure. Keep it off until the device is mounted and closed.
- **Unplugging the battery for more than 0.5 s stops the program; plugging it back in starts the countdown again** (in `POWER` mode). A loose battery connector can therefore restart the motor after a pause.
- **The battery cut-off is not a fuse.** `autostart_cells × autostart_cell_cutoff` protects the pack from deep discharge only if `autostart_cells` matches the real pack (`0` = Betaflight's auto-detection, unreliable with a half-empty pack). With `autostart_cell_cutoff = 0` there is no cut-off at all. Short circuits need a fuse in the battery line.
- **Voltage sag in gusts.** `autostart_cutoff_time` (5 s) ignores short dips; a worn pack under long gusts can still reach the cut-off and stop the motor in the middle of a job.
- **Run time 0 means "until the cut-off or power off".** A forgotten device keeps running.

## Wiring

- **Never more than 8S on the `B` pin** of the HGLRC F405 8S V2 (other boards: their own rating, usually lower). For 10–12S, feed the board from a 12S-rated BEC.
- **`vbat_scale` must be calibrated** before you rely on the cut-off: on the author's unit the build's 210 read 40.5 % high, so a 6S cut-off at 19.8 V would have tripped only near 14 V real. Calibrate against a multimeter or the ESC's voltage ([AGENT_PORTING.md](../AGENT_PORTING.md), step 8); never copy another unit's value.
- **The red wire is battery voltage.** If its joint touches a white, yellow or green wire, the flight controller's processor is destroyed. Insulate every joint separately.
- **The cable's yellow is the ESC-telemetry input, not the signal.** The ESC's signal goes to a white wire.
- **Ground goes through the ESC's thin black signal wire** in the documented setup. Do not add a second ground path through other thin wires.
- The HGLRC F405 8S pin map comes from the vendor's diagram and silkscreen; HGLRC publishes no schematic. Check continuity before the first battery.

## ESCs

- **BLHeli_32 ESCs can no longer be flashed**, only configured (BLHeliSuite32 32.10). An ESC that reports "activation failed" accepts PWM only: `set motor_pwm_protocol = PWM`, `set dshot_bidir = OFF`, `save`, replug the battery.
- **An ESC will not arm if it powers up into non-zero throttle.** The module always gives it at least 3 s of stop frames before the ramp, counted from the moment the battery appears on the board's `B` pin. If the ESC is powered from a different source than the board, that timing no longer matches: test it on the bench first.
- Bidirectional DShot (`dshot_bidir = ON`) needs ESC firmware that supports it (BLHeli_32 ≥ 32.7); otherwise RPM telemetry is missing or the ESC behaves erratically.

## The web configurator

- **Browser support can change.** Web Serial works today in Chrome, Edge and Opera on desktop, and in Firefox 151+ after a one-time site permission; Safari does not have it; iOS browsers have neither Web Serial nor WebUSB; Android works only in Chrome 148+ with USB-OTG on phones whose Android supports USB serial. A browser update can change any of this.
- **Only one program can use the serial port.** The Betaflight App, a serial terminal or a second tab holding the port makes the connection fail.
- **Saving reboots the board** and, like the CLI, stops a running program (by design). Do not save while the device is doing a job that must not stop.
- **Windows drivers.** "DFU device not found" while flashing means the bootloader driver is missing (ImpulseRC Driver Fixer or Zadig/WinUSB). The configurator itself uses the normal USB serial (VCP) driver.

## Things outside this project

- **Betaflight, the Betaflight App and ESC vendors** can change protocols, flashing tools or policies. This project is pinned to Betaflight 2025.12.1.
- **A newer firmware version can reset settings once** after flashing (Betaflight does that when a parameter group changes). Keep `diff all` output of your configuration.
- **The hosted site** (autostart.flyreelstudio.eu) may be unavailable at times; the firmware does not depend on it, and every setting is also in the CLI.

Found a problem that is not on this list? Use the Feedback button on the site or write to zmei116@gmail.com.
