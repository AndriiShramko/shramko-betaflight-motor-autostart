"""Shramko Motor Autostart - every setting on the real board, one capped run each (battery in, PROPELLER OFF).

The session starts and ends with autostart_mode = OFF; every run is saved with a run-time cap, so a dead
script still leaves a motor that stops by itself. Timing is read from the board's own clock
(debug[3] uptime, debug[2] time in state), not from this computer.

Cases: delay (incl. 0 -> the 3 s ESC wake-up), ramp 0, throttle 10/25/40 % (output and RPM order),
throttle limit (steady and gusts), run time, gust ranges (fast sampling), motor mask, USB inhibit,
battery threshold above the pack, BUTTON with no button, STOP in RAMP/RUN/gust (held) and Run again,
CLI during RUN, MSP flood during RUN (no jitter, no hang), repeated reboots, all settings persist after
save + reboot, 45 s soak.

usage: python param_matrix_test.py COM6 [--only name,name]   (names: see CASES at the bottom)
"""
import argparse, json, os, struct, sys, time

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
from autostart_selftest import msp, msp_frame, open_port  # noqa: E402
from battery_test import cli  # noqa: E402

STATE = {0: "IDLE", 1: "DELAY", 2: "RAMP", 3: "RUN", 4: "DONE", 5: "LOW_BATTERY"}
BASE = ["autostart_mode = POWER", "autostart_delay = 3", "autostart_ramp = 20", "autostart_throttle = 15",
        "autostart_throttle_limit = 100", "autostart_run_time = 8", "autostart_pattern = STEADY",
        "autostart_motors = 15", "autostart_usb_inhibit = OFF", "autostart_vbat_min = 60",
        "autostart_cell_cutoff = 330", "autostart_cutoff_time = 5", "autostart_cells = 6"]
KEYS = [x.split(" = ")[0] for x in BASE] + ["autostart_gust_min", "autostart_gust_max", "autostart_gust_len_min",
        "autostart_gust_len_max", "autostart_gust_pause_min", "autostart_gust_pause_max", "autostart_box", "vbat_scale"]


def sample(s, full=True):
    d, m = msp(s, 254), msp(s, 104)
    if not (m and d) or len(d) < 16:
        return None
    dbg = struct.unpack("<8h", d[:16])
    x = dict(t=time.time(), state=dbg[0], pct=dbg[1] / 10.0, ms_state=dbg[2] * 10, up=dbg[3] / 10.0, flags=dbg[4],
             since_bat=dbg[6] / 10.0, motors=struct.unpack("<8H", m[:16]))
    if full:
        t, b = msp(s, 139), msp(s, 130)
        x["v_fc"] = struct.unpack_from("<H", b, 9)[0] / 100.0 if b and len(b) >= 11 else 0.0
        x["rpm"] = [struct.unpack_from("<IHBHHH", t, 1 + 13 * i)[0] for i in range(min(t[0], 4))] if t else []
        x["bad"] = [struct.unpack_from("<IHBHHH", t, 1 + 13 * i)[1] / 100.0 for i in range(min(t[0], 4))] if t else []
        x["escv"] = [struct.unpack_from("<IHBHHH", t, 1 + 13 * i)[3] / 100.0 for i in range(min(t[0], 4))] if t else []
    return x


def watch(port, seconds, full=True, stop_when=None, each=None, period=0.15):
    s = open_port(port, 30)
    rows, end = [], time.time() + seconds
    while time.time() < end:
        x = sample(s, full)
        if x:
            rows.append(x)
            if each:
                each(s, x, rows)
            if stop_when and stop_when(x, rows):
                break
        time.sleep(period)
    s.close()
    return rows


DRY = False   # --dry-run: USB only, no battery; vbat gate off, the ESC is unpowered (no RPM, no ESC checks)


def configure(port, sets, wait=1.0):
    extra = ["autostart_vbat_min = 0"] if DRY and not any(x.startswith("autostart_vbat_min") for x in sets) else []
    cli(port, ["set " + x for x in BASE + sets + extra] + ["save"], wait=wait)


def off(port):
    cli(port, ["set autostart_mode = OFF", "save"], wait=2.0)


def edge_time(rows, state):
    """When `state` started, on the board's clock (s since boot), from the first sample in it."""
    for r in rows:
        if r["state"] == state:
            return round(r["up"] - r["ms_state"] / 1000.0, 2)
    return None


def states(rows):
    seq = []
    for r in rows:
        if not seq or seq[-1] != STATE[r["state"]]:
            seq.append(STATE[r["state"]])
    return seq


RESULTS = []


def check(ok, what):
    RESULTS.append((bool(ok), what))
    print(("   PASS " if ok else "   FAIL ") + what, flush=True)
    return ok


def run(port, name, sets, seconds, **kw):
    print("\n" + name + ": " + ", ".join(sets), flush=True)
    configure(port, sets)
    # no "mode OFF" restart after each run: every run is capped (run time) and stops by itself, and each
    # board restart makes the ESC beep; the session switches the mode OFF once at the end (or on a failure)
    rows = watch(port, seconds, **kw)
    print("   states:", " > ".join(states(rows)), "| samples", len(rows), flush=True)
    vs = [r["v_fc"] for r in rows if r.get("v_fc")]
    if vs:
        print("   battery on the board: %.2f .. %.2f V (min %.2f V per cell on 6S)" % (min(vs), max(vs), min(vs) / 6), flush=True)
    spin = [r for r in rows if r.get("bad") and r["motors"][0] > 1050 and r["ms_state"] > 500]
    if spin and not DRY:
        # alive = RPM or the ESC's own voltage in the telemetry (TX wire), or good bidirectional DShot frames
        answering = [r for r in spin if (r["rpm"] and r["rpm"][0] > 0) or (r["escv"] and r["escv"][0] > 1) or (BIDIR and r["bad"][0] < 50)]
        print("   ESC answers in %d/%d spinning samples, rpm %s" % (len(answering), len(spin), sorted({r["rpm"][0] for r in spin})[-3:]), flush=True)
        # telemetry over the TX wire is sparse (round-robin requests): one answer in the run is enough;
        # a locked ESC gives none at all
        if not answering and len(spin) >= 4:
            check(False, name + ": ESC NOT ANSWERING while the output is above stop (power? connector?) - stopping the matrix")
            raise EscLost(name)
    return rows


class EscLost(Exception):
    pass


# ---------------- cases ----------------

def c_delay(p):
    for delay, ramp in ((3, 30), (6, 20), (0, 20)):
        rows = run(p, "delay %d s, ramp %.1f s" % (delay, ramp / 10), ["autostart_delay = %d" % delay, "autostart_ramp = %d" % ramp,
                   "autostart_run_time = 3"], max(delay, 3) + ramp / 10 + 7, stop_when=lambda x, r: x["state"] == 4)
        rs, ru, dn = edge_time(rows, 2), edge_time(rows, 3), edge_time(rows, 4)
        want = max(delay, 3.0)
        print("   ramp starts %s s (want %.1f), run %s s (want %.1f), done %s s (want %.1f)" % (rs, want, ru, want + ramp / 10, dn, want + ramp / 10 + 3))
        check(rs is not None and abs(rs - want) <= 0.25, "delay %d: ramp starts at %.1f s +-0.25 (board clock)" % (delay, want))
        check(ru is not None and abs(ru - rs - ramp / 10) <= 0.25, "ramp %.1f s long +-0.25" % (ramp / 10))
        check(dn is not None and abs(dn - ru - 3) <= 0.25, "run time 3 s +-0.25")


def c_ramp0(p):
    rows = run(p, "ramp 0 (jump)", ["autostart_ramp = 0", "autostart_run_time = 3"], 10, stop_when=lambda x, r: x["state"] == 4)
    seq = states(rows)
    check("RUN" in seq and edge_time(rows, 3) is not None and abs(edge_time(rows, 3) - 3.0) <= 0.25, "ramp 0: RUN at 3.0 s (straight to the throttle)")
    check(all(r["motors"][0] in (1000, 1150) for r in rows), "ramp 0: output only 1000 or 1150")


def c_throttle(p):
    rpm_at = {}
    for thr in (10, 25, 40):
        rows = run(p, "throttle %d %%" % thr, ["autostart_throttle = %d" % thr, "autostart_run_time = 5"], 14, stop_when=lambda x, r: x["state"] == 4)
        steady = [r for r in rows if r["state"] == 3 and 1500 < r["ms_state"] < 5000 - 300]   # run time 5 s
        outs = sorted({r["motors"][0] for r in steady})
        for r in steady:
            if r["motors"][0] != 1000 + 10 * thr:
                print("   off-value sample: state %s, %d ms in state, outputs %s, uptime %.1f s" % (STATE[r["state"]], r["ms_state"], r["motors"][:4], r["up"]))
        rpm = sorted(r["rpm"][0] for r in steady if r.get("rpm"))
        rpm_at[thr] = rpm[len(rpm) // 2] if rpm else 0
        print("   output %s, median rpm %s" % (outs, rpm_at[thr]))
        check(outs == [1000 + 10 * thr], "throttle %d %%: output %d us exactly" % (thr, 1000 + 10 * thr))
    if not DRY:
        check(0 < rpm_at[10] < rpm_at[25] < rpm_at[40], "RPM rises with throttle: %s" % rpm_at)


def c_limit(p):
    rows = run(p, "limit 20 below throttle 30", ["autostart_throttle = 30", "autostart_throttle_limit = 20", "autostart_run_time = 5"], 14,
               stop_when=lambda x, r: x["state"] == 4)
    outs = {r["motors"][0] for r in rows if r["state"] == 3 and 300 < r["ms_state"] < 5000 - 300}
    check(outs == {1200}, "limit 20 %%: steady output 1200 (got %s)" % sorted(outs))
    rows = run(p, "gusts capped by limit 25", ["autostart_pattern = GUSTS", "autostart_throttle = 15", "autostart_throttle_limit = 25",
               "autostart_gust_min = 60", "autostart_gust_max = 90", "autostart_gust_len_min = 300", "autostart_gust_len_max = 500",
               "autostart_gust_pause_min = 5", "autostart_gust_pause_max = 10", "autostart_run_time = 10"], 18, full=False, period=0.02,
               stop_when=lambda x, r: x["state"] == 4)
    peak = max(r["motors"][0] for r in rows)
    check(peak <= 1250 and any(r["flags"] & 16 for r in rows), "gusts with limit 25 %%: peak %d <= 1250, gusts seen" % peak)


def c_gusts(p):
    rows = run(p, "gust ranges", ["autostart_pattern = GUSTS", "autostart_throttle = 15", "autostart_gust_min = 40", "autostart_gust_max = 60",
               "autostart_gust_len_min = 300", "autostart_gust_len_max = 500", "autostart_gust_pause_min = 5", "autostart_gust_pause_max = 10",
               "autostart_run_time = 12"], 20, full=False, period=0.0, stop_when=lambda x, r: x["state"] == 4)
    run_rows = [r for r in rows if r["state"] == 3]
    dt = (run_rows[-1]["t"] - run_rows[0]["t"]) / max(1, len(run_rows) - 1) if len(run_rows) > 1 else 0
    spans, start, peak, last_end = [], None, 0, None
    lens, pauses, peaks = [], [], []
    for r in run_rows:
        g = bool(r["flags"] & 16)
        if g and start is None:
            start, peak = r["t"], r["motors"][0]
            if last_end is not None:
                pauses.append(round(start - last_end, 2))
        elif g:
            peak = max(peak, r["motors"][0])
        elif start is not None:
            lens.append(round(r["t"] - start, 2))
            peaks.append(peak)
            last_end, start = r["t"], None
    lens, peaks = lens[1:], peaks      # the first gust may have started before the sampling did
    print("   sample period %.3f s; %d gust lengths %s; pauses %s; peaks %s" % (dt, len(lens), lens, pauses, peaks))
    tol = 2 * dt + 0.03
    check(len(peaks) >= 6, "gusts: at least 6 in ~12 s with 0.5-1.0 s pauses (%d)" % len(peaks))
    check(peaks and all(1395 <= x <= 1605 for x in peaks), "gust peaks within 40-60 %% (1400-1600 us)")
    check(lens and all(0.3 - tol <= x <= 0.5 + tol for x in lens), "gust lengths within 0.3-0.5 s (+- %.2f)" % tol)
    check(pauses and all(0.5 - tol <= x <= 1.0 + tol for x in pauses), "pauses within 0.5-1.0 s (+- %.2f)" % tol)
    # a sample reads the state and the outputs with two requests (debug first, motors ~1 ms later): skip
    # samples next to a phase/gust edge; the steady checks above skip 300 ms at both ends of RUN for the same reason
    base = {r["motors"][0] for i, r in enumerate(run_rows) if not r["flags"] & 16 and r["ms_state"] > 300
            and 0 < i < len(run_rows) - 1 and not run_rows[i - 1]["flags"] & 16 and not run_rows[i + 1]["flags"] & 16}
    check(base == {1150}, "between gusts exactly the base 1150 (seen %s)" % sorted(base)[:6])


def c_mask(p):
    rows = run(p, "motor mask = motor 2 only", ["autostart_motors = 2", "autostart_run_time = 4"], 12, stop_when=lambda x, r: x["state"] == 4)
    runr = [r for r in rows if r["state"] == 3 and 300 < r["ms_state"] < 4000 - 300]
    print("   motor 1 values %s, motor 2 values %s" % (sorted({r["motors"][0] for r in runr}), sorted({r["motors"][1] for r in runr})))
    check(runr and all(r["motors"][0] == 1000 for r in runr), "mask 2: motor 1 stays at 1000")
    check(runr and all(r["motors"][1] == 1150 for r in runr), "mask 2: motor 2 gets 1150")
    check(all((r.get("rpm") or [0])[0] == 0 for r in runr[3:]), "mask 2: motor 1 does not turn (RPM 0)")


def c_inhibit(p):
    rows = run(p, "USB inhibit ON with USB connected", ["autostart_usb_inhibit = ON"], 10)
    check(all(r["motors"][0] == 1000 for r in rows) and all(r["state"] in (0,) for r in rows[3:]), "USB inhibit: nothing starts")


def c_vbatmin(p):
    if DRY:
        print("\nbattery threshold: skipped without a battery", flush=True)
        return
    rows = run(p, "battery threshold 30.0 V above the pack", ["autostart_vbat_min = 300"], 10)
    check(all(r["motors"][0] == 1000 for r in rows) and not any(r["flags"] & 8 for r in rows[3:]), "vbat_min 30 V: no battery seen, nothing starts")


def c_button(p):
    rows = run(p, "BUTTON mode, no button wired", ["autostart_mode = BUTTON"], 10)
    check(all(r["motors"][0] == 1000 for r in rows), "BUTTON with no click: nothing starts")


def _stop_in(p, label, sets, when):
    sent = []

    def each(s, x, rows):
        if not sent and when(x):
            s.write(msp_frame(214, struct.pack("<8H", *[1000] * 8)))
            sent.append(x["t"])
    rows = run(p, "STOP during " + label, sets, 16, each=each, full=False, period=0.05)
    after = [r for r in rows if sent and r["t"] > sent[0] + 0.2]
    check(bool(sent), "STOP sent during " + label)
    check(after and all(r["motors"][0] == 1000 for r in after) and all(r["flags"] & 64 for r in after),
          "after STOP in %s: output 1000 and held for the rest of the run" % label)


def c_stop(p):
    _stop_in(p, "RAMP", ["autostart_ramp = 40", "autostart_run_time = 8"], lambda x: x["state"] == 2 and x["ms_state"] > 1000)
    _stop_in(p, "RUN", ["autostart_run_time = 10"], lambda x: x["state"] == 3 and x["ms_state"] > 1000)
    _stop_in(p, "a gust", ["autostart_pattern = GUSTS", "autostart_gust_pause_min = 5", "autostart_gust_pause_max = 10",
             "autostart_run_time = 10"], lambda x: x["state"] == 3 and x["flags"] & 16)
    # Run again = reboot: the program must start from the beginning (negative control for the hold)
    print("\nrestart after a hold (MSP_REBOOT)", flush=True)
    configure(p, ["autostart_run_time = 4"])
    try:
        s = open_port(p, 30)
        time.sleep(1.0)
        s.write(msp_frame(214, struct.pack("<8H", *[1000] * 8)))   # hold it in the countdown
        time.sleep(0.5)
        held = sample(s, False)
        s.write(msp_frame(68))                                     # MSP_REBOOT
        s.close()
        time.sleep(1.5)
        rows = watch(p, 12, full=False, stop_when=lambda x, r: x["state"] == 4)
    finally:
        pass   # capped run; the session turns the mode OFF at the end
    check(held and held["flags"] & 64, "held before the restart")
    check("RUN" in states(rows), "after the restart the program runs again (%s)" % " > ".join(states(rows)))


def c_cli(p):
    print("\nCLI during RUN", flush=True)
    configure(p, ["autostart_run_time = 12"])
    try:
        rows = watch(p, 7, full=False, stop_when=lambda x, r: x["state"] == 3 and x["ms_state"] > 1500)
        s = open_port(p, 10)
        s.write(b"#")
        time.sleep(1.0)
        s.read(2000)
        s.write(b"\r\nexit noreboot\r\n")
        time.sleep(1.0)
        s.close()
        after = watch(p, 6, full=False)
    finally:
        pass   # capped run; the session turns the mode OFF at the end
    check(rows and rows[-1]["state"] == 3, "running before the CLI")
    check(after and all(r["motors"][0] == 1000 for r in after) and all(r["flags"] & 64 for r in after), "after CLI + exit noreboot: stopped and held")


def c_flood(p):
    print("\nMSP flood during RUN (no jitter, no hang)", flush=True)
    configure(p, ["autostart_run_time = 14"])
    try:
        watch(p, 8, full=False, stop_when=lambda x, r: x["state"] == 3 and x["ms_state"] > 1000)
        s = open_port(p, 10)
        n, outs, t_end, lat = 0, set(), time.time() + 8, []
        while time.time() < t_end:
            t0 = time.time()
            for cmd in (101, 104, 105, 108, 110, 130, 139, 254):    # status, motor, rc, attitude, analog-ish, battery, telemetry, debug
                r = msp(s, cmd, timeout=0.2)
                n += 1
                if cmd == 104 and r:
                    outs.add(struct.unpack("<H", r[:2])[0])
            lat.append(time.time() - t0)
        st = msp(s, 101)
        s.close()
        cycle = struct.unpack_from("<H", st, 0)[0] if st else None
    finally:
        pass   # capped run; the session turns the mode OFF at the end
    print("   %d requests, %.0f req/s, output values %s, cycle time %s us, worst round %.0f ms" % (n, n / 8, sorted(outs), cycle, max(lat) * 1000))
    check(outs == {1150}, "output steady at 1150 under the flood")
    check(max(lat) < 0.5, "board kept answering (worst round %.0f ms)" % (max(lat) * 1000))


def c_reboots(p):
    print("\n5 reboots in a row", flush=True)
    off(p)   # program off, so no restart below turns the motor (same conditions as before)
    ok = 0
    for i in range(5):
        try:
            s = open_port(p, 20)
            s.write(msp_frame(68))
            s.close()
            time.sleep(1.5)
            s = open_port(p, 20)
            time.sleep(0.3)
            r = msp(s, 1, timeout=1.0)
            s.close()
            ok += 1 if r else 0
        except SystemExit:
            pass
    check(ok == 5, "board came back after %d/5 reboots" % ok)


def c_persist(p):
    print("\nall settings survive save + reboot", flush=True)
    want = {"autostart_mode": "OFF", "autostart_delay": "17", "autostart_ramp": "45", "autostart_throttle": "23",
            "autostart_throttle_limit": "77", "autostart_run_time": "321", "autostart_pattern": "GUSTS", "autostart_motors": "5",
            "autostart_usb_inhibit": "ON", "autostart_vbat_min": "71", "autostart_cell_cutoff": "345", "autostart_cutoff_time": "7",
            "autostart_cells": "5", "autostart_gust_min": "41", "autostart_gust_max": "83", "autostart_gust_len_min": "210",
            "autostart_gust_len_max": "640", "autostart_gust_pause_min": "13", "autostart_gust_pause_max": "57", "autostart_box": "254"}
    before = cli(p, ["get " + k for k in want] + ["exit"])
    keep = {l.split(" = ")[0].strip(): l.split(" = ")[1].strip() for l in before.splitlines() if " = " in l}
    cli(p, ["set %s = %s" % kv for kv in want.items()] + ["save"], wait=4)
    got_txt = cli(p, ["get " + k for k in want] + ["exit"])
    got = {l.split(" = ")[0].strip(): l.split(" = ")[1].strip() for l in got_txt.splitlines() if " = " in l}
    bad = {k: (v, got.get(k)) for k, v in want.items() if got.get(k) != v}
    check(not bad, "20 settings read back after save + reboot (wrong: %s)" % bad)
    cli(p, ["set %s = %s" % kv for kv in keep.items() if kv[0] in want] + ["set autostart_mode = OFF", "save"], wait=4)


def c_soak(p):
    rows = run(p, "45 s soak at 15 %", ["autostart_run_time = 45", "autostart_ramp = 20"], 55, stop_when=lambda x, r: x["state"] == 4)
    runr = [r for r in rows if r["state"] == 3 and 300 < r["ms_state"] < 45000 - 300]
    outs = {r["motors"][0] for r in runr}
    rpm = [r["rpm"][0] for r in runr if r.get("rpm") and r["ms_state"] > 2000]
    print("   output %s, rpm min %s max %s" % (sorted(outs), min(rpm) if rpm else None, max(rpm) if rpm else None))
    check(outs == {1150}, "soak: output steady at 1150 for 45 s")
    if not DRY:
        check(rpm and max(rpm) - min(rpm) < 0.05 * max(rpm), "soak: RPM within 5 %")
    check(edge_time(rows, 4) is not None and abs(edge_time(rows, 4) - edge_time(rows, 3) - 45) <= 0.3, "soak: DONE after 45.0 s +-0.3")


CASES = {"delay": c_delay, "ramp0": c_ramp0, "throttle": c_throttle, "limit": c_limit, "gusts": c_gusts, "mask": c_mask,
         "inhibit": c_inhibit, "vbatmin": c_vbatmin, "button": c_button, "stop": c_stop, "cli": c_cli, "flood": c_flood,
         "reboots": c_reboots, "persist": c_persist, "soak": c_soak}


BIDIR = True


def esc_idle_check(port, after):
    """The ESC must still answer (bidirectional DShot frames) at rest after each case. Without bidir the
    ESC's serial telemetry is not sent at rest after a board restart, so the next spinning case checks it."""
    if not BIDIR:
        return
    time.sleep(2.0)
    rows = watch(port, 3.0)
    bad = [r["bad"][0] for r in rows if r.get("bad")]
    v = [r["v_fc"] for r in rows if r.get("v_fc")]
    ok = bool(bad) and min(bad) < 50
    print("   ESC at rest after %s: %s (bad frames %s %%, battery %.2f V)" % (after, "answers" if ok else "SILENT",
          min(bad) if bad else "-", sum(v) / len(v) if v else 0), flush=True)
    if not ok:
        check(False, "ESC went silent after the case '%s' (needs a battery replug)" % after)
        raise EscLost(after)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--only", default=",".join(CASES))
    ap.add_argument("--dry-run", action="store_true", help="USB only, no battery: vbat gate off, no RPM/ESC checks")
    ap.add_argument("--gust-max", type=int, default=60, help="strongest gust in the gust cases (%%); a weak pack sags hard")
    a = ap.parse_args()
    global BIDIR, DRY
    DRY = a.dry_run
    keep_file = __file__.rsplit(".", 1)[0] + ".keep.json"     # survives an interrupted run
    keep_txt = cli(a.port, ["get " + k for k in KEYS] + ["get dshot_bidir", "exit"])
    BIDIR = "dshot_bidir = ON" in keep_txt
    print("dshot_bidir:", "ON" if BIDIR else "OFF (ESC alive = RPM or ESC voltage over the TX wire)", flush=True)
    keep = {l.split(" = ")[0].strip(): l.split(" = ")[1].strip() for l in keep_txt.splitlines()
            if " = " in l and l.split(" = ")[0].strip() in KEYS}
    if os.path.exists(keep_file):
        keep = json.load(open(keep_file))
        print("an earlier run was interrupted: restoring its saved settings at the end:", keep, flush=True)
    else:
        json.dump(keep, open(keep_file, "w"))
    print("board now:", keep, flush=True)
    try:
        for name in a.only.split(","):
            try:
                CASES[name](a.port)
                esc_idle_check(a.port, name)
            except EscLost:
                off(a.port)
                break
            except Exception as e:  # one broken case must not leave the board running or stop the others
                check(False, "%s crashed: %r" % (name, e))
                off(a.port)
    finally:
        cli(a.port, ["set %s = %s" % kv for kv in keep.items()] + ["set autostart_mode = OFF", "save"], wait=4)
        print("\nrestored the board's settings, autostart_mode = OFF", flush=True)
        try:
            os.remove(keep_file)
        except OSError:
            pass
    fails = [w for ok, w in RESULTS if not ok]
    print("\n%d checks, %d failed" % (len(RESULTS), len(fails)))
    for w in fails:
        print("FAIL " + w)
    print("ALL PASS" if not fails else "NOT ALL PASS")


if __name__ == "__main__":
    main()
