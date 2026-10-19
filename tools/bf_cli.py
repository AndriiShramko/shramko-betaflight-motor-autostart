"""Run Betaflight CLI commands over USB VCP and print the output.
usage: python bf_cli.py COM6 "cmd1" "cmd2" ...   (a final 'exit' reboots the FC)
Waits for the port to appear (after a reboot) and retries CLI entry until the prompt shows.
"""
import serial, sys, time

port = sys.argv[1]
cmds = sys.argv[2:]

def open_port(deadline_s=20):
    t0 = time.time()
    while True:
        try:
            return serial.Serial(port, 115200, timeout=0.2)
        except serial.SerialException:
            if time.time() - t0 > deadline_s:
                raise
            time.sleep(0.5)

s = open_port()
time.sleep(0.5)
for attempt in range(10):
    s.reset_input_buffer()
    s.write(b"#")
    time.sleep(1.0)
    got = s.read(4096)
    if b"CLI" in got or got.rstrip().endswith(b"#"):
        break
    s.write(b"\r\n")
    time.sleep(0.5)
    got = s.read(4096)
    if got.rstrip().endswith(b"#"):
        break
else:
    print("!!! could not enter CLI")
    sys.exit(2)

def run(cmd, quiet_s=1.0, hard_s=30):
    s.write(cmd.encode() + b"\r\n")
    out = b""
    t_last = time.time()
    t0 = time.time()
    while True:
        chunk = s.read(4096)
        if chunk:
            out += chunk
            t_last = time.time()
        if out.rstrip().endswith(b"#") and time.time() - t_last > 0.3:
            break
        if time.time() - t_last > quiet_s or time.time() - t0 > hard_s:
            break
    return out.decode(errors="replace")

for c in cmds:
    if c == "exit":
        s.write(b"exit\r\n")
        time.sleep(0.3)
        print("### exit sent (FC reboots)")
        break
    print("### " + c)
    try:
        print(run(c))
    except serial.SerialException:
        # `save` and `defaults` reboot the board, the USB port disappears mid-read
        print("(port closed - board rebooting)")
        break
s.close()
