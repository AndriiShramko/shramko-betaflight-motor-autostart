# Shramko Motor Autostart — settings reference (firmware 1.1)

Single source of truth for the firmware patch, the web configurator and the docs. All settings are
Betaflight CLI values (`get autostart`, `set <name> = <value>`, `save`). Units are integers.

## Program

| CLI name | Type / values | Range | Default (this build) | Meaning |
|---|---|---|---|---|
| `autostart_mode` | `OFF` · `POWER` · `BUTTON` | — | `POWER` | `POWER`: start when the battery is plugged in. `BUTTON`: start on a click. `OFF`: stock Betaflight |
| `autostart_delay` | seconds | 0–600 | 10 | countdown before the ramp: from battery plug-in (a battery already there within 2.5 s of boot counts from boot), or from the click / RC switch. The ramp never starts earlier than 3 s after the battery appeared (the ESC arms on stop frames); with `autostart_vbat_min = 0` those 3 s count from boot |
| `autostart_ramp` | 0.1 s | 0–6000 | 100 | linear ramp 0 → `autostart_throttle` |
| `autostart_throttle` | % | 0–100 | 15 | steady level; in `GUSTS` the level between gusts |
| `autostart_throttle_limit` | % | 1–100 | 100 | hard cap for every output of the program (steady, ramp, gusts) |
| `autostart_run_time` | seconds | 0–65535 | 0 | how long to run after the ramp; `0` = until the battery cut-off or power off |
| `autostart_pattern` | `STEADY` · `GUSTS` | — | `STEADY` | `GUSTS`: random sharp bursts on top of the steady level (the random sequence differs on every power-up) |
| `autostart_gust_min` | % | 0–100 | 40 | lowest gust peak; a peak below `autostart_throttle` is raised to it (a gust never dips below the steady level) |
| `autostart_gust_max` | % | 0–100 | 80 | highest gust peak (each gust picks a random peak in min…max) |
| `autostart_gust_len_min` | ms | 50–10000 | 300 | shortest gust |
| `autostart_gust_len_max` | ms | 50–10000 | 800 | longest gust |
| `autostart_gust_pause_min` | 0.1 s | 0–6000 | 20 | shortest pause at the steady level between gusts |
| `autostart_gust_pause_max` | 0.1 s | 0–6000 | 80 | longest pause |

min > max is never an error: the firmware swaps them. The CLI rejects a value outside its range
(`INVALID VALUE`); the web configurator clamps it before it writes.

With the battery at boot the DShot stop frames start only at the end of boot (~1.5 s after power-on), so
with `autostart_delay` 0–1 the ESC gets about 1.5 s of them before the ramp; the default 10 s leaves plenty.

## Battery

| CLI name | Type | Range | Default | Meaning |
|---|---|---|---|---|
| `autostart_cells` | cells | 0–12 | 6 | battery cell count; `0` = Betaflight's auto-detection (unreliable with a half-empty pack) |
| `autostart_cell_cutoff` | 0.01 V per cell | 0, 250–420 | 330 | stop the motor when the battery stays below `cells × cutoff` (3.30 V/cell = 19.8 V on 6S); `0` = no cut-off. The CLI also accepts 1–249: the firmware raises it to 250 |
| `autostart_cutoff_time` | seconds | 1–60 | 5 | the voltage must stay below the cut-off this long (ignores sag during gusts) |
| `autostart_vbat_min` | 0.1 V | 0–600 | 60 | a battery counts as plugged in at ≥ 6.0 V; the countdown starts then. Once plugged in it counts as unplugged only below the lower of `vbat_min` and `cells × 2.50 V` for 0.5 s, so load sag under a high `vbat_min` does not stop the program. With a USB host connected, below 1 V for 2 ticks (40 ms) already counts as unplugged (the board outlives the battery, the ESC does not). `0` = don't check |
| `vbat_scale` | Betaflight | 0–255 | 210 | voltage calibration of the board (configurator: "calibrate with a multimeter") |

After a cut-off the program stays stopped until the battery is unplugged and a battery is plugged in
again: a click or the RC switch does not restart it. Every 3 s the buzzer beeps and, with DShot, the motor
beeps too (ESC beacon) so you notice it. The ESC beacon is left out once a receiver link was seen since boot
(a pilot could arm right after it, and Betaflight delays arming only after its own beacons). No reminder
while the CLI is open, while armed, or while a USB host is connected with `autostart_usb_inhibit = ON`.

The cut-off is off while Betaflight has no voltage meter configured, while `autostart_cells = 0` and
Betaflight has not detected the cell count yet, and while the reading is below 1 V (USB-only bench). It
counts only from 3 s after the battery appeared (Betaflight's filtered voltage rises for ~1.5 s).

## Outputs, safety, inputs

| CLI name | Range | Default | Meaning |
|---|---|---|---|
| `autostart_motors` | 1–255 (bitmask) | 15 | outputs driven: `1` = motor 1, `15` = motors 1–4 |
| `autostart_usb_inhibit` | `OFF` · `ON` | `OFF` (generic builds `ON`) | `ON`: never spin while a computer is connected |
| `autostart_box` | 40–43, 255 | 255 | `BOXUSER1..4` permanent id: an RC switch runs the program while the receiver link is valid. The CLI accepts 0–255; any other id is ignored. On `HGLRC_F405_S8` 40 and 41 also switch PINIO1 / PINIO2 (`config.h`): use 42 or 43 |
| `resource AUTOSTART 1 <pin>` | pin | none | push-button between that pad and GND (internal pull-up) |

The RC switch starts the program only when it is idle: after the run time is over (`DONE`) turn the switch
off and on again for a new run; after a battery cut-off only a new battery starts it again.

## States (debug_mode = AUTOSTART, `debug[0]`)

`0 IDLE` · `1 DELAY` · `2 RAMP` · `3 RUN` · `4 DONE` (run time over) · `5 LOW_BATTERY` (cut-off).
`debug[1]` commanded % ×10 · `[2]` ms in state /10, sent as uint16 (read it unsigned; it stops at
655.35 s, so a longer run time shows 655 s until it ends) · `[3]` uptime 0.1 s (stops at 3276.7 s = 54.6 min)
· `[4]` flags (1 USB host, 2 RX link, 4 button, 8 battery present, 16 gust active, 32 battery voltage
implausible for the cell count — outside 2.50–4.45 V/cell, i.e. calibrate `vbat_scale`; not shown in the
first 3 s after the battery appeared, while Betaflight's filtered voltage rises; 64 held by the computer, see
below) · `[5]` battery 0.1 V · `[6]` time since the battery appeared 0.1 s (−1 = none; counts from boot when
the battery was there within 2.5 s of boot; stops at 3276.7 s) · `[7]` source (0 none, 1 power, 2 button,
3 RC switch).

## ESC telemetry (optional, for the voltage cross-check and ESC temperature)
- **ESC TX wire** (recommended): ESC pad `TX` → FC cable yellow (`R`, UART5 RX) + `feature ESC_SENSOR`.
  `MSP_MOTOR_TELEMETRY` then reports the ESC's own battery voltage, current and temperature.
- **Extended DShot telemetry** (no extra wire, needs BLHeli_32 ≥ 32.10): `dshot_bidir = ON`,
  `dshot_edt = ON`; the module asks the ESC to enable it once per battery, while the motor is at stop,
  3 s after the battery appears and not before Betaflight accepts DShot commands (3 s after the motors are
  enabled at the end of boot; earlier requests would be dropped). Stock Betaflight does it only when arming.
  Not with `feature ESC_SENSOR` (the TX wire is used then), and not while the CLI is open or a USB host is
  connected with `autostart_usb_inhibit = ON` (asked when that ends).

## What stops the program (no automatic restart)
Entering the CLI · the Configurator Motors tab (any `MSP_SET_MOTOR`) · an ESC tool through passthrough
(BLHeliSuite, ESC configurator) or `MSP2_SEND_DSHOT_COMMAND` (motor direction tool) · arming · `feature 3D`
· a USB host with `autostart_usb_inhibit = ON` · a valid receiver link (unless `autostart_box`) · for a
program started by the RC switch: the switch off or the link lost · run time over · battery cut-off ·
battery unplugged (at least 0.5 s; with a USB host below 1 V for 40 ms) — re-plugging starts the
countdown again in `POWER` mode, unless a receiver link was confirmed since boot · a button click while
running (a click is ignored while a receiver link is valid or being confirmed).

After the run time a click starts a new run; with `autostart_box` the switch has to be turned off and on
again. After a battery cut-off only a new battery starts it again.

When the computer or the CLI writes some of the program's motors, those keep the computer's value and the
program's other motors go to stop.

**Held by the computer (firmware 1.1).** Entering the CLI (the web configurator's *Read settings*), any
`MSP_SET_MOTOR` (Configurator Motors tab, the web configurator's *STOP*), an ESC passthrough session or
`MSP2_SEND_DSHOT_COMMAND` also holds the program when it is only waiting for the battery or a click:
nothing starts by itself — battery, button or RC switch — until the board restarts (*Restart program*, a
CLI `exit`/`save`, or power off and on). `debug[4]` bit 64 shows it. The last three stop the program's
motors at once, before the computer's own command (an ESC passthrough blocks the 50 Hz task). Found on
the real board on 2026-10-20: before this, *Read settings* or *STOP* on a USB bench and then plugging the
battery in started the countdown.
