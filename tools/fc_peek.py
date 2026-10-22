"""Read-only snapshot of a running Shramko Motor Autostart board over MSP (no CLI, no reboot):
program state, commanded throttle, motor outputs, battery voltage, ESC telemetry for every output.
usage: python fc_peek.py COM6 [seconds]
The last line is the battery verdict, also as the exit code (AGENT_PORTING.md, rule 1):
  0 "no battery": every batt= below 1 V            1 "BATTERY CONNECTED": a batt= of 1 V or more
  2 "NO MSP ANSWER": nothing proven (the board is in the CLI or rebooting: replug USB with the battery out)
  3 "NOT MEASURED": battery_meter is not ADC, so the board cannot see a battery (ask the human)
escV= is the last value the ESC sent: it stays after the battery is unplugged until the board restarts,
so it is shown but never used as proof that there is no battery.
"""
import struct, sys, time
import serial

STATE = {0: "IDLE", 1: "DELAY", 2: "RAMP", 3: "RUN", 4: "DONE", 5: "LOW_BATTERY"}


def frame(cmd, payload=b""):
    c = len(payload) ^ cmd
    for b in payload:
        c ^= b
    return b"$M<" + bytes([len(payload), cmd]) + payload + bytes([c])


def msp(s, cmd, timeout=0.3):
    s.write(frame(cmd))
    t0, buf = time.time(), b""
    while time.time() - t0 < timeout:
        buf += s.read(64)
        i = buf.find(b"$M>")
        if i >= 0 and len(buf) >= i + 5:
            n = buf[i + 3]
            if len(buf) >= i + 6 + n and buf[i + 4] == cmd:
                return buf[i + 5:i + 5 + n]
    return None


def main():
    if len(sys.argv) < 2 or sys.argv[1].startswith("-"):
        print(__doc__)
        sys.exit(0 if len(sys.argv) > 1 and sys.argv[1] in ("-h", "--help") else 2)
    port = sys.argv[1]
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 5
    s = serial.Serial(port, 115200, timeout=0.05)
    v = msp(s, 3)
    b = msp(s, 5)
    print("firmware:", ".".join(str(x) for x in v[:3]) if v else None, "| build:", b[:26].decode(errors="replace") if b else None)
    bc = msp(s, 32)  # MSP_BATTERY_CONFIG: byte 5 = voltage meter source (0 NONE, 1 ADC, 2 ESC)
    meter = bc[5] if bc and len(bc) >= 6 else None
    seen = []
    t_end = time.time() + seconds
    while time.time() < t_end:
        m, d, t, bat = msp(s, 104), msp(s, 254), msp(s, 139), msp(s, 130)
        if not (m and d):
            continue
        if bat and len(bat) >= 11:
            seen.append(struct.unpack_from("<H", bat, 9)[0] / 100.0)
        motors = struct.unpack("<8H", m[:16])
        dbg = struct.unpack("<8h", d[:16])
        volts = struct.unpack_from("<H", bat, 9)[0] / 100.0 if bat and len(bat) >= 11 else None
        cells = bat[0] if bat else None
        tel = []
        if t:
            for i in range(min(t[0], 4)):
                rpm, inv, temp, ev, cur, cons = struct.unpack_from("<IHBHHH", t, 1 + 13 * i)
                tel.append("M%d rpm=%d bad=%.0f%% escV=%.2f" % (i + 1, rpm, inv / 100.0, ev / 100.0))
        print("uptime %5.1fs state=%-11s cmd=%5.1f%% motors=%s batt=%sV cells=%s flags=%d | %s"
              % (dbg[3] / 10.0, STATE.get(dbg[0], dbg[0]), dbg[1] / 10.0, motors[:4], volts, cells, dbg[4], "; ".join(tel)))
        time.sleep(1.0)
    s.close()
    code, verdict = battery_verdict(seen, meter)
    print(verdict)
    sys.exit(code)


def battery_verdict(volts, meter):
    """(exit code, last line) from the batt= readings and the voltage meter source"""
    if not volts:
        return 2, "NO MSP ANSWER: nothing proven (board in the CLI or rebooting: replug USB with the battery out, run again)"
    if max(volts) >= 1.0:
        return 1, "BATTERY CONNECTED: batt up to %.2f V" % max(volts)
    if meter is not None and meter != 1:
        return 3, "NOT MEASURED: battery_meter is not ADC, the board cannot see a battery (ask the human)"
    return 0, "no battery: every batt= below 1 V (%d samples)" % len(volts)


if __name__ == "__main__":
    main()
