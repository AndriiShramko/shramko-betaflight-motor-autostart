"""Flash a Betaflight .hex over USB DFU without the Configurator (Windows, STM32CubeProgrammer CLI).
usage: python flash_dfu.py COM6 firmware.hex
Enters the Betaflight CLI, sends `bl` (reboot to the STM32 ROM bootloader), waits for the DFU device,
writes + verifies the hex and starts it. The flight controller's settings are kept (only the firmware
area is erased).
"""
import os, subprocess, sys, time
import serial

PROG = r"C:\Program Files\STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin\STM32_Programmer_CLI.exe"


def enter_bootloader(port):
    s = serial.Serial(port, 115200, timeout=0.3)
    time.sleep(0.3)
    for _ in range(10):
        s.reset_input_buffer()
        s.write(b"#")
        time.sleep(1.0)
        if s.read(1000).rstrip().endswith(b"#"):
            break
        s.write(b"\r\n")
        time.sleep(0.5)
        if s.read(1000).rstrip().endswith(b"#"):
            break
    else:
        raise SystemExit("could not enter the CLI on " + port)
    s.write(b"\r\n")  # a "#" typed while the CLI was already open would turn "bl" into a comment
    time.sleep(0.3)
    s.write(b"bl\r\n")
    time.sleep(0.5)
    try:
        s.close()
    except Exception:
        pass


def dfu_present():
    r = subprocess.run([PROG, "-l", "usb"], capture_output=True, text=True)
    return "Device Index" in r.stdout


def main():
    port, hexfile = sys.argv[1], os.path.abspath(sys.argv[2])
    if not dfu_present():
        enter_bootloader(port)
        for _ in range(30):
            time.sleep(0.5)
            if dfu_present():
                break
        else:
            raise SystemExit("DFU device did not appear")
    r = subprocess.run([PROG, "-c", "port=USB1", "-w", hexfile, "-v", "-g", "0x08000000"], capture_output=True, text=True)
    ok = "Download verified successfully" in r.stdout
    print("flash:", "VERIFIED" if ok else "FAILED")
    if not ok:
        print(r.stdout[-2000:])
        sys.exit(1)


if __name__ == "__main__":
    main()
