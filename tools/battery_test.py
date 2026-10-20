"""Shramko Motor Autostart - the checks that need a real battery (ESC and motor connected, PROPELLER OFF).

  1. voltage: board reading vs. a plausible LiPo voltage for the configured cells and vs. the ESC's own
     measurement (ESC telemetry wire on UART5 with feature ESC_SENSOR, or extended DShot telemetry);
     prints the vbat_scale that would make the board agree with the ESC
  2. ESC answers and the motor turns (bidirectional DShot RPM), RPM follows the ramp
  3. cut-off: temporarily raises autostart_cell_cutoff above the pack voltage, saves, and checks the
     program goes to LOW_BATTERY after the delay + cut-off time and the motor stops; then restores

usage: python battery_test.py COM6 [--no-cutoff-test] [--apply-scale]
"""
import argparse, struct, sys, time
import serial

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
from autostart_selftest import msp, open_port  # noqa: E402

STATE = {0: "IDLE", 1: "DELAY", 2: "RAMP", 3: "RUN", 4: "DONE", 5: "LOW_BATTERY"}


def cli(port, cmds):
    """Run CLI commands, return the text. Ends with 'save' or 'exit' (both reboot the board)."""
    s = open_port(port, 20)
    time.sleep(0.3)
    for _ in range(10):
        s.reset_input_buffer()
        s.write(b"#")
        time.sleep(1.0)
        if s.read(4000).rstrip().endswith(b"#"):
            break
    s.write(b"\r\n")
    time.sleep(0.3)
    s.read(4000)
    out = ""
    for c in cmds:
        s.write(c.encode() + b"\r\n")
        time.sleep(0.6)
        try:
            out += s.read(8000).decode(errors="replace")
        except serial.SerialException:
            break
    try:
        s.close()
    except Exception:
        pass
    time.sleep(4)
    return out


def sample(s):
    m, d, t, b = msp(s, 104), msp(s, 254), msp(s, 139), msp(s, 130)
    if not (m and d and b):
        return None
    dbg = struct.unpack("<8h", d[:16])
    v_fc = struct.unpack_from("<H", b, 9)[0] / 100.0
    best = None
    if t:
        for i in range(min(t[0], 4)):
            rpm, inv, temp, ev, cur, cons = struct.unpack_from("<IHBHHH", t, 1 + 13 * i)
            if best is None or inv < best[1]:
                best = (rpm, inv / 100.0, temp, ev / 100.0, cur / 100.0, i + 1)
    return dict(state=dbg[0], pct=dbg[1] / 10.0, flags=dbg[4], v_fc=v_fc, esc=best,
                motor=struct.unpack("<H", m[:2])[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--no-cutoff-test", action="store_true")
    ap.add_argument("--apply-scale", action="store_true", help="write the vbat_scale suggested by the ESC")
    a = ap.parse_args()

    text = cli(a.port, ["get autostart_cells", "get autostart_cell_cutoff", "get vbat_scale", "exit"])
    vals = {l.split(" = ")[0].strip(): l.split(" = ")[1].strip() for l in text.splitlines() if " = " in l}
    cells, cutoff, scale = int(vals.get("autostart_cells", 6)), int(vals.get("autostart_cell_cutoff", 330)), int(vals.get("vbat_scale", 210))
    print("board: cells %d, cut-off %.2f V/cell, vbat_scale %d" % (cells, cutoff / 100, scale))

    s = open_port(a.port, 20)
    rows, t_end = [], time.time() + 30
    while time.time() < t_end:
        x = sample(s)
        if x:
            rows.append(x)
        time.sleep(0.25)
    s.close()
    if not rows:
        sys.exit("no MSP data")
    v = sorted(r["v_fc"] for r in rows)[len(rows) // 2]
    per_cell = v / cells if cells else 0
    print("1) board voltage %.2f V = %.2f V/cell (plausible LiPo 3.0..4.35), suspect flag %s"
          % (v, per_cell, any(r["flags"] & 32 for r in rows)))
    esc_v = [r["esc"][3] for r in rows if r["esc"] and r["esc"][3] > 1.0]
    if esc_v:
        ev = sorted(esc_v)[len(esc_v) // 2]
        new_scale = max(10, min(255, round(scale * ev / v))) if v > 1 else scale
        print("   ESC measures %.2f V -> suggested vbat_scale %d (now %d)" % (ev, new_scale, scale))
        if a.apply_scale and new_scale != scale:
            cli(a.port, ["set vbat_scale = %d" % new_scale, "save"])
            print("   vbat_scale set to %d" % new_scale)
    else:
        print("   ESC voltage: not available (solder the ESC TX pad to the cable's yellow wire, or BLHeli_32 >= 32.10 for EDT)")
    talking = [r for r in rows if r["esc"] and r["esc"][1] < 5]
    spin = [r["esc"][0] for r in talking if r["state"] == 3]
    print("2) ESC answers: %d/%d samples; RPM at target: %s; states %s"
          % (len(talking), len(rows), (min(spin), max(spin)) if spin else None, sorted({STATE[r['state']] for r in rows})))

    if a.no_cutoff_test:
        return
    print("3) cut-off test: autostart_cell_cutoff -> 420 (above any LiPo), expect LOW_BATTERY after delay + cut-off time")
    cli(a.port, ["set autostart_cell_cutoff = 420", "save"])
    s = open_port(a.port, 20)
    seen, t_end = [], time.time() + 40
    while time.time() < t_end:
        x = sample(s)
        if x:
            seen.append(x)
            if x["state"] == 5 and len([y for y in seen if y["state"] == 5]) > 8:
                break
        time.sleep(0.25)
    s.close()
    cli(a.port, ["set autostart_cell_cutoff = %d" % cutoff, "save"])
    low = [x for x in seen if x["state"] == 5]
    print("   states seen %s; motor after cut-off max %s -> %s" % (sorted({STATE[x['state']] for x in seen}),
          max(x["motor"] for x in low) if low else None, "PASS" if low and max(x["motor"] for x in low) <= 1000 else "FAIL"))
    print("   cut-off restored to %.2f V/cell" % (cutoff / 100))


if __name__ == "__main__":
    main()
