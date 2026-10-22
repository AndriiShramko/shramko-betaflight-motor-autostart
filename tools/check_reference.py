"""Compare a board with the reference setup (configs/reference/reference.json): read-only, nothing is saved.

usage: python tools/check_reference.py PORT [--cells N] [--motors MASK] [--usb-inhibit ON|OFF]
                                       [--no-esc-sensor] [--vbat-scale N] [--exit]
       python tools/check_reference.py --from-file cli.txt [same options]
  PORT            the board's USB serial port (Windows COM6, Linux /dev/ttyACM0, macOS /dev/cu.usbmodem...)
  --from-file     a saved CLI log instead of a port: the output of `version`, `get autostart`,
                  `get motor_pwm_protocol`, `get dshot_bidir`, `get debug_mode`, `get vbat_scale`, `feature`, `serial`
  --cells/--motors/--usb-inhibit   the values adapted to YOUR hardware (default: the reference 6 / 15 / OFF)
  --no-esc-sensor no ESC TX wire: feature ESC_SENSOR is not expected
  --vbat-scale N  your calibrated value: checked too (otherwise only shown)
  --exit          send `exit` at the end: the board restarts WITHOUT saving. With a battery in and
                  autostart_mode POWER the countdown starts again: propeller off. Without --exit the board stays
                  in the CLI (the program is held, nothing starts) until it is unplugged.
Entering the CLI stops a running program (by design). Needs pyserial for a port: pip install pyserial.
Exit codes: 0 every check PASS, 1 a FAIL, 2 the board could not be read.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((REPO / "configs" / "reference" / "reference.json").read_text(encoding="utf-8"))
COMMANDS = ["version", "get autostart", "get motor_pwm_protocol", "get dshot_bidir", "get debug_mode",
            "get vbat_scale", "feature", "serial"]
ESC_SENSOR_FUNCTION = 1024


def parse(text):
    """CLI output -> {settings, features, serial functions per port, board, mcu, revision}"""
    settings, serial_fn, features = {}, {}, None
    board = mcu = revision = None
    for raw in text.splitlines():
        line = raw.strip()
        m = re.match(r"^([a-z][a-z0-9_]*) = (\S+)$", line)
        if m:
            settings[m.group(1)] = m.group(2)
            continue
        m = re.match(r"^Enabled:\s+(.*)$", line)
        if m:
            features = set(m.group(1).split())
            continue
        m = re.match(r"^serial (\S+) (\d+) ", line)
        if m:
            serial_fn[m.group(1)] = int(m.group(2))
            continue
        m = re.search(r"board_name: (\S+)", line)
        if m:
            board = m.group(1)
        m = re.match(r"^# Betaflight / (\S+) .*?\((\S+?)\) MSP API", line)
        if m:
            mcu, revision = m.group(1), m.group(2)
    return {"settings": settings, "features": features, "serial": serial_fn, "board": board, "mcu": mcu,
            "revision": revision}


def expected(cells, motors, usb_inhibit):
    exp = dict(REFERENCE["cli"])
    exp["autostart_cells"] = str(cells)
    exp["autostart_motors"] = str(motors)
    exp["autostart_usb_inhibit"] = usb_inhibit
    return exp


def check(state, cells, motors, usb_inhibit, esc_sensor=True, vbat_scale=None):
    """-> list of (status, name, found, wanted); status PASS / FAIL / INFO"""
    rows = []
    rev = state["revision"] or ""
    rows.append(("PASS" if rev.startswith("as-") else "FAIL", "firmware", rev or "not read",
                 "Shramko Motor Autostart build (revision as-<commit>)"))
    rows.append(("INFO", "board", "%s (%s)" % (state["board"], state["mcu"]), ""))
    for name, want in expected(cells, motors, usb_inhibit).items():
        got = state["settings"].get(name)
        rows.append(("PASS" if got == want else "FAIL", name, got if got is not None else "not read", want))
    feats = state["features"]
    has = feats is not None and "ESC_SENSOR" in feats
    ports = [p for p, fn in state["serial"].items() if fn & ESC_SENSOR_FUNCTION]
    if esc_sensor:
        rows.append(("PASS" if has else "FAIL", "feature ESC_SENSOR", "on" if has else ("off" if feats is not None else "not read"), "on"))
        rows.append(("PASS" if ports else "FAIL", "serial ESC_SENSOR (1024)", ", ".join(ports) or "no port", "one UART"))
    else:
        rows.append(("INFO", "feature ESC_SENSOR", "on" if has else "off", "not expected (--no-esc-sensor)"))
    got = state["settings"].get("vbat_scale")
    if vbat_scale is not None:
        rows.append(("PASS" if got == str(vbat_scale) else "FAIL", "vbat_scale", got or "not read", str(vbat_scale)))
    else:
        rows.append(("INFO", "vbat_scale", got or "not read", "calibrate on this board (AGENT_PORTING.md, step 8)"))
    return rows


def read_port(port, leave):
    import serial  # pyserial

    s = serial.Serial(port, 115200, timeout=0.2)
    time.sleep(0.5)
    s.reset_input_buffer()
    s.write(b"#")
    time.sleep(1.0)
    got = s.read(4096)
    if b"CLI" not in got and not got.rstrip().endswith(b"#"):
        s.write(b"\r\n")
        time.sleep(0.5)
        got = s.read(4096)
        if not got.rstrip().endswith(b"#"):
            s.close()
            raise RuntimeError("no CLI prompt (close the Betaflight App / web configurator: one program per port)")
    s.write(b"\r\n")  # a fresh prompt: a '#' typed into an open CLI would turn the next line into a comment
    time.sleep(0.4)
    s.read(4096)
    out = []
    for cmd in COMMANDS:
        s.write(cmd.encode() + b"\r\n")
        buf, t_last, t0 = b"", time.time(), time.time()
        while time.time() - t0 < 15:
            chunk = s.read(4096)
            if chunk:
                buf, t_last = buf + chunk, time.time()
            elif buf.rstrip().endswith(b"#") and time.time() - t_last > 0.3:
                break
            elif time.time() - t_last > 1.5:
                break
        out.append(buf.decode(errors="replace"))
    if leave:
        s.write(b"exit\r\n")
        time.sleep(0.3)
    s.close()
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("port", nargs="?")
    ap.add_argument("--from-file")
    ap.add_argument("--cells", type=int, default=int(REFERENCE["cli"]["autostart_cells"]))
    ap.add_argument("--motors", type=lambda s: int(s, 0), default=int(REFERENCE["cli"]["autostart_motors"]))
    ap.add_argument("--usb-inhibit", choices=["ON", "OFF"], default=REFERENCE["cli"]["autostart_usb_inhibit"])
    ap.add_argument("--no-esc-sensor", action="store_true")
    ap.add_argument("--vbat-scale", type=int)
    ap.add_argument("--exit", action="store_true")
    a = ap.parse_args(argv)
    if bool(a.port) == bool(a.from_file):
        ap.error("give a PORT or --from-file")
    try:
        text = Path(a.from_file).read_text(encoding="utf-8", errors="replace") if a.from_file else read_port(a.port, a.exit)
    except Exception as e:  # serial errors, missing file, no prompt
        print("cannot read the board: %s" % e)
        return 2
    state = parse(text)
    if not state["settings"]:
        print("cannot read the board: no `name = value` lines in the CLI output")
        return 2
    rows = check(state, a.cells, a.motors, a.usb_inhibit, not a.no_esc_sensor, a.vbat_scale)
    w = max(len(r[1]) for r in rows)
    for st, name, got, want in rows:
        print("%-4s  %-*s  %-12s %s" % (st, w, name, got, ("(want %s)" % want) if st == "FAIL" else want if st == "INFO" else ""))
    fails = [r for r in rows if r[0] == "FAIL"]
    print("RESULT: %s" % ("PASS, the board matches the reference setup" if not fails else
                          "FAIL, %d setting(s) differ: %s" % (len(fails), ", ".join(r[1] for r in fails))))
    if a.port and not a.exit:
        print("the board stays in the CLI (program held) until it is unplugged or gets `exit`")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
