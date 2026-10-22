"""Shramko Motor Autostart - the checks that need a real battery (ESC and motor connected, PROPELLER OFF).

The motor turns ONLY inside a test: the session starts and ends with autostart_mode = OFF, every test
run is saved with a short delay and a run-time cap (<= 15 s), so even if this script dies half-way the
motor stops by itself after the cap. Plug the battery in only after "battery: plug it in now".

  0. idle: battery in, mode OFF -> nothing turns for 15 s; ESC telemetry (voltage, temperature) arrives
  1. voltage: board reading vs. the ESC's own measurement -> the vbat_scale that makes them agree
     (--apply-scale writes it if they differ by more than 2 %; a calibration it cannot do is a FAIL)
  2. run: 3 s delay, 3 s ramp to 15 %, 8 s run -> RPM follows, then DONE and the motor stops by itself
  3. gusts: 10 s of the gust pattern -> RPM bursts above the steady level (peaks up to autostart_gust_max,
     80 % by default, on every output of autostart_motors), motor stops after the cap
  4. STOP during the countdown (MSP_SET_MOTOR, what the web page's STOP sends) -> nothing turns
  5. cut-off: autostart_cell_cutoff above the pack -> LOW_BATTERY, motor stopped, the cut-off restored
Tests 0-3 need ESC telemetry (the ESC TX wire + feature ESC_SENSOR, or bidirectional DShot); without it run
--only 4,5. Settings are restored to what the board had, with autostart_mode = OFF. --finish puts the mode
back to POWER and refuses while a battery is connected. A full run takes several minutes: run it with a long
timeout (or detached), or an interrupted run leaves test values on the board (check with check_reference.py).
Every `set` is confirmed by the board, or the CLI is left without saving.

usage: python battery_test.py COM6 [--apply-scale] [--only 0,1,2,...]
       python battery_test.py COM6 --finish        # unplug the battery first: restores autostart_mode
       python battery_test.py COM6 --restore       # an interrupted run: put the saved settings back
Before the first test the board's settings are written to tools/battery_test.keep.json (git-ignored); it is
deleted when the restore succeeds. While it exists, --finish refuses and asks for --restore.
"""
import argparse, json, os, struct, sys, time
import serial

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
from autostart_selftest import msp, msp_frame, open_port  # noqa: E402

STATE = {0: "IDLE", 1: "DELAY", 2: "RAMP", 3: "RUN", 4: "DONE", 5: "LOW_BATTERY"}
KEEP = ["autostart_mode", "autostart_vbat_min", "autostart_delay", "autostart_ramp", "autostart_throttle", "autostart_run_time",
        "autostart_pattern", "autostart_cell_cutoff", "autostart_cutoff_time", "autostart_cells", "vbat_scale", "autostart_motors"]
CAP_S = 15
KEEP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery_test.keep.json")
MASK = 1  # autostart_motors of the board: the outputs whose motor and ESC telemetry are watched


def cli(port, cmds, wait=4.0):
    """Run CLI commands, return the text. End with 'save' or 'exit' (both reboot the board) or 'exit noreboot'.
    Every `set` must be confirmed by the board (`... set to ...`). If one is not, nothing is saved and the board
    is left IN the CLI (the program is held there): leaving it with `exit` would reboot into what was saved
    before, possibly a test program with the battery in."""
    s = open_port(port, 30)
    time.sleep(0.3)
    for _ in range(10):
        s.reset_input_buffer()
        s.write(b"#")
        time.sleep(1.0)
        if s.read(4000).rstrip().endswith(b"#"):
            break
    else:
        s.close()
        raise SystemExit("no CLI prompt on %s (close the Betaflight App / web configurator)" % port)
    s.write(b"\r\n")
    time.sleep(0.3)
    s.read(4000)
    out = ""
    for c in cmds:
        s.write(c.encode() + b"\r\n")
        time.sleep(0.6)
        try:
            chunk = s.read(8000).decode(errors="replace")
            if c.startswith("set ") and " set to " not in chunk:
                # the first line after entering the CLI can be lost (bf_cli.py): one retry, then leave unsaved
                s.write(c.encode() + b"\r\n")
                time.sleep(0.8)
                chunk += s.read(8000).decode(errors="replace")
                if " set to " not in chunk:
                    s.close()
                    raise SystemExit("not confirmed by the board: %s -- nothing saved, the board stays in the CLI "
                                     "(program held). Unplug the battery, then replug USB and check the settings "
                                     "(check_reference.py)" % c)
            out += chunk
        except serial.SerialException:
            break
    try:
        s.close()
    except Exception:
        pass
    time.sleep(wait)
    return out


def outputs(mask):
    return [i for i in range(8) if mask >> i & 1] or [0]


def sample(s, mask=None):
    """one MSP snapshot; the motor value and the ESC telemetry come from the outputs of autostart_motors"""
    mask = MASK if mask is None else mask
    m, d, t, b = msp(s, 104), msp(s, 254), msp(s, 139), msp(s, 130)
    if not (m and d and b):
        return None
    dbg = struct.unpack("<8h", d[:16])
    motors = struct.unpack("<%dH" % (len(m) // 2), m)
    outs = [i for i in outputs(mask) if i < len(motors)] or [0]
    best = None
    if t:
        for i in range(min(t[0], 8)):
            if len(t) < 1 + 13 * (i + 1):
                break
            rpm, inv, temp, ev, cur, cons = struct.unpack_from("<IHBHHH", t, 1 + 13 * i)
            e = dict(rpm=rpm, bad=inv / 100.0, temp=temp, volts=ev / 100.0, amps=cur / 100.0, out=i + 1)
            # an output of the mask that answers (voltage or rpm) wins; then the fewest bad frames
            key = (i in outs and (ev > 0 or rpm > 0), -inv)
            if best is None or key > best[0]:
                best = (key, e)
    return dict(t=time.time(), state=dbg[0], pct=dbg[1] / 10.0, flags=dbg[4], v_fc=struct.unpack_from("<H", b, 9)[0] / 100.0,
                esc=best[1] if best else None, motor=max(motors[i] for i in outs))


def battery_present(samples):
    """the board reads 1 V or more on its battery pad (AGENT_PORTING.md question 8: it gets the ESC's pack).
    The ESC voltage is not used: MSP keeps the last value the ESC sent, also after the battery is unplugged."""
    return any(x["v_fc"] >= 1.0 for x in samples)


def no_battery_or_exit(port, what):
    """refuse `what` unless MSP answers and the board sees no battery"""
    s = open_port(port, 15)
    xs = []
    for _ in range(10):
        x = sample(s)
        if x:
            xs.append(x)
        time.sleep(0.2)
    s.close()
    if not xs:
        raise SystemExit("no MSP answer from the board (in the CLI or rebooting): replug USB with the battery out, "
                         "then run %s again" % what)
    if battery_present(xs):
        raise SystemExit("a battery is still connected (board %.2f V): unplug it, then run %s again"
                         % (max(x["v_fc"] for x in xs), what))


def save_keep(base):
    with open(KEEP_FILE, "w", encoding="utf-8") as f:
        json.dump(base, f, indent=1)


def load_keep():
    try:
        with open(KEEP_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def calibration(v_fc, v_esc, cells, scale):
    """What --apply-scale does with the median readings: (new vbat_scale or None, verdict or None, reason).
    verdict True = already within 2 %, False = cannot calibrate (reported as FAIL), None = nothing to judge."""
    if v_esc <= 1:
        return None, None, "no ESC voltage: needs the ESC TX wire and feature ESC_SENSOR (or a multimeter)"
    if v_fc <= 1:
        return None, False, "the board reads no battery: its VBAT pad does not get the ESC's pack"
    if not (cells and 2.5 <= v_esc / cells <= 4.45):
        return None, False, "the ESC's %.2f V is not a %dS pack: check autostart_cells" % (v_esc, cells)
    diff = (v_fc - v_esc) / v_esc * 100
    new = max(10, min(255, round(scale * v_esc / v_fc)))
    if abs(diff) <= 2 or new == scale:
        return None, True, "board %.2f V vs ESC %.2f V (%+.1f %%): within 2 %%, vbat_scale %d stays" % (v_fc, v_esc, diff, scale)
    return new, None, "board %.2f V vs ESC %.2f V (%+.1f %%): vbat_scale %d -> %d" % (v_fc, v_esc, diff, scale, new)


def watch(port, seconds, stop_at_state=None, on_sample=None):
    s = open_port(port, 30)
    rows, t_end = [], time.time() + seconds
    while time.time() < t_end:
        x = sample(s)
        if x:
            rows.append(x)
            if on_sample:
                on_sample(s, x, rows)
            if stop_at_state is not None and x["state"] == stop_at_state and sum(r["state"] == stop_at_state for r in rows) > 8:
                break
        time.sleep(0.2)
    s.close()
    return rows


def show(rows, label):
    for r in rows[:: max(1, len(rows) // 25)]:
        e = r["esc"] or {}
        print("   %5.1fs %-11s cmd %5.1f%% out %4d | board %5.2f V | ESC rpm %6s V %5s T %3s bad %5s"
              % (r["t"] - rows[0]["t"], STATE.get(r["state"], r["state"]), r["pct"], r["motor"], r["v_fc"],
                 e.get("rpm"), e.get("volts"), e.get("temp"), e.get("bad")))
    print("   (%s: %d samples)" % (label, len(rows)))


def run(port, label, sets, seconds, stop_at_state=None, on_sample=None):
    """One capped program run: mode POWER + the given settings, saved (reboot) - the battery is already in,
    so the countdown starts at boot - then watched, then back to mode OFF. A mode OFF the board does not confirm
    leaves it in the CLI, where the program is held (cli())."""
    print("\n%s: %s" % (label, ", ".join(sets)))
    cli(port, ["set autostart_mode = POWER"] + ["set " + x for x in sets] + ["save"], wait=1.0)  # watch from the boot on
    try:
        rows = watch(port, seconds, stop_at_state, on_sample)
    finally:
        cli(port, ["set autostart_mode = OFF", "save"])
    show(rows, label)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--apply-scale", action="store_true")
    ap.add_argument("--only", default="0,1,2,3,4,5")
    ap.add_argument("--finish", action="store_true", help="battery unplugged: autostart_mode back to POWER")
    ap.add_argument("--restore", action="store_true", help="battery unplugged: put back the settings of an interrupted run")
    ap.add_argument("--wait-min", type=int, default=5, help="how long to wait for the battery")
    ap.add_argument("--dry-run", action="store_true", help="USB only, no battery: autostart_vbat_min = 0 so the program runs with the ESC unpowered (checks the flow, not RPM)")
    a = ap.parse_args()
    only = {int(x) for x in a.only.split(",")}

    global MASK
    keep = load_keep()
    if a.finish or a.restore:
        # POWER, or the saved settings, with a battery in = the save reboots the board into a countdown
        no_battery_or_exit(a.port, "--restore" if a.restore else "--finish")
        if a.restore:
            if not keep:
                raise SystemExit("no saved settings (%s): nothing to restore" % KEEP_FILE)
            cmds = ["set %s = %s" % (k, v) for k, v in keep.items() if k != "autostart_mode"] + ["set autostart_mode = OFF"]
            cli(a.port, cmds + ["save"])
            got = cli(a.port, ["get " + k for k in KEEP] + ["exit noreboot"], wait=1.0)
            vals = {l.split(" = ")[0].strip(): l.split(" = ")[1].strip() for l in got.splitlines() if " = " in l}
            bad = [k for k in keep if k != "autostart_mode" and vals.get(k) != keep[k]]
            if bad:
                raise SystemExit("restore not confirmed for: %s" % ", ".join(bad))
            os.remove(KEEP_FILE)
            print("restored the saved settings with autostart_mode = OFF; run --finish to put POWER back")
            return
        if keep:
            raise SystemExit("an earlier run did not restore its settings (%s): run --restore first" % KEEP_FILE)
        print(cli(a.port, ["set autostart_mode = POWER", "save"]) and "autostart_mode = POWER: the motor starts again on every power-up")
        return
    if keep:
        raise SystemExit("an earlier run did not restore its settings (%s): run --restore first" % KEEP_FILE)
    # read-only visit: `exit noreboot` leaves the CLI without a restart (the program stays held)
    text = cli(a.port, ["get " + k for k in KEEP] + ["exit noreboot"], wait=1.0)
    vals = {l.split(" = ")[0].strip(): l.split(" = ")[1].strip() for l in text.splitlines() if " = " in l}
    base = {k: vals[k] for k in KEEP if k in vals}
    missing = [k for k in KEEP if k not in base]
    if missing:
        raise SystemExit("could not read %s from the board: nothing changed" % ", ".join(missing))
    MASK = int(base["autostart_motors"])
    save_keep(base)
    print("board now:", base)
    if base.get("autostart_mode") != "OFF":
        cli(a.port, ["set autostart_mode = OFF", "save"])
        print("autostart_mode -> OFF for the session")
    restore = ["set %s = %s" % (k, v) for k, v in base.items() if k != "autostart_mode"] + ["set autostart_mode = OFF"]
    restored = []
    cells, scale = int(base.get("autostart_cells", 6)), int(base.get("vbat_scale", 210))
    if a.dry_run:
        cli(a.port, ["set autostart_vbat_min = 0", "save"])
        print("dry run: autostart_vbat_min = 0 (the board acts as if a battery were in; ESC unpowered)")
    results = {}
    try:
        print("\nbattery: plug it in now (propeller off). Waiting up to %d min ..." % a.wait_min, flush=True)
        t_end, seen = time.time() + a.wait_min * 60, False
        while time.time() < t_end and not seen:   # the USB cable may be unplugged meanwhile (soldering)
            try:
                s = open_port(a.port, 5)
                for _ in range(20):
                    x = sample(s)
                    # the voltage itself: with autostart_mode = OFF the module does not update its debug flags
                    if x and (x["v_fc"] > 6.0 or (x["esc"] and x["esc"]["volts"] > 6.0)):
                        seen = True
                        break
                    time.sleep(0.5)
                s.close()
            except (serial.SerialException, SystemExit, OSError):
                time.sleep(2)
        if not seen:
            raise SystemExit("no battery within %d min" % a.wait_min)
        print("battery seen by the board; settling 5 s", flush=True)
        time.sleep(5)

        if only & {0, 1}:
            rows = watch(a.port, 15)
            show(rows, "0 idle, mode OFF")
            moved = [r for r in rows if r["motor"] > 1000 or (r["esc"] and r["esc"]["rpm"] > 0)]
            results["0 nothing turns with mode OFF"] = not moved
            v = sorted(r["v_fc"] for r in rows)[len(rows) // 2]
            ev = sorted(r["esc"]["volts"] for r in rows if r["esc"] and r["esc"]["volts"] > 1) or [0]
            ev = ev[len(ev) // 2]
            print("1) board %.2f V (%.2f V/cell)  ESC %.2f V" % (v, v / cells if cells else 0, ev))
            results["1 ESC reports its voltage"] = ev > 1
            new_scale, verdict, why = calibration(v, ev, cells, scale)
            print("   " + why)
            if a.apply_scale and new_scale:
                cli(a.port, ["set vbat_scale = %d" % new_scale, "save"])
                rows = watch(a.port, 6)
                v2 = sorted(r["v_fc"] for r in rows)[len(rows) // 2]
                good = abs(v2 - ev) / ev < 0.02
                print("   vbat_scale %d -> board now %.2f V vs ESC %.2f V" % (new_scale, v2, ev))
                results["1 calibrated board within 2 % of the ESC"] = good
                if good:   # otherwise the restore puts the old value back
                    restore = [r for r in restore if not r.startswith("set vbat_scale")] + ["set vbat_scale = %d" % new_scale]
                    save_keep(dict(base, vbat_scale=str(new_scale)))
            elif a.apply_scale and verdict is not None:
                results["1 vbat_scale: " + why] = verdict

        if 2 in only:
            rows = run(a.port, "2 run", ["autostart_delay = 3", "autostart_ramp = 30", "autostart_throttle = 15",
                                          "autostart_run_time = 8", "autostart_pattern = STEADY"], 22, stop_at_state=4)
            at_run = [r["esc"]["rpm"] for r in rows if r["state"] == 3 and r["esc"]]
            done = [r for r in rows if r["state"] == 4]
            results["2 motor turns at the target (RPM > 0)"] = bool(at_run) and min(at_run) > 0
            results["2 stops by itself after the run time"] = bool(done) and max(r["motor"] for r in done) <= 1000

        if 3 in only:
            rows = run(a.port, "3 gusts", ["autostart_delay = 3", "autostart_ramp = 10", "autostart_throttle = 15",
                                            "autostart_run_time = 10", "autostart_pattern = GUSTS"], 22, stop_at_state=4)
            rpm = [r["esc"]["rpm"] for r in rows if r["state"] == 3 and r["esc"] and r["esc"]["rpm"] > 0]
            gust = [r for r in rows if r["flags"] & 16]
            results["3 gusts seen (flag) and RPM varies"] = bool(gust) and bool(rpm) and max(rpm) > 1.3 * min(rpm)
            results["3 stops after the run time"] = any(r["state"] == 4 for r in rows)

        if 4 in only:
            sent = []

            def stop_once(s, x, rows):
                if x["state"] == 1 and not sent:      # countdown: what the web page's STOP sends
                    s.write(msp_frame(214, struct.pack("<8H", *[1000] * 8)))
                    sent.append(x["t"])
            rows = run(a.port, "4 STOP during the countdown", ["autostart_delay = 10", "autostart_ramp = 30", "autostart_throttle = 15",
                                                                 "autostart_run_time = 8", "autostart_pattern = STEADY"], 25, on_sample=stop_once)
            after = [r for r in rows if sent and r["t"] > sent[0]]
            results["4 STOP sent during the countdown"] = bool(sent)
            results["4 nothing turns after STOP (held flag)"] = bool(after) and all(r["motor"] <= 1000 and r["state"] in (0, 4) for r in after[3:]) \
                and any(r["flags"] & 64 for r in after)

        v_now = None
        try:
            s = open_port(a.port, 5)
            v_now = (sample(s) or {}).get("v_fc")
            s.close()
        except (serial.SerialException, SystemExit, OSError):
            pass
        if 5 in only and cells and v_now and v_now / cells >= 4.15:
            print("\n5 cut-off: SKIPPED, the pack is at %.2f V/cell, at or above the highest cut-off (4.20 V/cell)" % (v_now / cells))
        elif 5 in only:
            rows = run(a.port, "5 cut-off", ["autostart_delay = 3", "autostart_ramp = 30", "autostart_throttle = 15", "autostart_run_time = 12",
                                              "autostart_cell_cutoff = 420", "autostart_cutoff_time = 2", "autostart_pattern = STEADY"], 20, stop_at_state=5)
            low = [r for r in rows if r["state"] == 5]
            results["5 cut-off: LOW_BATTERY and motor stopped"] = bool(low) and max(r["motor"] for r in low) <= 1000
    finally:
        cli(a.port, restore + ["save"])
        restored.append(True)
        print("\nrestored: " + "; ".join(x[4:] for x in restore))
    if restored and os.path.exists(KEEP_FILE):
        os.remove(KEEP_FILE)
    print()
    for k, ok in results.items():
        print(("PASS " if ok else "FAIL ") + k)
    print("ALL PASS" if results and all(results.values()) else "NOT ALL PASS")


if __name__ == "__main__":
    main()
