"""Shramko Motor Autostart - receiver arbitration test without a receiver.

The computer plays the receiver: Betaflight's MSP receiver (FEATURE_RX_MSP) takes RC channels from
MSP_SET_RAW_RC over USB. Three phases after one reboot:
  1. link present, AUX2 low      -> autostart must not drive the motor (stock Betaflight owns it)
  2. AUX2 high (autostart_box)   -> the same program runs: delay, ramp, hold at the target
  3. link lost (frames stop)     -> program stops, motor at stop, no restart
The board is reconfigured for the test (receiver = MSP, aux range for BOXUSER3, autostart_box = 42)
and restored afterwards, also on failure.

usage: python rx_arbitration_test.py COM6
Needs autostart_usb_inhibit = OFF; without a battery autostart_vbat_min = 0.
"""
import struct, sys, time
import serial

MSP_FEATURE_CONFIG, MSP_SET_FEATURE_CONFIG = 36, 37
MSP_REBOOT, MSP_MOTOR, MSP_SET_RAW_RC, MSP_EEPROM_WRITE, MSP_DEBUG = 68, 104, 200, 250, 254
FEATURE_RX_SERIAL, FEATURE_RX_MSP = 1 << 3, 1 << 14
BOX_USER3 = 42


def frame(cmd, payload=b""):
    c = len(payload) ^ cmd
    for b in payload:
        c ^= b
    return b"$M<" + bytes([len(payload), cmd]) + payload + bytes([c])


def msp(s, cmd, payload=b"", timeout=0.3):
    s.write(frame(cmd, payload))
    t0, buf = time.time(), b""
    while time.time() - t0 < timeout:
        buf += s.read(64)
        i = buf.find(b"$M>")
        if i >= 0 and len(buf) >= i + 5:
            n = buf[i + 3]
            if len(buf) >= i + 6 + n and buf[i + 4] == cmd:
                return buf[i + 5:i + 5 + n]
    return None


def open_port(port, wait_s=20):
    t_end = time.time() + wait_s
    while time.time() < t_end:
        try:
            return serial.Serial(port, 115200, timeout=0.02)
        except serial.SerialException:
            time.sleep(0.1)
    raise SystemExit("port did not come back")


def reboot(s, port):
    s.write(frame(MSP_REBOOT, b"\x00"))
    time.sleep(0.3)
    s.close()
    time.sleep(1.0)
    return open_port(port)


def cli(port, lines):
    s = open_port(port)
    time.sleep(0.3)
    for _ in range(10):
        s.reset_input_buffer()
        s.write(b"#")
        time.sleep(1.0)
        if s.read(2000).rstrip().endswith(b"#"):
            break
    s.write(b"\r\n")
    for line in lines:
        s.write(line.encode() + b"\r\n")
        time.sleep(0.4)
    out = s.read(8000).decode(errors="replace")
    s.write(b"save\r\n")          # reboots
    time.sleep(0.5)
    try:
        s.close()
    except Exception:
        pass
    time.sleep(1.0)
    return out


def set_features(port, mask):
    s = open_port(port)
    msp(s, MSP_SET_FEATURE_CONFIG, struct.pack("<I", mask))
    msp(s, MSP_EEPROM_WRITE)
    time.sleep(0.5)
    s = reboot(s, port)
    s.close()
    time.sleep(1.0)


def rc(aux2):
    ch = [1500, 1500, 1000, 1500, 1000, aux2, 1000, 1000]
    return struct.pack("<8H", *ch)


def step(s, aux2):
    if aux2 is not None:
        msp(s, MSP_SET_RAW_RC, rc(aux2), timeout=0.05)
    m, d = msp(s, MSP_MOTOR), msp(s, MSP_DEBUG)
    if not m or not d or len(d) < 16:
        return None
    return struct.unpack("<H", m[:2])[0], struct.unpack("<8h", d[:16])


def run_phase(s, seconds, aux2, period=0.04):
    seen, t_end = [], time.time() + seconds
    while time.time() < t_end:
        x = step(s, aux2)
        if x:
            seen.append((time.time(), x[0], x[1][0], (x[1][4] >> 1) & 1, x[1][7]))
        time.sleep(period)
    return seen


def main(port):
    s = open_port(port)
    feats = struct.unpack("<I", msp(s, MSP_FEATURE_CONFIG))[0]
    s.close()
    print("features before: 0x%08x" % feats)
    ok = False
    try:
        cli(port, ["aux 19 %d 1 1700 2100 0 0" % BOX_USER3, "set autostart_box = %d" % BOX_USER3])
        set_features(port, (feats & ~FEATURE_RX_SERIAL) | FEATURE_RX_MSP)
        s = open_port(port)
        s = reboot(s, port)

        p1 = run_phase(s, 20, 1000)
        rx_ok = any(r[3] for r in p1)
        top1 = max(r[1] for r in p1)
        print("phase 1 (link, AUX2 low, 20 s): RX link seen %s, max motor %d, states %s"
              % (rx_ok, top1, sorted({r[2] for r in p1})))

        p2 = run_phase(s, 24, 2000)
        run2 = [r for r in p2 if r[2] == 3]
        print("phase 2 (AUX2 high, 24 s): states %s, sources %s, motor at end %d"
              % (sorted({r[2] for r in p2}), sorted({r[4] for r in p2}), p2[-1][1]))
        t_run = (run2[0][0] - p2[0][0]) if run2 else None

        p3 = run_phase(s, 12, None)
        print("phase 3 (frames stopped, 12 s): states %s, max motor after 1 s %d"
              % (sorted({r[2] for r in p3}), max(r[1] for r in p3 if r[0] - p3[0][0] > 1.0)))
        s.close()

        ok1 = rx_ok and top1 <= 1000
        ok2 = bool(run2) and p2[-1][1] == 1150 and 3 in {r[4] for r in p2} and t_run is not None and 19.0 < t_run < 22.5
        ok3 = max(r[1] for r in p3 if r[0] - p3[0][0] > 1.0) <= 1000 and p3[-1][2] == 0
        print("phase 1:", "PASS" if ok1 else "FAIL", "| phase 2:", "PASS" if ok2 else "FAIL",
              "(RUN after %.1f s)" % t_run if t_run else "", "| phase 3:", "PASS" if ok3 else "FAIL")
        ok = ok1 and ok2 and ok3
    finally:
        set_features(port, feats)
        cli(port, ["aux 19 0 0 900 900 0 0", "set autostart_box = 255"])
        s = open_port(port)
        restored = struct.unpack("<I", msp(s, MSP_FEATURE_CONFIG))[0]
        s.close()
        print("features restored: 0x%08x (%s)" % (restored, "same" if restored == feats else "DIFFERENT"))
    print("RESULT:", "PASS" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    sys.exit(0 if main(sys.argv[1]) else 1)
