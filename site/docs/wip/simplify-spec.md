# Simplify the site for a first-time visitor — implementation spec (2026-10-20)

Owner's request (verbatim, RU): «Продумай на сайте все так, чтобы было максимально просто и понятно для того
пользователя, который ни разу его не видел. Постарайся скрыть все те инструменты, которые могут не понадобиться
для таких каких-то начальных настроек, чтобы они были где-то в дополнительных, расширенных.»

Basis: a 9-agent design panel (3 audits, 3 proposals, 3 judges). Full material:
`C:\Users\andri\AppData\Local\Temp\claude\U--documents-Obsidian-AndriiShramko\316c8bc0-2cb0-4cfd-ab0a-c808907c81b0\scratchpad\design-result.json`
(audits incl. measured clicks/scrolls, proposals with copy, judges' must-fix lists). Before screenshots:
`site/docs/wip/before-simplify/`.

Decision: the **"Simple panel + one More settings drawer"** code approach (reuse `buildField()`, `clampValue`,
`normalize`, the save/verify path; keep `SCHEMA.group` as is, add SIMPLE/MORE lists) **plus** the parts of the
"task-first in 3 steps" proposal that won on clarity: page order = task order, numbered steps, plain words,
quick-pick chips, the program in words. Nothing the owner asked for disappears: it moves or folds.

## Hard rules
- Every capability stays reachable: all 20 settings, calibration, presets' values, STOP, restart, feedback, all
  page content (folded content stays in the DOM for search/AI engines).
- Zero settings clicks for the default behaviour (power-on → 10 s → 10 s ramp to 15 % → run until the cut-off).
- Safety items never inside a closed area: STOP, "propeller off", every battery warning (no cut-off, automatic
  cell count, implausible voltage, ESC vs board > 5 %, firmware 1.0 has no protection).
- A hidden value that differs from the board's default is named in the closed drawer's summary; the
  safety-relevant ones open the drawer by themselves (and it never closes by itself).
- One word per quantity everywhere: **Power** (throttle), **Maximum power** (throttle limit), **Wait before
  start** (delay), **Speed-up time** (ramp), **How long** (run time). CLI names only in Expert help / FAQ / How it works.
- 4 languages (en/es/pl/ru), keys in parity (tests/i18n-tool.test.ts), short texts; 375 px without horizontal
  scroll in all 4; WCAG 2.2 AA (keyboard, visible focus, real radio groups, 44 px targets, accessible names with units).
- No serial port, no deploy, no git commit/push by implementing agents. Do not touch the firmware.

## Page (template.html, i18n/{lang}.json, styles.css, main.ts)
1. **Header:** below 760 px a native `<details class="menu">` "Menu" (44 px summary) with the nav anchors; closes
   on link click and Esc, focus back to the summary. Nav order = task order: Install · Configurator · Wiring ·
   Safety · How it works · FAQ · Contact · GitHub.
2. **Hero:** H1 stays "Shramko Motor Autostart" (brand rule). New sub-line: "Spins a motor by itself when you
   plug in the battery. No receiver, no remote." Lead (2 plain sentences): built to blow rain off a 360° camera
   lens; put the firmware on an HGLRC F405 board once, then choose wait, power and run time here in Chrome or
   Edge on Windows. CTAs in task order: primary **"Set it up in 3 steps"** → `#install`, secondary
   **"Firmware already on? Connect"** → `#tool`. Chips in plain words: No receiver or remote · Set up in the
   browser · Protects your LiPo · Open source. The measured-facts tiles move to How it works. The hero chart
   is shown on phones too, after the CTAs; its labels in plain words (WAIT / SPEED UP / HOLD).
3. **Order of sections:** hero → **#install** ("Step 1 · Put the firmware on the board") → **#tool**
   (configurator: "Step 2 · Connect the board" and "Step 3 · Choose what it does" are its two cards) →
   #wiring → #safety → #how → #support → #faq → #agent → #contact → #privacy → footer.
   Install stays a visible section (no localStorage collapsing). Inside it: the DFU fix ("Windows says DFU
   device not found?") and "Another board, older versions, going back to stock" as closed `<details>`.
   Optional: a "✓ Found on your board" badge in the Install heading when the connected board reports the module
   (tool dispatches `sma:board` with `{connected, module}`; page listens).
4. **#wiring:** the diagram wrapped in a link to the full-size SVG ("Open the diagram full size").
5. **#how:** plain lead; the measured-facts card (from the hero) visible at the top; the 5-state list with CLI
   names, 50 Hz/MSP and DShot defaults inside a closed `<details>` "Technical details".
6. **#faq:** add q9 "I saved my settings — why doesn't the motor start?" (the board holds the program after
   reading/saving until Run now, or until power is cycled). Answers that mention a setting start with one plain
   sentence saying where it lives now (main panel / More settings → Battery …); CLI names after that.
7. **#agent:** heading, one-line explanation and the Copy button visible; the long prompt in a closed `<details>`
   "Show the prompt" (Copy still copies it).
8. **main.ts:** a hash handler: when the URL hash targets a folded element or something inside a `<details>`,
   open it first, then scroll. Phone Feedback FAB: icon-only under 480 px while a board is connected and lifted
   above the STOP bar.

## Configurator (ui/tool.ts, ui/tool.css, i18n/tool.{lang}.json, fc/settings.ts)
### Card "Step 2 · Connect the board"
- Warning callout first: "Propeller off: the motor can start by itself."
- "Plug the board into this computer with a USB data cable and close the Betaflight App. Press Connect and pick
  the board — its name has “STM32” or “Betaflight” in it."
- [Connect] + small text button "Board not in the list? Show all ports" (also repeated inside the error box).
- The positive support note ("Your browser can talk to the board") and "Not connected." are not shown; negative
  support variants stay.
- Connected: one line "✓ Connected: {board} · Shramko Autostart {1.1}" + ghost [Disconnect]; the 4 fact tiles
  in a closed "Board details".
- Stock Betaflight: one banner "This board has no autostart yet. Install the firmware first (step 1)." + link;
  Motor status and Step 3 hidden. Verdict 'betaflight-other' (unknown build): explicit [Check this board]
  button (reads once). **No automatic read** anywhere (reading enters the CLI and holds the program).
### Card "Motor status" (was "Live")
- Plain state + sub-line (Waiting for the battery / Starts in N s / Speeding up · N % / Running · N % /
  Stopped with STOP — press Run, or switch the board off and on (unplug USB and the battery, then plug in the battery) / Paused while settings are open / Finished: run time over
  / Battery low: stopped). Meters: **Power** %, **Battery** V. Before the settings are read the cell count reads
  "Betaflight guesses NS" and the cut-off "unknown until you open the settings"; after reading
  "6S · stops at 19.8 V".
- Battery warnings always here (and repeated in Step 3): no cut-off (red), automatic cell count (amber),
  implausible voltage, ESC vs board > 5 % (with a link that opens More settings → Battery → Calibrate), fw 1.0.
- [Run the program…] (was "Restart program…"), same confirmation dialog, which now also has its own STOP.
- Closed "More live data": motor speed (rpm, bad frames, ESC °C / V, dshot_bidir hint), the 60 s chart, the
  USB/Battery/Receiver/Button/Gust chips with a one-line legend.
### STOP bar
- Fixed at the bottom whenever a board is connected (all phases incl. rebooting/reconnecting), shows the state
  and Power % on one line (ellipsis, not aria-live) + [STOP motor] ≥ 44×44 px. In DOM order right after the
  connection line (first Tab stop after it). While connected: `html{scroll-padding-bottom}` and body
  padding-bottom = measured bar height (ResizeObserver) + 12 px; Feedback FAB and the consent bar sit above it.
- STOP inside every modal opened while connected: the Run dialog, the new confirm dialogs, and Feedback
  (tool dispatches `sma:board {connected}`; feedback.ts shows a STOP button while connected and dispatches
  `sma:stop`; the tool handles `sma:stop` with the same `device.stopMotor()` path, never disabled by a busy op).
### Card "Step 3 · Choose what it does"
- **Before reading:** "Fresh firmware does this (factory settings — this board may differ):" + the 3 program
  lines for the defaults + "If that suits you, you are done: unplug USB and the battery, then plug in the battery." Primary
  [Change settings] (was "Read settings") + note "Opening the settings stops the motor until you press Run."
- **After reading:** box "What the board will do" (dl) built by a pure `describeProgram(values, level)` in
  fc/settings.ts that matches the firmware exactly (docs/settings.md + patches): start (POWER: after the battery
  is plugged in; BUTTON: after a click; OFF: never starts by itself), wait (never less than 3 s after the ESC gets
  power), speed-up over ramp to min(power, maximum power), steady or gusts (peak = min(maximum power,
  max(power, gust_max))), how long (run time counted after the ramp / until the battery drops to cells × cut-off
  V for cut-off-time s / "until the power is off" when cut-off = 0), USB inhibit, firmware 1.0 (no cut-off,
  no run time, no gusts, no maximum power). Unit tests for every variant.
- **Five simple questions** (real radio groups in `<fieldset><legend>`, arrow keys, 44 px, default preselected;
  "Other" reveals a same-row number input whose accessible name includes the unit; a board value matching no
  chip preselects Other with the exact value):
  1. **Wait before start:** 5 s · 10 s · 30 s · 60 s · Other [ ] s
  2. **Power:** 15 % · 30 % · 50 % · 80 % · Other [ ] %; note "Capped at N % by Maximum power" when it applies
     (also under Strongest gust).
  3. **How long:** "Until the battery is low" (default; reads "Until the power is off" when cut-off = 0) ·
     "For a set time" → [min] [s] (total clamped 1–65535 s, seconds 0–59; unit-tested split/join; never an
     empty disabled box).
  4. **Random gusts:** Off · On — changes ONLY `autostart_pattern`. Tip when On: "About 20 % power between gusts
     works well." Gust details live in More settings.
  5. **Battery:** 3S · 4S · 6S · 8S · Other [ ] cells; then the protection line: "Protected: stops at 19.8 V
     (6 × 3.30 V), after 5 s" / red "No battery protection: the motor runs until the LiPo is empty" / amber
     "Cells counted automatically — unreliable with a half-empty pack" (with "pick the number" right here) and the
     fit check with the live voltage: "22.3 V fits 6S" / "33.6 V doesn't fit 6S. Is it 8S? [Use 8S]" (suggests,
     never changes by itself).
- **One "More settings" drawer** (native `<details>`, no nested details; open state kept in localStorage in
  try/catch and across re-renders). Summary: "More settings" + one line naming every hidden value that differs
  from `board.eff[name].boardDefault` (not the schema default). Each fieldset legend shows its current value in
  plain words ("Battery · stops at 3.30 V per cell, after 5 s"). Fieldsets:
  - **Start and power:** What starts the motor (Battery plugged in / Button click — needs a wired button / Off:
    never starts by itself) · Speed-up time (s) · Maximum power (%).
  - **Gust details:** when gusts are Off only "Turn on Random gusts to set these."; when On the 6 fields +
    [Use the suggested gust mix] (sets ONLY the 6 gust keys: 50–90 %, 0.2–0.6 s, every 1.5–6 s) + a separate link
    "also set Power to 20 %".
  - **Battery:** Stop voltage per cell + "No battery protection" (a confirm dialog, focus on Cancel, Esc cancels,
    has STOP) · Count cells automatically (confirm, amber) · Wait before the battery stop (s) · the calibration box
    (opens itself when ESC vs board > 5 % or the voltage is implausible).
  - **Outputs and USB:** Motor outputs 1–4 · With a computer connected (Motor may spin / Keep the motor stopped).
  - **Expert:** Battery counts as plugged in from (vbat_min) · RC switch (box) · Voltage scale (vbat_scale).
  - [Reset to defaults…] at the end: a confirm listing the exact changes (incl. hidden ones).
  - Auto-open (with one polite announcement, focus not moved) when any of: cut-off = 0, cells = 0, vbat_min = 0,
    usb_inhibit ≠ board default, motor 1 not in the mask, mode ≠ POWER, cut-off time > 10 s, RC box ≠ 255.
    Maximum power < 100 % gets a badge in the summary (no auto-open).
- The presets block goes away: Steady = gusts Off; the Gusts preset = the suggested mix. **Fix PRESET_KEYS**
  (fc/settings.ts): no action may change Power, Maximum power or How long unless the person picked it.
  Negative-control test: saved Power 30, Maximum power 40, run time 120 survive "gusts On" and the mix.
- **Save area:** "Will save: Wait 10 → 5 s · Power 15 → 30 %" (first 3 names + "and N more", hidden fields
  included, each a link that opens the drawer at that field via one `openMore(fieldset, field)` helper that
  scrolls with scroll-margin above the STOP bar and focuses the field). [Save to board] [Undo changes]; hint
  "Saving restarts the board. Keep the propeller off."
- **After save:** "Saved and checked on the board: N values. The motor stays stopped until you press Run now —
  or switch the board off and on: unplug USB and the battery, then plug in the battery." + [Run now…] inside the
  message; focus moves to the message. With no changes: "Nothing changed. The board is ready: switch it off and on
  (unplug USB and the battery, then plug in the battery), or [Test it now…]." (The firmware clears the hold only at
  boot: a battery re-plug while USB powers the board does nothing, so "plug in the battery" is never offered alone.)
- "Read again" → small ghost [Reload from the board] at the bottom, disabled with a hint while there are unsaved
  changes.
- Firmware 1.0: fields it lacks are not drawn; one note at the top of Step 3 and in Motor status.
- Live regions: one polite status region + one alert region for the whole tool; field notes become text
  referenced by `aria-describedby`. After Change settings / Save / Undo / Reset focus goes to the result.
- CSS: units on the same row as their input (`.st input.st-num{display:inline-block}` must beat styles.css
  `input[type=text]`); `.st-primary:hover` in the green accent; chips wrap at 375 in all 4 languages.

## Tests and tools to update (same change)
- `tests/tool.e2e.test.ts` (mock, real Chrome): new labels; zero-click default path; Other preselect with
  delay 45 / power 22 / cells 5; gusts toggle and the mix keep Power/Maximum power/run time (negative control);
  No-cut-off confirm; drawer auto-open for every listed case + a negative control (all defaults → closed);
  STOP clickable while Feedback and the Run dialog are open; private-mode localStorage that throws.
- Unit tests: `describeProgram` per variant; min+s split/join clamping; drawer summary/attention list.
- `tools/e2e-real.mjs`, `tools/tool-shots.mjs`, `tools/cal-check.mjs`, `tools/shots.mjs`: work with the new UI
  (fields inside More settings: open it first). `e2e-real.mjs` must keep its checks (read, change 6 values of
  every kind, save, CLI cross-check, restore) — it is the owner's real-board acceptance.
- All green before hand-off: `npm run test:fc`, `npm run test:tool-e2e`, `npm run test:api`, `npm run build`,
  `node tools/shots.mjs dist <dir>`, `node tools/tool-shots.mjs dist <dir>`, `node tools/cal-check.mjs`.
- Measure again (emulator, en + ru, 375 and 1440): clicks and scroll depth for the 7 first-timer tasks, before
  vs after; no figure from a prototype goes into a report.
