"""Shramko Motor Autostart - hardware negative controls for the red-team findings.

Each case reboots the board, waits until the program is running (state RUN), interferes, and checks
what Betaflight really sends to motor 1 afterwards (MSP_MOTOR) and the program state (MSP_DEBUG):

  cli_set     CLI "set autostart_throttle = 80" + "exit noreboot" while running
              -> the motor must STOP (no jump to 80 %), state IDLE, no restart within 15 s
  motors_tab  MSP_SET_MOTOR motor 1 = 1300 (what the Configurator Motors tab sends) while running
              -> the program must yield: motor 1 stays 1300 (not overwritten, not reset), state IDLE

usage: python interference_test.py COM6 [cli_set] [motors_tab]
Needs a board where the program runs over USB (autostart_usb_inhibit = OFF, and without a battery
autostart_vbat_min = 0). Settings changed by "cli_set" are not saved (exit noreboot), the next
reboot restores them.
"""
import struct, sys, time
import serial

MSP_REBOOT, MSP_MOTOR, MSP_SET_MOTOR, MSP_DEBUG = 68, 104, 214, 254


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


def open_port(port, wait_s=15):
    t_end = time.time() + wait_s
    while time.time() < t_end:
        try:
            return serial.Serial(port, 115200, timeout=0.02)
        except serial.SerialException:
            time.sleep(0.1)
    raise SystemExit("port did not come back")


def sample(s):
    m, d = msp(s, MSP_MOTOR), msp(s, MSP_DEBUG)
    if not m or not d or len(d) < 16:
        return None
    return struct.unpack("<H", m[:2])[0], struct.unpack("<8h", d[:16])


def reboot_and_wait_run(port):
    s = open_port(port)
    s.write(frame(MSP_REBOOT, b"\x00"))
    time.sleep(0.3)
    s.close()
    time.sleep(1.0)
    s = open_port(port)
    t_end = time.time() + 40
    while time.time() < t_end:
        x = sample(s)
        if x and x[1][0] == 3:
            return s, x
        time.sleep(0.1)
    raise SystemExit("program never reached RUN - check autostart_usb_inhibit / autostart_vbat_min")


def watch(s, seconds):
    out, t_end = [], time.time() + seconds
    while time.time() < t_end:
        x = sample(s)
        if x:
            out.append(x)
        time.sleep(0.05)
    return out


def case_cli_set(port):
    s, before = reboot_and_wait_run(port)
    print("running: motor 1 = %d, state RUN" % before[0])
    s.write(b"#")
    time.sleep(1.0)
    s.read(4000)
    s.write(b"\r\nset autostart_throttle = 80\r\n")
    time.sleep(0.5)
    s.write(b"exit noreboot\r\n")
    time.sleep(0.5)
    s.read(4000)
    seen = watch(s, 15)
    s.close()
    top = max(v for v, _ in seen) if seen else -1
    states = sorted({d[0] for _, d in seen})
    print("after 'set autostart_throttle = 80': max motor 1 = %d over %d samples, states %s" % (top, len(seen), states))
    ok = bool(seen) and top <= 1000 and states == [0]
    print("cli_set:", "PASS (motor stopped, no jump, no restart)" if ok else "FAIL")
    return ok


def case_motors_tab(port):
    s, before = reboot_and_wait_run(port)
    print("running: motor 1 = %d, state RUN" % before[0])
    msp(s, MSP_SET_MOTOR, struct.pack("<8H", 1300, 1000, 1000, 1000, 1000, 1000, 1000, 1000))
    seen = watch(s, 5)
    vals = sorted({v for v, _ in seen})
    states = sorted({d[0] for _, d in seen})
    msp(s, MSP_SET_MOTOR, struct.pack("<8H", *([1000] * 8)))     # put the slider back
    time.sleep(0.3)
    after = sample(s)
    s.close()
    print("after MSP_SET_MOTOR 1300: motor 1 values %s, states %s; slider back -> %s" % (vals, states, after and after[0]))
    ok = vals == [1300] and states == [0] and after and after[0] == 1000
    print("motors_tab:", "PASS (program yielded to the Motors tab)" if ok else "FAIL")
    return ok


if __name__ == "__main__":
    port = sys.argv[1]
    cases = sys.argv[2:] or ["cli_set", "motors_tab"]
    results = [{"cli_set": case_cli_set, "motors_tab": case_motors_tab}[c](port) for c in cases]
    sys.exit(0 if all(results) else 1)
