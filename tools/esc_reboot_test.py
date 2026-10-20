"""Does the ESC keep working when the flight controller restarts while the ESC stays powered?

Bench case: the board on USB, the ESC on the battery; every "Save" (CLI save) restarts the board, the ESC
keeps its power. Each cycle = save with a short capped program (2 s at 10 %, PROPELLER OFF) -> the
board restarts -> did the ESC answer during the run (RPM > 0 or ESC voltage > 1 V in the telemetry)?
-> mode OFF again (second restart). Run it once with dshot_bidir OFF and once ON (replug the battery in
between: BLHeli_32 picks the signal type when it powers up).

usage: python esc_reboot_test.py COM6 [--cycles 10]
"""
import argparse, sys, time

sys.path.insert(0, __file__.rsplit("\\", 1)[0] if "\\" in __file__ else __file__.rsplit("/", 1)[0])
import battery_test as bt  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--cycles", type=int, default=10)
    a = ap.parse_args()
    txt = bt.cli(a.port, ["get dshot_bidir", "exit"])
    bidir = "ON" if "dshot_bidir = ON" in txt else "OFF"
    print("dshot_bidir =", bidir, flush=True)
    ok = 0
    for i in range(a.cycles):
        bt.cli(a.port, ["set autostart_mode = POWER", "set autostart_delay = 3", "set autostart_ramp = 5", "set autostart_throttle = 10",
                        "set autostart_run_time = 2", "set autostart_pattern = STEADY", "save"], wait=1.0)
        try:
            rows = bt.watch(a.port, 9, stop_at_state=4)
        finally:
            bt.cli(a.port, ["set autostart_mode = OFF", "save"], wait=2.0)
        run = [r for r in rows if r["state"] == 3]
        rpm = max((r["esc"]["rpm"] for r in run if r["esc"]), default=0)
        volts = max((r["esc"]["volts"] for r in run if r["esc"]), default=0)
        sag = (max(r["v_fc"] for r in rows) - min(r["v_fc"] for r in run)) if run else 0
        alive = rpm > 0 or volts > 1
        ok += alive
        print("cycle %2d: %s  (run samples %d, max rpm %s, ESC %.2f V, sag %.2f V)" % (i + 1, "ESC OK " if alive else "ESC LOST", len(run), rpm, volts, sag), flush=True)
        if not alive:
            print("   the ESC stopped answering after a board restart; it needs a battery replug", flush=True)
            break
        time.sleep(2)
    print("\n%s: %d of %d restarts with the ESC still working" % ("bidir " + bidir, ok, i + 1))


if __name__ == "__main__":
    main()
