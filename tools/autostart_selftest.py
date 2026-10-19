"""Shramko Motor Autostart - bench self-test over USB (no ESC, no battery needed).

Reboots the flight controller, reconnects to its USB port and records, every ~50 ms:
  - MSP_MOTOR      (what Betaflight outputs to motors 1..8, 1000 = stop, 2000 = full)
  - MSP_DEBUG      (debug_mode = AUTOSTART: [0] state, [1] percent x10, [2] ms in state / 10,
                    [3] FC uptime in 0.1 s, [4] flags (1 USB, 2 RX, 4 button, 8 battery),
                    [5] battery 0.1 V, [6] time since battery 0.1 s, [7] source)
  - MSP_MOTOR_TELEMETRY / MSP_BATTERY_STATE (RPM and invalid-frame % over bidirectional DShot, voltage)

With a battery: the countdown starts when the battery voltage appears (autostart_vbat_min), so the
expected curve is measured from that moment (column power_age_s); without a battery set
autostart_vbat_min = 0.
Then checks the measured curve against the expected one: motor at stop until <delay>, linear ramp to
<throttle> % over <ramp> s, then constant. Prints PASS/FAIL with numbers and writes a CSV.

usage: python autostart_selftest.py COM6 --delay 10 --ramp 10 --throttle 15 --seconds 30 [--expect-off]
  --expect-off  negative control: the motor must stay at stop for the whole capture
                (e.g. autostart_mode = OFF, or USB inhibit ON)
"""
import argparse, csv, struct, sys, time
import serial

MSP_REBOOT, MSP_MOTOR, MSP_DEBUG = 68, 104, 254
MSP_BATTERY_STATE, MSP_MOTOR_TELEMETRY = 130, 139
STATE_NAMES = {0: "IDLE", 1: "DELAY", 2: "RAMP", 3: "RUN"}
SOURCE_NAMES = {0: "NONE", 1: "POWER", 2: "BUTTON", 3: "RC_BOX"}


def msp_frame(cmd, payload=b""):
    c = len(payload) ^ cmd
    for b in payload:
        c ^= b
    return b"$M<" + bytes([len(payload), cmd]) + payload + bytes([c])


def msp(s, cmd, timeout=0.3):
    s.write(msp_frame(cmd))
    t0 = time.time()
    buf = b""
    while time.time() - t0 < timeout:
        buf += s.read(64)
        i = buf.find(b"$M>")
        if i >= 0 and len(buf) >= i + 5:
            n = buf[i + 3]
            if len(buf) >= i + 6 + n and buf[i + 4] == cmd:
                return buf[i + 5:i + 5 + n]
    return None


def open_port(port, deadline):
    while time.time() < deadline:
        try:
            s = serial.Serial(port, 115200, timeout=0.02)
            return s
        except serial.SerialException:
            time.sleep(0.05)
    raise SystemExit("port did not come back: " + port)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--delay", type=float, default=10)
    ap.add_argument("--ramp", type=float, default=10)
    ap.add_argument("--throttle", type=float, default=15)
    ap.add_argument("--seconds", type=float, default=30)
    ap.add_argument("--motor", type=int, default=1)
    ap.add_argument("--expect-off", action="store_true")
    ap.add_argument("--no-reboot", action="store_true")
    ap.add_argument("--csv", default="autostart_selftest.csv")
    ap.add_argument("--analyze", action="store_true", help="only re-check an existing --csv, no FC needed")
    ap.add_argument("--plot", help="save a PNG of command / RPM over FC uptime")
    a = ap.parse_args()

    if a.analyze:
        with open(a.csv, newline="") as f:
            rd = csv.reader(f); next(rd)
            rows = [tuple(float(x) for x in r) for r in rd]
        return evaluate(a, rows)

    s = serial.Serial(a.port, 115200, timeout=0.05)
    if not a.no_reboot:
        s.write(msp_frame(MSP_REBOOT, b"\x00"))
        s.flush()
        time.sleep(0.2)
        s.close()
        time.sleep(0.8)
        s = open_port(a.port, time.time() + 15)

    rows = []
    t_end = time.time() + a.seconds
    while time.time() < t_end:
        try:
            m = msp(s, MSP_MOTOR)
            d = msp(s, MSP_DEBUG)
        except serial.SerialException:
            s.close()
            s = open_port(a.port, time.time() + 5)
            continue
        if not m or not d:
            continue
        motors = struct.unpack("<%dH" % (len(m) // 2), m)
        rpm, invalid_pct, vbat = -1, -1.0, -1.0
        try:
            t = msp(s, MSP_MOTOR_TELEMETRY)
            if t and t[0] >= a.motor and len(t) >= 1 + 13 * a.motor:
                o = 1 + 13 * (a.motor - 1)
                rpm, inv = struct.unpack_from("<IH", t, o)
                invalid_pct = inv / 100.0
            b = msp(s, MSP_BATTERY_STATE)
            if b and len(b) >= 11:
                vbat = struct.unpack_from("<H", b, 9)[0] / 100.0
        except serial.SerialException:
            pass
        dbg = struct.unpack("<%dh" % (len(d) // 2), d[:16]) if len(d) >= 16 else struct.unpack("<%di" % (len(d) // 4), d)[:8]
        uptime_s = dbg[3] / 10.0
        flags = dbg[4]
        rows.append((uptime_s, motors[a.motor - 1], dbg[0], dbg[1] / 10.0, dbg[2] * 10,
                     flags & 1, (flags >> 1) & 1, (flags >> 2) & 1, dbg[7],
                     rpm, invalid_pct, vbat, (flags >> 3) & 1, dbg[6] / 10.0))
    s.close()

    with open(a.csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["fc_uptime_s", "motor_us", "state", "percent", "state_ms", "usb", "rx", "button", "source",
                    "rpm", "esc_invalid_pct", "vbat_v", "battery_present", "power_age_s"])
        w.writerows(rows)

    return evaluate(a, rows)


def esc_report(a, rows):
    """What the ESC says back over bidirectional DShot (only when an ESC is connected and powered)."""
    tel = [r for r in rows if len(r) > 9 and r[9] >= 0 and r[10] >= 0]
    if not tel:
        print("ESC telemetry: not available (dshot_bidir OFF or old firmware build)")
        return None
    vb = [r[11] for r in tel if r[11] > 0]
    if vb:
        print("battery voltage: %.2f..%.2f V" % (min(vb), max(vb)))
    talking = [r for r in tel if r[10] < 5.0]
    if not talking:
        print("ESC telemetry: NO ANSWER from the ESC (invalid %.0f %%) - not powered, signal wire not connected,"
              " or ESC does not support bidirectional DShot" % min(r[10] for r in tel))
        return False
    print("ESC answers: %d of %d samples with < 5 %% invalid frames" % (len(talking), len(tel)))
    run = [r[9] for r in tel if r[0] > a.delay + a.ramp + 0.5]
    ramp = [(r[0], r[9]) for r in tel if a.delay <= r[0] <= a.delay + a.ramp]
    first_spin = next((t for t, v in ramp if v > 0), None)
    print("motor first turns at FC uptime: %s s" % first_spin)
    if run:
        mean = sum(run) / len(run)
        spread = (max(run) - min(run)) / mean * 100 if mean else 0
        print("RPM at target: mean %.0f, min %d, max %d (spread %.1f %%)" % (mean, min(run), max(run), spread))
        return mean > 0
    return first_spin is not None


def plot(a, rows, out):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    t = [r[0] for r in rows]
    fig, ax = plt.subplots(figsize=(10, 4.5), dpi=110)
    ax.plot(t, [(r[1] - 1000) / 10.0 for r in rows], color="#1f77b4", lw=2, label="command to ESC, %")
    ax.axvline(a.delay, color="#999", ls="--", lw=1)
    ax.axvline(a.delay + a.ramp, color="#999", ls="--", lw=1)
    ax.set_xlabel("time since power-on, s (FC clock)")
    ax.set_ylabel("throttle, %")
    ax.grid(alpha=0.3)
    tel = [(r[0], r[9]) for r in rows if len(r) > 9 and r[9] >= 0 and r[10] >= 0 and r[10] < 5]
    if tel:
        ax2 = ax.twinx()
        ax2.plot([x for x, _ in tel], [y for _, y in tel], color="#d62728", lw=1.5, label="motor RPM (ESC telemetry)")
        ax2.set_ylabel("RPM")
        ax2.legend(loc="lower right")
    ax.legend(loc="upper left")
    ax.set_title("Shramko Motor Autostart: delay %.0f s, ramp %.0f s, target %.0f %%" % (a.delay, a.ramp, a.throttle))
    fig.savefig(out, bbox_inches="tight", facecolor="white")
    print("plot:", out)


def battery_offset(rows):
    """Seconds between boot and the moment the battery appeared (0 if it powered the board)."""
    for r in rows:
        if len(r) > 13 and r[12] == 1 and r[13] >= 0:
            return max(0.0, r[0] - r[13]) if r[0] - r[13] > 2.5 else 0.0
    return 0.0


def precise_time(a, r):
    """FC uptime from debug[3] has 0.1 s steps; debug[2] (time in the current state, 10 ms steps) is finer.
    For a power-on program the state clock of DELAY starts at boot, of RAMP at the end of the delay, etc."""
    state, state_ms, source = r[2], r[4], r[8]
    if source == 1 and state == 1:
        return state_ms / 1000.0
    if source == 1 and state == 2:
        return a.delay + state_ms / 1000.0
    if source == 1 and state == 3:
        return a.delay + a.ramp + state_ms / 1000.0
    return r[0]


def evaluate(a, rows):
    if not rows:
        print("FAIL: no samples")
        sys.exit(1)
    off = battery_offset(rows)
    if off:
        print("battery appeared at FC uptime %.1f s - times below are counted from that moment" % off)
    rows = [(precise_time(a, r) - (off if not (r[8] == 1 and r[2] in (1, 2, 3)) else 0.0),) + tuple(r[1:]) for r in rows]
    if a.plot:
        plot(a, rows, a.plot)
    esc_ok = esc_report(a, rows)

    print("samples: %d, FC uptime %.1f..%.1f s" % (len(rows), rows[0][0], rows[-1][0]))
    seen_states = sorted({r[2] for r in rows})
    print("states seen:", [STATE_NAMES.get(x, x) for x in seen_states],
          "| usb seen:", sorted({r[5] for r in rows}), "| rx:", sorted({r[6] for r in rows}),
          "| sources:", [SOURCE_NAMES.get(x, x) for x in sorted({r[8] for r in rows})])

    if a.expect_off:
        bad = [r for r in rows if r[1] > 1000]
        print("max motor value: %d" % max(r[1] for r in rows))
        print("PASS (motor stayed at stop)" if not bad else "FAIL (motor moved: %s)" % (bad[:3],))
        sys.exit(0 if not bad else 1)

    # expected value at FC uptime t (power-on mode: program starts at boot)
    def expected(t):
        if t < a.delay:
            return 1000.0
        x = min(1.0, (t - a.delay) / a.ramp) if a.ramp > 0 else 1.0
        return 1000.0 + 10.0 * a.throttle * x

    errs = [abs(r[1] - expected(r[0])) for r in rows]
    first_move = next((r[0] for r in rows if r[1] > 1000), None)
    reach = next((r[0] for r in rows if r[1] >= 1000 + 10 * a.throttle - 1), None)
    plateau = [r[1] for r in rows if r[0] > a.delay + a.ramp + 0.5]
    print("first motor movement at FC uptime: %s s (expected %.1f)" % (None if first_move is None else round(first_move, 2), a.delay))
    print("target reached at FC uptime: %s s (expected %.1f)" % (None if reach is None else round(reach, 2), a.delay + a.ramp))
    if plateau:
        print("plateau: min %d max %d (expected %d)" % (min(plateau), max(plateau), 1000 + 10 * a.throttle))
    print("max |measured - expected|: %.1f us" % max(errs))
    # FC uptime is reported in 0.1 s steps, so on a ramp the comparison itself carries up to
    # slope x 0.1 s of quantisation error; 3 us on top covers DShot <-> microseconds rounding.
    slope_us_per_s = 10.0 * a.throttle / a.ramp if a.ramp > 0 else 0.0
    tol = 3.0 + slope_us_per_s * 0.1
    ramp_pts = [(r[0], r[1]) for r in rows if a.delay + 0.3 < r[0] < a.delay + a.ramp - 0.3]
    if len(ramp_pts) > 5:
        n = len(ramp_pts); mx = sum(t for t, _ in ramp_pts) / n; my = sum(v for _, v in ramp_pts) / n
        sxx = sum((t - mx) ** 2 for t, _ in ramp_pts); sxy = sum((t - mx) * (v - my) for t, v in ramp_pts)
        fit = sxy / sxx
        ss_res = sum((v - (my + fit * (t - mx))) ** 2 for t, v in ramp_pts); ss_tot = sum((v - my) ** 2 for _, v in ramp_pts)
        r2 = 1 - ss_res / ss_tot if ss_tot else 1.0
        print("ramp slope: %.2f us/s (expected %.2f), linearity R^2 = %.5f" % (fit, slope_us_per_s, r2))
    print("tolerance: %.1f us" % tol)
    ok = (first_move is not None and abs(first_move - a.delay) < 0.3
          and reach is not None and abs(reach - (a.delay + a.ramp)) < 0.3
          and max(errs) <= tol)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
