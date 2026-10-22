"""Shramko Motor Autostart - measure the autostart program on the real flight controller over USB.

What it does
  1. Reads the program settings from the board itself (CLI `get autostart`), then reboots it.
  2. Reconnects and samples every ~0.1 s:
       MSP_MOTOR            what Betaflight sends to the motor (1000 = stop ... 2000 = full)
       MSP_DEBUG            debug_mode = AUTOSTART: [0] state, [1] % x10, [2] ms in state / 10,
                            [3] FC uptime 0.1 s, [4] flags (1 USB, 2 RX, 4 button, 8 battery),
                            [5] battery 0.1 V, [6] time since the battery appeared 0.1 s, [7] source
       MSP_MOTOR_TELEMETRY  motor RPM and invalid-frame % (bidirectional DShot, ESC on battery)
       MSP_BATTERY_STATE    battery voltage
  3. Measures - independently of the expected values - when the ramp started and ended (FC clock and
     host clock), checks the output against a straight line and the plateau, prints PASS/FAIL.

usage
  python autostart_selftest.py COM6 [--seconds 35] [--plot ramp.png] [--csv run.csv] [--hot]
  python autostart_selftest.py COM6 --expect-off            negative control: the motor must stay at stop
  python autostart_selftest.py X --analyze --csv run.csv --delay 10 --ramp 10 --throttle 15
  python autostart_selftest.py X --self-check --csv run.csv --delay 10 --ramp 10 --throttle 15
        (evaluator check: the recorded run must PASS, copies with wrong timing / plateau must FAIL)

Without a battery set `autostart_vbat_min = 0` on the board, otherwise the program waits for the battery.
With a battery connected the motor really turns: the test refuses unless --hot is given (propeller off).
At the end it sends STOP (what the Configurator Motors tab / the web page's STOP sends): the program is held
until the board restarts, so a hot run does not keep the motor turning.
"""
import argparse, csv, statistics, struct, sys, time
import serial

MSP_REBOOT, MSP_MOTOR, MSP_BATTERY_STATE, MSP_MOTOR_TELEMETRY, MSP_DEBUG = 68, 104, 130, 139, 254
MSP_SET_MOTOR = 214
STATE = {0: "IDLE", 1: "DELAY", 2: "RAMP", 3: "RUN", 4: "DONE", 5: "LOW_BATTERY"}
SOURCE = {0: "NONE", 1: "POWER", 2: "BUTTON", 3: "RC_BOX"}
COLS = ["fc_uptime_s", "motor_us", "state", "percent", "state_ms", "usb", "rx", "button", "source",
        "rpm", "esc_invalid_pct", "vbat_v", "battery_present", "battery_age_s", "host_s"]


# ---------------------------------------------------------------- serial helpers
def msp_frame(cmd, payload=b""):
    c = len(payload) ^ cmd
    for b in payload:
        c ^= b
    return b"$M<" + bytes([len(payload), cmd]) + payload + bytes([c])


def msp(s, cmd, timeout=0.3):
    s.write(msp_frame(cmd))
    t0, buf = time.time(), b""
    while time.time() - t0 < timeout:
        buf += s.read(64)
        # skip complete frames of other commands (e.g. the ack of an earlier MSP_SET_MOTOR still in the buffer)
        while True:
            i = buf.find(b"$M>")
            if i < 0 or len(buf) < i + 5:
                break
            n = buf[i + 3]
            if len(buf) < i + 6 + n:
                break
            if buf[i + 4] == cmd:
                return buf[i + 5:i + 5 + n]
            buf = buf[i + 6 + n:]
    return None


def open_port(port, deadline_s):
    t_end = time.time() + deadline_s
    while time.time() < t_end:
        try:
            return serial.Serial(port, 115200, timeout=0.02)
        except serial.SerialException:
            time.sleep(0.05)
    raise SystemExit("port did not come back: " + port)


def read_settings_and_reboot(port):
    """CLI `get autostart` on the board, then `exit` (reboots it)."""
    s = serial.Serial(port, 115200, timeout=0.3)
    time.sleep(0.3)
    for _ in range(10):
        s.reset_input_buffer()
        s.write(b"#")
        time.sleep(1.0)
        if s.read(2000).rstrip().endswith(b"#"):
            break
    s.write(b"\r\nget autostart\r\n")
    out, t0 = b"", time.time()
    last = time.time()
    while time.time() - t0 < 5:
        chunk = s.read(4096)
        if chunk:
            out += chunk
            last = time.time()
        elif out.rstrip().endswith(b"#") and time.time() - last > 0.4:
            break
    s.write(b"get dshot_bidir\r\n")
    t0 = time.time()
    while time.time() - t0 < 2:
        out += s.read(4096)
        if b"dshot_bidir = " in out and out.rstrip().endswith(b"#"):
            break
    s.write(b"exit\r\n")
    time.sleep(0.3)
    try:
        s.close()
    except Exception:
        pass
    cfg = {}
    for line in out.decode(errors="replace").splitlines():
        if line.startswith(("autostart_", "dshot_bidir")) and " = " in line:
            k, v = line.split(" = ", 1)
            cfg[k.strip()] = v.strip()
    return cfg


# ---------------------------------------------------------------- capture
def battery_volts(port):
    """the board's battery reading over MSP before the test (None: no MSP answer, e.g. the board is in the CLI)"""
    s = open_port(port, 10)
    time.sleep(0.3)
    b = None
    for _ in range(5):
        b = msp(s, MSP_BATTERY_STATE)
        if b and len(b) >= 11:
            break
    s.close()
    return struct.unpack_from("<H", b, 9)[0] / 100.0 if b and len(b) >= 11 else None


def capture(a):
    v = battery_volts(a.port)
    if v is not None and v >= 1.0 and not a.hot:
        raise SystemExit("a battery is connected (board %.2f V): the test reboots the board and the motor turns. "
                         "Propeller off, then run again with --hot (or unplug the battery)." % v)
    cfg = read_settings_and_reboot(a.port)
    if cfg:
        a.delay = float(cfg.get("autostart_delay", a.delay))
        a.ramp = float(cfg.get("autostart_ramp", a.ramp * 10)) / 10.0
        a.throttle = float(cfg.get("autostart_throttle", a.throttle))
        a.bidir = cfg.get("dshot_bidir") == "ON"
        a.cfg = cfg
        print("settings read from the board:", ", ".join("%s=%s" % kv for kv in sorted(cfg.items())))
    time.sleep(1.0)
    s = open_port(a.port, 15)
    rows, t_start = [], time.monotonic()
    t_end = time.time() + a.seconds
    while time.time() < t_end:
        try:
            m, d = msp(s, MSP_MOTOR), msp(s, MSP_DEBUG)
            t = msp(s, MSP_MOTOR_TELEMETRY)
            b = msp(s, MSP_BATTERY_STATE)
        except serial.SerialException:
            s.close()
            s = open_port(a.port, 5)
            continue
        if not m or not d or len(d) < 16:
            continue
        motors = struct.unpack("<%dH" % (len(m) // 2), m)
        dbg = struct.unpack("<8h", d[:16])
        rpm, inv, vbat = -1, -1.0, -1.0
        if t and t[0] >= 1:
            # all four outputs may carry the signal: report the motor whose ESC answers best
            best = None
            for i in range(min(t[0], 8)):
                if len(t) >= 1 + 13 * (i + 1):
                    r_, inv_raw = struct.unpack_from("<IH", t, 1 + 13 * i)
                    if best is None or inv_raw < best[1]:
                        best = (r_, inv_raw)
            if best:
                rpm, inv = best[0], best[1] / 100.0
        if b and len(b) >= 11:
            vbat = struct.unpack_from("<H", b, 9)[0] / 100.0
        f = dbg[4]
        rows.append((dbg[3] / 10.0, motors[a.motor - 1], dbg[0], dbg[1] / 10.0, dbg[2] * 10,
                     f & 1, (f >> 1) & 1, (f >> 2) & 1, dbg[7], rpm, inv, vbat, (f >> 3) & 1, dbg[6] / 10.0,
                     round(time.monotonic() - t_start, 3)))
    # STOP: the program is held until the board restarts (a hot run must not keep the motor turning)
    try:
        s.write(msp_frame(MSP_SET_MOTOR, struct.pack("<8H", *[1000] * 8)))
        time.sleep(0.2)
    except serial.SerialException:
        pass
    s.close()
    with open(a.csv, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(COLS)
        w.writerows(rows)
    return rows


def load_csv(path):
    with open(path, newline="") as fh:
        rd = csv.reader(fh)
        next(rd)
        rows = [tuple(float(x) for x in r) for r in rd]
    return [r + (0.0,) * (len(COLS) - len(r)) if len(r) < len(COLS) else r for r in rows]


# ---------------------------------------------------------------- evaluation
def esc_report(a, rows):
    tel = [r for r in rows if r[9] >= 0 and r[10] >= 0]
    if a.bidir is False or (a.bidir is None and tel and all(r[9] == 0 and r[10] == 0 for r in tel)):
        tel = []           # without bidirectional DShot Betaflight reports 0 RPM / 0 % - that is not an answer
    vb = [r[11] for r in rows if r[11] > 0]
    if vb:
        print("battery voltage (FC): %.2f..%.2f V" % (min(vb), max(vb)))
    if not tel:
        print("ESC telemetry: not available (dshot_bidir = OFF) - nothing is claimed about the ESC")
        return None
    talking = [r for r in tel if r[10] < 5.0]
    if not talking:
        print("ESC telemetry: NO ANSWER (invalid %.0f %%) - ESC unpowered, signal wire, or ESC without"
              " bidirectional DShot" % min(r[10] for r in tel))
        return False
    print("ESC answers: %d of %d samples with < 5 %% bad frames" % (len(talking), len(tel)))
    spin = next((r for r in talking if r[9] > 0), None)
    print("motor first turns at FC uptime %s s" % (None if spin is None else spin[0]))
    run = [r[9] for r in talking if r[2] == 3]
    if run:
        print("RPM at target: mean %.0f, min %d, max %d" % (sum(run) / len(run), min(run), max(run)))
    return True


def evaluate(a, rows, quiet=False):
    say = (lambda *x: None) if quiet else print
    if not rows:
        say("FAIL: no samples")
        return False
    say("samples: %d over %.1f s of FC time" % (len(rows), rows[-1][0] - rows[0][0]))
    say("states:", [STATE.get(int(x), x) for x in sorted({r[2] for r in rows})],
        "| sources:", [SOURCE.get(int(x), x) for x in sorted({r[8] for r in rows})],
        "| USB:", sorted({int(r[5]) for r in rows}), "| battery:", sorted({int(r[12]) for r in rows}))

    if a.expect_off:
        top = max(r[1] for r in rows)
        say("max motor value: %d" % top)
        ok = top <= 1000
        say("PASS (motor stayed at stop)" if ok else "FAIL (motor moved)")
        return ok

    # Transition times are measured on the FC clock: raw uptime (0.1 s steps, +0.05 s = middle of the
    # step) minus the 10 ms time-in-state counter, median over all samples of the state. Nothing here
    # is derived from the expected delay / ramp.
    def origin(rs):
        return statistics.median([r[0] + 0.05 - r[4] / 1000.0 for r in rs]) if rs else None

    ramp_rows = [r for r in rows if r[2] == 2]
    run_rows = [r for r in rows if r[2] == 3]
    t_ramp, t_run = origin(ramp_rows), origin(run_rows)
    # battery origin from the samples before the ramp only (independent of the ramp timing)
    bat = [r[0] + 0.05 - r[13] for r in rows if r[12] == 1 and r[13] >= 0 and r[2] in (0, 1)]
    t_bat = statistics.median(bat) if bat else 0.0
    if t_bat < 0.2:
        t_bat = 0.0            # battery powered the board: the countdown origin is the boot
    if t_ramp is None or t_run is None:
        say("FAIL: the program did not reach %s" % ("RAMP" if t_ramp is None else "RUN"))
        return False
    meas_delay, meas_ramp = t_ramp - t_bat, t_run - t_ramp
    say("battery origin %.2f s | ramp started %.2f s after it (expected %.1f) | ramp took %.2f s (expected %.1f)"
        % (t_bat, meas_delay, a.delay, meas_ramp, a.ramp))

    h_ramp = next((r[14] for r in rows if r[2] == 2), None)
    h_run = next((r[14] for r in rows if r[2] == 3), None)
    if h_ramp is not None and h_run is not None and h_run > 0:
        say("host clock cross-check: RAMP -> RUN took %.2f s (+-0.1 s sampling)" % (h_run - h_ramp))

    target = 1000.0 + 10.0 * a.throttle
    slope = 10.0 * a.throttle / a.ramp if a.ramp > 0 else 0.0
    err_ramp = [abs(r[1] - (1000.0 + slope * r[4] / 1000.0)) for r in ramp_rows if r[4] > 30]
    plateau = [r[1] for r in run_rows]
    before = [r[1] for r in rows if r[2] in (0, 1)]
    tol = 2.0 + slope * 0.03
    say("ramp vs straight line: max error %.1f us (tolerance %.1f) | plateau %d..%d (expected %d) | max before ramp %d"
        % (max(err_ramp) if err_ramp else -1, tol, min(plateau), max(plateau), target, max(before) if before else -1))
    ok = (abs(meas_delay - a.delay) <= 0.15 and abs(meas_ramp - a.ramp) <= 0.15
          and (not err_ramp or max(err_ramp) <= tol)
          and abs(min(plateau) - target) <= 1 and abs(max(plateau) - target) <= 1
          and (not before or max(before) <= 1000))
    say("PASS" if ok else "FAIL")
    return ok


def evaluate_program(a, rows):
    """Firmware 1.1 programs: gusts, run time, throttle limit. Every RUN sample must be the steady
    level or a gust peak inside [gust_min, gust_max] (capped by the limit); with a run time the
    program must end in DONE after that time and the motor must be at stop."""
    cfg = a.cfg
    limit = float(cfg.get("autostart_throttle_limit", 100))
    base = min(a.throttle, limit)
    g = sorted([float(cfg.get("autostart_gust_min", 0)), float(cfg.get("autostart_gust_max", 0))])
    gmin, gmax = min(g[0], limit), min(g[1], limit)
    gusts_on = cfg.get("autostart_pattern") == "GUSTS"
    run_time = float(cfg.get("autostart_run_time", 0))

    def origin(rs):
        return statistics.median([r[0] + 0.05 - r[4] / 1000.0 for r in rs]) if rs else None

    run_rows = [r for r in rows if r[2] == 3]
    if not run_rows:
        print("FAIL: never reached RUN")
        return False
    base_us = 1000 + 10 * base
    lo, hi = 1000 + 10 * gmin, 1000 + 10 * gmax
    bad = [r[1] for r in run_rows if not (abs(r[1] - base_us) <= 1 or (gusts_on and lo - 1 <= r[1] <= hi + 1))]
    peaks = [r[1] for r in run_rows if abs(r[1] - base_us) > 1]
    print("RUN samples %d: steady level %d us, gust peaks seen %s (allowed %d..%d), out-of-range %d, max %d"
          % (len(run_rows), base_us, sorted(set(peaks))[:12], lo, hi, len(bad), max(r[1] for r in run_rows)))
    ok = not bad and max(r[1] for r in rows) <= 1000 + 10 * limit + 1
    if gusts_on:
        ok = ok and len(peaks) > 0 and (gmin == gmax or len(set(peaks)) > 1)
    if run_time:
        done = [r for r in rows if r[2] == 4]
        t_run, t_done = origin(run_rows), origin(done)
        after = [r[1] for r in done]
        if t_done is None:
            print("FAIL: run time %.0f s, but DONE never seen" % run_time)
            return False
        print("run time: RUN -> DONE took %.2f s (expected %.0f), motor after DONE max %d"
              % (t_done - t_run, run_time, max(after)))
        ok = ok and abs((t_done - t_run) - run_time) <= 0.2 and max(after) <= 1000
    print("PASS" if ok else "FAIL")
    return ok


def plot(a, rows, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(10, 4.5), dpi=110)
    xs = [r[0] + 0.05 for r in rows]
    ax.plot(xs, [(r[1] - 1000) / 10.0 for r in rows], color="#1f77b4", lw=2, label="command to ESC, %")
    ax.set_xlabel("FC uptime, s")
    ax.set_ylabel("throttle, %")
    ax.grid(alpha=0.3)
    tel = [(r[0] + 0.05, r[9]) for r in rows if r[9] >= 0 and 0 <= r[10] < 5]
    if tel:
        ax2 = ax.twinx()
        ax2.plot([x for x, _ in tel], [y for _, y in tel], color="#d62728", lw=1.5, label="motor RPM (ESC)")
        ax2.set_ylabel("RPM")
        ax2.legend(loc="lower right")
    ax.legend(loc="upper left")
    ax.set_title("Shramko Motor Autostart: delay %.0f s, ramp %.0f s, target %.0f %%" % (a.delay, a.ramp, a.throttle))
    fig.savefig(out, bbox_inches="tight", facecolor="white")
    print("plot:", out)


def self_check(a, rows):
    """The evaluator must accept the recorded run and reject runs whose timing or plateau is wrong."""
    def shift(dt):
        return [((r[0] + dt),) + tuple(r[1:]) if r[2] in (2, 3) else r for r in rows]
    low = [r[:1] + ((1000 + (r[1] - 1000) * 0.9) if r[2] == 3 else r[1],) + tuple(r[2:]) for r in rows]
    res = {"recorded run": evaluate(a, rows, True), "ramp 1 s early": evaluate(a, shift(-1.0), True),
           "ramp 1 s late": evaluate(a, shift(1.0), True), "plateau 10 % low": evaluate(a, low, True)}
    for k, v in res.items():
        print("%-18s -> %s" % (k, "PASS" if v else "FAIL"))
    good = res["recorded run"] and not any(v for k, v in res.items() if k != "recorded run")
    print("evaluator self-check:", "OK" if good else "BROKEN")
    return good


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port")
    ap.add_argument("--delay", type=float, default=10)
    ap.add_argument("--ramp", type=float, default=10)
    ap.add_argument("--throttle", type=float, default=15)
    ap.add_argument("--seconds", type=float, default=35)
    ap.add_argument("--motor", type=int, default=1)
    ap.add_argument("--expect-off", action="store_true")
    ap.add_argument("--hot", action="store_true", help="a battery is connected and the propeller is off: the motor turns")
    ap.add_argument("--csv", default="autostart_selftest.csv")
    ap.add_argument("--plot")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--self-check", action="store_true")
    a = ap.parse_args()
    a.bidir = None

    a.cfg = {}
    rows = load_csv(a.csv) if (a.analyze or a.self_check) else capture(a)
    if a.self_check:
        sys.exit(0 if self_check(a, rows) else 1)
    esc_report(a, rows)
    if a.plot:
        plot(a, rows, a.plot)
    special = a.cfg.get("autostart_pattern") == "GUSTS" or float(a.cfg.get("autostart_run_time", 0) or 0) > 0
    if special and not a.expect_off:
        sys.exit(0 if evaluate_program(a, rows) else 1)
    sys.exit(0 if evaluate(a, rows) else 1)


if __name__ == "__main__":
    main()
