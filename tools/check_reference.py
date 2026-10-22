"""Compare a board with the reference setup (configs/reference/reference.json): read-only, nothing is saved.

usage: python tools/check_reference.py PORT [--cells N] [--motors MASK] [--usb-inhibit ON|OFF]
                                       [--no-esc-sensor] [--vbat-scale N] [--protocol NAME] [--no-vbat-meter]
                                       [--commit SHA] [--board NAME] [--exit]
       python tools/check_reference.py --from-file cli.txt [same options]
  PORT            the board's USB serial port (Windows COM6, Linux /dev/ttyACM0, macOS /dev/cu.usbmodem...)
  --from-file     a saved CLI log instead of a port: the output of `version`, `status`, `get autostart`,
                  `get motor_pwm_protocol`, `get dshot_bidir`, `get debug_mode`, `get vbat_scale`,
                  `get battery_meter`, `feature`, `serial` (UTF-8 or UTF-16, as PowerShell writes it)
  --cells/--motors/--usb-inhibit   the values adapted to YOUR hardware (default: the reference 6 / 15 / OFF)
  --no-esc-sensor no ESC TX wire: feature ESC_SENSOR is not expected
  --vbat-scale N  your calibrated value: checked (otherwise WARN while it is still at the build default)
  --protocol NAME an ESC that needs another protocol (e.g. PWM; then ESC_SENSOR is not expected either)
  --no-vbat-meter a board without battery voltage sensing: battery_meter is not ADC, USB inhibit must be ON
  --commit SHA    the commit you built: the firmware's revision must match it
  --board NAME    the board_name the firmware must report
  --exit          send `exit` at the end: the board restarts WITHOUT saving. With a battery in and
                  autostart_mode POWER the countdown starts again: propeller off. Without --exit the board stays
                  in the CLI (the program is held, nothing starts) until it is unplugged or restarted.
Entering the CLI stops a running program (by design). Needs pyserial for a port: pip install pyserial.
Exit codes: 0 no FAIL (WARN lines are shown but do not fail), 1 a FAIL, 2 the board could not be read.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((REPO / "configs" / "reference" / "reference.json").read_text(encoding="utf-8"))
COMMANDS = ["version", "status", "get autostart", "get motor_pwm_protocol", "get dshot_bidir", "get debug_mode",
            "get vbat_scale", "get battery_meter", "feature", "serial"]
ESC_SENSOR_FUNCTION = 1024


def read_text(path):
    raw = Path(path).read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    return raw.decode("utf-8-sig", errors="replace")


def parse(text):
    """CLI output -> settings, their non-default markers, features, serial functions, board, mcu, revision, gyro"""
    settings, defaults, serial_fn, features = {}, {}, {}, None
    board = mcu = revision = gyro = None
    last = None
    for raw in text.splitlines():
        line = raw.strip()
        m = re.match(r"^([a-z][a-z0-9_]*) = (\S+)$", line)
        if m:
            last = m.group(1)
            settings[last] = m.group(2)
            continue
        m = re.match(r"^Default value: (\S+)", line)
        if m and last:
            defaults[last] = m.group(1)  # Betaflight prints it only when the value differs from the build default
            continue
        m = re.match(r"^Enabled:\s+(.*)$", line)
        if m:
            features = set(m.group(1).split())
            continue
        m = re.match(r"^serial (\S+) (\d+) ", line)
        if m:
            serial_fn[m.group(1)] = int(m.group(2))
            continue
        m = re.match(r"^GYRO(?::\s*|=)(.*)$", line)  # 2025.12: "GYRO: (1) ICM42688P enabled ...", 4.x: "GYRO=..."
        if m:
            gyro = m.group(1).strip()
            continue
        m = re.search(r"board_name: (\S+)", line)
        if m:
            board = m.group(1)
        m = re.match(r"^# Betaflight / (\S+) .*?\((\S+?)\) MSP API", line)
        if m:
            mcu, revision = m.group(1), m.group(2)
    return {"settings": settings, "defaults": defaults, "features": features, "serial": serial_fn, "board": board,
            "mcu": mcu, "revision": revision, "gyro": gyro}


def expected(cells, motors, usb_inhibit, protocol=None):
    exp = dict(REFERENCE["cli"])
    exp["autostart_cells"] = str(cells)
    exp["autostart_motors"] = str(motors)
    exp["autostart_usb_inhibit"] = usb_inhibit
    if protocol:
        exp["motor_pwm_protocol"] = protocol
    return exp


def check(state, cells, motors, usb_inhibit, esc_sensor=True, vbat_scale=None, protocol=None, vbat_meter=True,
          commit=None, board=None):
    """-> list of (status, name, found, wanted); status PASS / FAIL / WARN / INFO"""
    rows = []
    rev = state["revision"] or ""
    rows.append(("PASS" if rev.startswith("as-") else "FAIL", "firmware", rev or "not read",
                 "Shramko Motor Autostart build (revision as-<commit>)"))
    if commit:
        got, want = rev[3:] if rev.startswith("as-") else "", commit.strip().lower()
        same = bool(got) and (want.startswith(got.lower()) or got.lower().startswith(want))
        rows.append(("PASS" if same else "FAIL", "firmware commit", got or "none", want[:12]))
    if board:
        rows.append(("PASS" if state["board"] == board else "FAIL", "board_name", state["board"] or "not read", board))
    else:
        rows.append(("INFO", "board", "%s (%s)" % (state["board"], state["mcu"]), ""))
    g = state["gyro"]
    has_gyro = bool(g) and not g.upper().startswith(("NONE", "NOT"))
    rows.append(("PASS" if has_gyro else "FAIL", "gyro (status)", g or "not read",
                 "a detected gyro: Betaflight drives the motors only with one"))
    for name, want in expected(cells, motors, usb_inhibit, protocol).items():
        got = state["settings"].get(name)
        rows.append(("PASS" if got == want else "FAIL", name, got if got is not None else "not read", want))
    meter = state["settings"].get("battery_meter")
    if vbat_meter:
        rows.append(("PASS" if meter == "ADC" else "FAIL", "battery_meter", meter or "not read",
                     "ADC (the battery gate and the cut-off need it)"))
    else:
        rows.append(("INFO", "battery_meter", meter or "not read", "no voltage sensing (--no-vbat-meter): no gate, no cut-off"))
    feats = state["features"]
    has = feats is not None and "ESC_SENSOR" in feats
    ports = [p for p, fn in state["serial"].items() if fn & ESC_SENSOR_FUNCTION]
    if esc_sensor:
        rows.append(("PASS" if has else "FAIL", "feature ESC_SENSOR", "on" if has else ("off" if feats is not None else "not read"), "on"))
        rows.append(("PASS" if ports else "FAIL", "serial ESC_SENSOR (1024)", ", ".join(ports) or "no port", "one UART"))
    else:
        rows.append(("INFO", "feature ESC_SENSOR", "on" if has else "off", "not expected"))
    got = state["settings"].get("vbat_scale")
    if vbat_scale is not None:
        rows.append(("PASS" if got == str(vbat_scale) else "FAIL", "vbat_scale", got or "not read", str(vbat_scale)))
    elif got is not None and "vbat_scale" not in state["defaults"]:
        rows.append(("WARN", "vbat_scale", got, "still the build default: calibrate it (AGENT_PORTING.md, step 8)"))
    else:
        rows.append(("INFO", "vbat_scale", got or "not read",
                     "changed from the default %s; pass --vbat-scale to check it" % state["defaults"].get("vbat_scale", "?")))
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
    ap.add_argument("port", nargs="?", help="the board's serial port")
    ap.add_argument("--from-file", help="a saved CLI log instead of a port")
    ap.add_argument("--cells", type=int, default=int(REFERENCE["cli"]["autostart_cells"]), help="your battery's cells (reference 6)")
    ap.add_argument("--motors", type=lambda s: int(s, 0), default=int(REFERENCE["cli"]["autostart_motors"]),
                    help="outputs whose motor should spin, bitmask (reference 15)")
    ap.add_argument("--usb-inhibit", choices=["ON", "OFF"], help="reference OFF; ON with --no-vbat-meter")
    ap.add_argument("--no-esc-sensor", action="store_true", help="no ESC TX wire")
    ap.add_argument("--vbat-scale", type=int, help="your calibrated vbat_scale")
    ap.add_argument("--protocol", help="motor_pwm_protocol your ESC needs (reference DSHOT300)")
    ap.add_argument("--no-vbat-meter", action="store_true", help="the board has no battery voltage sensing")
    ap.add_argument("--commit", help="the commit the firmware was built from")
    ap.add_argument("--board", help="the board_name the firmware must report")
    ap.add_argument("--exit", action="store_true", help="restart the board at the end (no save)")
    a = ap.parse_args(argv)
    if bool(a.port) == bool(a.from_file):
        ap.error("give a PORT or --from-file")
    usb = a.usb_inhibit or ("ON" if a.no_vbat_meter else REFERENCE["cli"]["autostart_usb_inhibit"])
    protocol = a.protocol.upper() if a.protocol else None
    esc_sensor = not a.no_esc_sensor and protocol in (None, "DSHOT150", "DSHOT300", "DSHOT600")
    try:
        text = read_text(a.from_file) if a.from_file else read_port(a.port, a.exit)
    except Exception as e:  # serial errors, missing file, no prompt
        print("cannot read the board: %s" % e)
        return 2
    state = parse(text)
    if not state["settings"]:
        print("cannot read the board: no `name = value` lines in the CLI output")
        return 2
    rows = check(state, a.cells, a.motors, usb, esc_sensor, a.vbat_scale, protocol, not a.no_vbat_meter, a.commit, a.board)
    w = max(len(r[1]) for r in rows)
    for st, name, got, want in rows:
        print("%-4s  %-*s  %-12s %s" % (st, w, name, got, ("(want %s)" % want) if st == "FAIL" else want if st in ("INFO", "WARN") else ""))
    fails = [r for r in rows if r[0] == "FAIL"]
    warns = [r for r in rows if r[0] == "WARN"]
    print("RESULT: %s%s" % ("PASS, the board matches the reference setup" if not fails else
                            "FAIL, %d setting(s) differ: %s" % (len(fails), ", ".join(r[1] for r in fails)),
                            "; WARN: %s" % ", ".join(r[1] for r in warns) if warns else ""))
    if a.port and not a.exit:
        print("the board stays in the CLI (program held) until it is unplugged or restarted (--exit)")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
