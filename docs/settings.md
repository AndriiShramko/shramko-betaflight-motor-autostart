# Shramko Motor Autostart — settings reference (firmware 1.1)

Single source of truth for the firmware patch, the web configurator and the docs. All settings are
Betaflight CLI values (`get autostart`, `set <name> = <value>`, `save`). Units are integers.

## Program

| CLI name | Type / values | Range | Default (this build) | Meaning |
|---|---|---|---|---|
| `autostart_mode` | `OFF` · `POWER` · `BUTTON` | — | `POWER` | `POWER`: start when the battery is plugged in. `BUTTON`: start on a click. `OFF`: stock Betaflight |
| `autostart_delay` | seconds | 0–600 | 10 | countdown before the ramp (from battery plug-in, or from the click) |
| `autostart_ramp` | 0.1 s | 0–6000 | 100 | linear ramp 0 → `autostart_throttle` |
| `autostart_throttle` | % | 0–100 | 15 | steady level; in `GUSTS` the level between gusts |
| `autostart_throttle_limit` | % | 1–100 | 100 | hard cap for every output of the program (steady, ramp, gusts) |
| `autostart_run_time` | seconds | 0–65535 | 0 | how long to run after the ramp; `0` = until the battery cut-off or power off |
| `autostart_pattern` | `STEADY` · `GUSTS` | — | `STEADY` | `GUSTS`: random sharp bursts on top of the steady level |
| `autostart_gust_min` | % | 0–100 | 40 | lowest gust peak |
| `autostart_gust_max` | % | 0–100 | 80 | highest gust peak (each gust picks a random peak in min…max) |
| `autostart_gust_len_min` | ms | 50–10000 | 300 | shortest gust |
| `autostart_gust_len_max` | ms | 50–10000 | 800 | longest gust |
| `autostart_gust_pause_min` | 0.1 s | 0–6000 | 20 | shortest pause at the steady level between gusts |
| `autostart_gust_pause_max` | 0.1 s | 0–6000 | 80 | longest pause |

min > max is never an error: the firmware swaps them. Every value is clamped to its range.

## Battery

| CLI name | Type | Range | Default | Meaning |
|---|---|---|---|---|
| `autostart_cells` | cells | 0–12 | 6 | battery cell count; `0` = Betaflight's auto-detection (unreliable with a half-empty pack) |
| `autostart_cell_cutoff` | 0.01 V per cell | 0, 250–420 | 330 | stop the motor when the battery stays below `cells × cutoff` (3.30 V/cell = 19.8 V on 6S); `0` = no cut-off |
| `autostart_cutoff_time` | seconds | 1–60 | 5 | the voltage must stay below the cut-off this long (ignores sag during gusts) |
| `autostart_vbat_min` | 0.1 V | 0–600 | 60 | a battery counts as plugged in at ≥ 6.0 V; the countdown starts then. `0` = don't check |
| `vbat_scale` | Betaflight | 10–255 | 210 | voltage calibration of the board (configurator: "calibrate with a multimeter") |

After a cut-off the program stays stopped until the battery is unplugged and a battery is plugged in
again; with DShot the motor beeps (ESC beacon) every 3 s so you notice it.

## Outputs, safety, inputs

| CLI name | Range | Default | Meaning |
|---|---|---|---|
| `autostart_motors` | 1–255 (bitmask) | 15 | outputs driven: `1` = motor 1, `15` = motors 1–4 |
| `autostart_usb_inhibit` | `OFF` · `ON` | `OFF` (generic builds `ON`) | `ON`: never spin while a computer is connected |
| `autostart_box` | 40–43, 255 | 255 | `BOXUSER1..4` permanent id: an RC switch runs the program while the receiver link is valid |
| `resource AUTOSTART 1 <pin>` | pin | none | push-button between that pad and GND (internal pull-up) |

## States (debug_mode = AUTOSTART, `debug[0]`)

`0 IDLE` · `1 DELAY` · `2 RAMP` · `3 RUN` · `4 DONE` (run time over) · `5 LOW_BATTERY` (cut-off).
`debug[1]` commanded % ×10 · `[2]` ms in state /10 · `[3]` uptime 0.1 s · `[4]` flags (1 USB host,
2 RX link, 4 button, 8 battery present, 16 gust active) · `[5]` battery 0.1 V · `[6]` time since the
battery appeared 0.1 s (−1 = none) · `[7]` source (0 none, 1 power, 2 button, 3 RC switch).

## What stops the program (no automatic restart)
Entering the CLI · the Configurator Motors tab (any `MSP_SET_MOTOR`) · arming via a receiver · a
valid receiver link (unless `autostart_box`) · run time over · battery cut-off · battery unplugged
(re-plugging starts the countdown again in `POWER` mode) · a button click while running.
