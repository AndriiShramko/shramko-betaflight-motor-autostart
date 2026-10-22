"""Prepare a board config for Shramko Motor Autostart, with the reference setup's defaults.

Takes the board's config.h from betaflight/config (branch 2025.12-config: the flat configs/<BOARD>/ layout
Betaflight 2025.12.1 builds with) or a local file, comments out the lines the project block sets itself,
appends the block, and writes:
  configs/<BOARD>/config.h        build it with build/build.sh <BOARD>
  configs/<BOARD>/after-flash.txt the CLI lines to send after the first boot, and the exact check command

usage: python tools/make_board_config.py BOARD --cells N --motors MASK --esc-telemetry UARTn|none
                                         [--usb-inhibit ON|OFF] [--from FILE_OR_DIR] [--force] [--print]
  BOARD            the config folder name in betaflight/config (usually the board_name; a few differ)
  --cells N        series cells of YOUR battery (reference 6)
  --motors MASK    outputs whose motor should spin: 1 = output 1, 15 = outputs 1-4 (reference 15)
  --esc-telemetry  the UART whose RX pad gets the ESC's TX wire (pad R4/RX4 = UART4), or none
  --usb-inhibit    ON: never spin while a computer is connected (reference OFF; forced ON without a voltage meter)
  --from           a config.h (or a folder with config.h and config.c) instead of betaflight/config
  --force          overwrite configs/<BOARD>/, replace an existing project block, accept an unknown MCU
  --print          print the result, write nothing
Exit codes: 0 written, 1 refused (message says why), 2 the board config could not be read.
Reference values: configs/reference/reference.json. Protocol for AI agents: AGENT_PORTING.md.
"""
import argparse
import difflib
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((REPO / "configs" / "reference" / "reference.json").read_text(encoding="utf-8"))
BRANCH = "2025.12-config"
CONFIG_URL = "https://raw.githubusercontent.com/betaflight/config/" + BRANCH + "/configs/{board}/{name}"
TREE_URL = "https://api.github.com/repos/betaflight/config/git/trees/" + BRANCH
BRANCH_URL = "https://api.github.com/repos/betaflight/config/branches/" + BRANCH
MARKER = "// ---- Shramko Motor Autostart (patches/0001-shramko-motor-autostart.patch) ----"

# FC_TARGET_MCU values Betaflight 2025.12.1 has a platform for (src/platform/*/target/)
MCU = {
    "STM32F405": "the MCU of the hardware-tested board (HGLRC F405 8S V2)",
    "STM32F411": "builds, not tested on hardware",
    "STM32F7X2": "builds, not tested on hardware",
    "STM32F745": "builds, not tested on hardware",
    "STM32H743": "builds, not tested on hardware",
    "STM32G47X": "builds, not tested on hardware",
    "AT32F435G": "builds, not tested on hardware",
    "AT32F435M": "builds, not tested on hardware",
    "STM32H730": "builds (EXST), not tested on hardware",
    "STM32H750": "builds (EXST), not tested on hardware",
    "STM32H723": "not built yet",
    "STM32H725": "not built yet",
    "STM32H735": "not built yet",
    "STM32F446": "not built yet (no beeper on this target)",
    "APM32F405": "not built yet",
    "APM32F407": "not built yet",
    "STM32H563": "not built yet (experimental: no DShot, no USB serial port, no beeper)",
    "RP2350A": "not built yet (no ESC sensor on this target)",
    "RP2350B": "not built yet (no ESC sensor on this target)",
}

# gyro/acc driver macros Betaflight 2025.12.1 knows (src/main, src/platform); a board that lists only others
# never detects its gyro, and then Betaflight never drives the motors
KNOWN_IMU = set("""
USE_ACCGYRO_BMI160 USE_ACCGYRO_BMI270 USE_ACCGYRO_ICM40609D USE_ACCGYRO_ICM45605 USE_ACCGYRO_ICM45686
USE_ACCGYRO_IIM42652 USE_ACCGYRO_IIM42653 USE_ACCGYRO_LSM6DSO USE_ACCGYRO_LSM6DSV16X USE_ACC_ICM20601
USE_ACC_ICM20602 USE_ACC_ICM20608G USE_ACC_MPU6000 USE_ACC_MPU6050 USE_ACC_MPU6500 USE_ACC_SPI_ICM20601
USE_ACC_SPI_ICM20602 USE_ACC_SPI_ICM20608G USE_ACC_SPI_ICM20649 USE_ACC_SPI_ICM20689 USE_ACC_SPI_ICM42605
USE_ACC_SPI_ICM42688P USE_ACC_SPI_MPU6000 USE_ACC_SPI_MPU6500 USE_ACC_SPI_MPU9250 USE_GYRO_ICM20601
USE_GYRO_ICM20602 USE_GYRO_ICM20608G USE_GYRO_L3GD20 USE_GYRO_MPU6050 USE_GYRO_MPU6500 USE_GYRO_SPI_ICM20601
USE_GYRO_SPI_ICM20602 USE_GYRO_SPI_ICM20608G USE_GYRO_SPI_ICM20649 USE_GYRO_SPI_ICM20689 USE_GYRO_SPI_ICM42605
USE_GYRO_SPI_ICM42688P USE_GYRO_SPI_MPU6000 USE_GYRO_SPI_MPU6500 USE_GYRO_SPI_MPU9250
""".split())
IMU_NON_CHIP = re.compile(r"_(CLKIN|DLPF|OVERFLOW|REGISTER|SLEW|EXTI|LPF|FAST|1|2|BOTH)$")

# set by the project block: the board's own line is commented out (a second #define is an error under -Werror)
REPLACED = ("DEFAULT_MOTOR_DSHOT_SPEED", "DEFAULT_DSHOT_TELEMETRY", "DEBUG_MODE", "USE_AUTOSTART")
# UART functions a config can preset (src/main/io/serial.c): such a UART is not free for the ESC telemetry
PRESET_UARTS = ("SERIALRX_UART", "GPS_UART", "MSP_UART", "USE_MSP_UART", "MSP_DISPLAYPORT_UART", "VTX_SMARTAUDIO_UART",
                "VTX_TRAMP_UART", "VTX_MSP_UART", "SBUS_TELEMETRY_UART", "ESC_SENSOR_UART")
DEFINE = re.compile(r"^\s*#\s*define\s+(\w+)(?:[ \t]+(.*?))?\s*$")
RUN = {
    "Linux / macOS": 'docker run --rm -v "$PWD:/repo" shramko-bf-build:2025.12.1',
    "Windows PowerShell": 'docker run --rm -v "${PWD}:/repo" shramko-bf-build:2025.12.1',
    "Windows Git Bash": 'MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W):/repo" shramko-bf-build:2025.12.1',
    "Windows cmd": 'docker run --rm -v "%cd%:/repo" shramko-bf-build:2025.12.1',
}


def strip_comment(value):
    return re.sub(r"\s*//.*$", "", value or "").strip()


def defines(text):
    out = {}
    for line in text.splitlines():
        m = DEFINE.match(line)
        if m:
            out[m.group(1)] = strip_comment(m.group(2))
    return out


def http_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "shramko-motor-autostart"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def fetch(board, name):
    try:
        return http_get(CONFIG_URL.format(board=board, name=name))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def similar_boards(board):
    """config folders on the branch that look like `board` (best effort: the GitHub API may be rate-limited)"""
    try:
        tree = json.loads(http_get(TREE_URL + "?recursive=1"))["tree"]
    except Exception:  # offline, rate limit
        return []
    names = sorted({t["path"].split("/")[1] for t in tree if t["path"].startswith("configs/") and t["path"].count("/") >= 1})
    key = board.upper()
    hits = [n for n in names if key in n.upper() or n.upper() in key]
    return (hits + [n for n in difflib.get_close_matches(key, names, n=6, cutoff=0.5) if n not in hits])[:8]


def source_commit():
    try:
        return json.loads(http_get(BRANCH_URL))["commit"]["sha"][:12]
    except Exception:
        return None


def read_source(board, src):
    """(config.h text, config.c text or None, where it came from)"""
    if src:
        p = Path(src)
        if p.is_dir():
            h, c = p / "config.h", p / "config.c"
            return h.read_text(encoding="utf-8"), (c.read_text(encoding="utf-8") if c.exists() else None), str(h)
        return p.read_text(encoding="utf-8"), None, str(p)
    h = fetch(board, "config.h")
    if h is None:
        return None, None, CONFIG_URL.format(board=board, name="config.h")
    return h, fetch(board, "config.c"), CONFIG_URL.format(board=board, name="config.h")


def mask_bits(mask):
    return [i + 1 for i in range(8) if mask >> i & 1]


def block(cells, motors, usb_inhibit):
    outputs = mask_bits(motors)
    out_txt = "output %d" % outputs[0] if len(outputs) == 1 else "outputs " + ", ".join(map(str, outputs))
    return "\n".join([
        MARKER,
        "// Reference setup (configs/reference/reference.json): battery plugged in -> 10 s -> linear ramp over 10 s",
        "// to 15 % -> hold; motor stopped below 3.30 V per cell for 5 s. All of these are CLI settings (autostart_*),",
        "// changeable without rebuilding. Keep this block LAST: build.sh --stock deletes from the marker to the end.",
        "#define USE_AUTOSTART",
        "#define AUTOSTART_DEFAULT_MODE         AUTOSTART_MODE_POWER",
        "#define AUTOSTART_DEFAULT_DELAY_S      10",
        "#define AUTOSTART_DEFAULT_RAMP_DS      100     // 10.0 s",
        "#define AUTOSTART_DEFAULT_THROTTLE_PCT 15",
        "#define AUTOSTART_DEFAULT_MOTOR_MASK   0x%02X    // %s" % (motors, out_txt),
        "#define AUTOSTART_DEFAULT_USB_INHIBIT  %d       // %s" % (
            usb_inhibit, "never spin while a computer is connected" if usb_inhibit else
            "may spin while a computer is connected (the battery gate keeps USB-only safe)"),
        "#define AUTOSTART_DEFAULT_VBAT_MIN_DV  60      // 6.0 V: countdown starts when the battery is plugged in",
        "#define AUTOSTART_DEFAULT_CELLS        %d       // %s" % (cells, "%dS battery" % cells if cells else "auto-detect"),
        "#define AUTOSTART_DEFAULT_CELL_CUTOFF_CV 330   // stop the motor below 3.30 V per cell for 5 s",
        "",
        "// Survive any config reset (Betaflight resets the whole config when a parameter group changes):",
        "#define DEFAULT_MOTOR_DSHOT_SPEED      MOTOR_PROTOCOL_DSHOT300",
        "// dshot_bidir stays OFF (Betaflight default): with ON a BLHeli_32 ESC that stays powered while the board",
        "// restarts sometimes stops answering. ESC telemetry comes from the ESC's TX wire (feature ESC_SENSOR).",
        "#define DEBUG_MODE                     DEBUG_AUTOSTART           // state / timing for the configurator and tools/",
        "",
    ])


def uart_name(port):
    """SERIAL_PORT_USART3 / SERIAL_PORT_UART5 -> UART3 / UART5 (the CLI `serial` identifier)"""
    m = re.match(r"SERIAL_PORT_U(?:S)?ART(\d+)$", port or "")
    return "UART" + m.group(1) if m else None


def rx_pins(d):
    """UARTn -> RX pin, for the UARTs whose RX pad exists in this config"""
    pins = {}
    for k, v in d.items():
        m = re.match(r"UART(\d+)_RX_PIN$", k)
        if m and v and v.upper() != "NONE":
            pins["UART" + m.group(1)] = v
    return dict(sorted(pins.items(), key=lambda kv: int(kv[0][4:])))


def repo_commit():
    """the commit build.sh embeds (as-<commit>), best effort"""
    try:
        import subprocess
        return subprocess.run(["git", "-C", str(REPO), "rev-parse", "--short=7", "HEAD"], capture_output=True,
                              text=True, timeout=10).stdout.strip() or None
    except Exception:
        return None


def after_flash(board, esc_uart, preset_uart, rx, cells, motors, usb_inhibit, vbat_meter, board_name=None, commit=None):
    send = []
    lines = ["# Shramko Motor Autostart: board-level part of the reference setup for %s." % board,
             "# Send after the first boot of the new firmware, USB only, battery unplugged, propeller off."]
    if esc_uart:
        if esc_uart != preset_uart:
            send.append("serial %s 1024 115200 57600 0 115200" % esc_uart)
        send.append("feature ESC_SENSOR")
        lines.append("# ESC TX wire -> %s RX pad (%s): function 1024 (ESC_SENSOR) on that UART, feature ESC_SENSOR." % (esc_uart, rx.get(esc_uart, "?")))
    elif esc_uart is None:
        lines.append("# ESC telemetry not decided: run make_board_config.py again with --esc-telemetry UARTn or none.")
    else:
        lines.append("# No ESC TX wire: nothing to send for ESC telemetry.")
    lines += send
    check = "python tools/check_reference.py <PORT> --cells %d --motors %d" % (cells, motors)
    if usb_inhibit:
        check += " --usb-inhibit ON"
    if not vbat_meter:
        check += " --no-vbat-meter"
    if esc_uart is False or esc_uart is None:
        check += " --no-esc-sensor"
    if send:
        lines += ["save", "",
                  "# As one command:",
                  "#   python tools/bf_cli.py <PORT> %s \"save\"" % " ".join('"%s"' % x for x in send)]
    else:
        lines += ["", "# Nothing to send: skip this file."]
    lines += ["", "# Then calibrate vbat_scale (AGENT_PORTING.md, step 8) and check (step 9):",
              "#   " + check + " --vbat-scale <calibrated> --commit %s --board %s --exit" % (commit or "<the commit you built>", board_name or "<board_name>"), ""]
    return "\n".join(lines), check


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("board", help="config folder name in betaflight/config 2025.12-config")
    ap.add_argument("--from", dest="src", help="a local config.h, or a folder with config.h (+ config.c)")
    ap.add_argument("--cells", type=int, help="series cells of your battery (reference %s)" % REFERENCE["cli"]["autostart_cells"])
    ap.add_argument("--motors", type=lambda s: int(s, 0), help="outputs whose motor should spin, bitmask (reference %s)" % REFERENCE["cli"]["autostart_motors"])
    ap.add_argument("--esc-telemetry", help="UARTn whose RX pad gets the ESC TX wire, or none")
    ap.add_argument("--usb-inhibit", choices=["ON", "OFF"], help="reference %s" % REFERENCE["cli"]["autostart_usb_inhibit"])
    ap.add_argument("--force", action="store_true", help="overwrite, replace a block, accept an unknown MCU")
    ap.add_argument("--print", dest="print_only", action="store_true", help="print the result, write nothing")
    a = ap.parse_args(argv)

    notes, warnings = [], []
    cells = a.cells if a.cells is not None else int(REFERENCE["cli"]["autostart_cells"])
    motors = a.motors if a.motors is not None else int(REFERENCE["cli"]["autostart_motors"])
    if a.cells is None:
        warnings.append("--cells not given: the reference %d (a %dS pack); a wrong count makes the cut-off wrong" % (cells, cells))
    if a.motors is None:
        warnings.append("--motors not given: the reference %d (outputs %s spin)" % (motors, ", ".join(map(str, mask_bits(motors)))))
    if not 0 <= cells <= 12:
        print("refused: --cells must be 0-12 (0 = auto-detect)")
        return 1
    if not 1 <= motors <= 255:
        print("refused: --motors must be 1-255 (bit 0 = output 1)")
        return 1

    try:
        text, config_c, origin = read_source(a.board, a.src)
    except (OSError, urllib.error.URLError) as e:
        print("cannot read the board config: %s" % e)
        return 2
    if text is None:
        print("%s is not a config folder on betaflight/config branch %s (%s)." % (a.board, BRANCH, origin))
        near = similar_boards(a.board)
        if near:
            print("folders with a similar name: %s (a few folders differ from the board_name)" % ", ".join(near))
        print("Otherwise look on master under configs/<MANUFACTURER_ID>/%s, or rebuild the config from `dump hardware`"
              " (AGENT_PORTING.md, appendix A), then run with --from." % a.board)
        return 2
    text = text.replace("\r\n", "\n").replace("\r", "\n")

    if MARKER in text or "#define USE_AUTOSTART" in text:
        if not a.force:
            print("refused: this config already has the project block (use --force to replace it)")
            return 1
        text = text.split(MARKER)[0].rstrip("\n") + "\n"

    d = defines(text)
    mcu, name = d.get("FC_TARGET_MCU"), d.get("BOARD_NAME")
    if name != a.board:
        notes.append("BOARD_NAME is %s: the firmware will report board_name %s (folder %s)" % (name, name, a.board))
    if mcu not in MCU:
        msg = "FC_TARGET_MCU %r has no platform in Betaflight 2025.12.1" % mcu
        if not a.force:
            print("refused: " + msg)
            return 1
        warnings.append(msg + " (--force)")
    else:
        notes.append("MCU %s: %s" % (mcu, MCU[mcu]))
    if "FC_VMA_ADDRESS" in d:
        warnings.append("EXST board (firmware in external flash): flash it ONLY through the board vendor's bootloader; "
                        "never the BOOT button / STM32 ROM DFU, never tools/flash_dfu.py, no full chip erase. "
                        "AGENT_PORTING.md does not cover this flashing: ask the human")

    # the board's own lines for what the block sets
    out = []
    for line in text.split("\n"):
        m = DEFINE.match(line)
        if m and m.group(1) in REPLACED:
            if line.rstrip().endswith("\\"):
                print("refused: multi-line #define %s; edit it by hand" % m.group(1))
                return 1
            out.append("// " + line.strip() + "   // replaced by the Shramko Motor Autostart block below")
            notes.append("commented out the board's own: %s" % line.strip())
        else:
            out.append(line)
    text = "\n".join(out).rstrip("\n") + "\n"

    # voltage sensing: the battery gate and the cut-off need it
    vbat_meter = "ADC_VBAT_PIN" in d and d.get("DEFAULT_VOLTAGE_METER_SOURCE") == "VOLTAGE_METER_ADC"
    usb_inhibit = None if a.usb_inhibit is None else int(a.usb_inhibit == "ON")
    if not vbat_meter:
        warnings.append("no ADC voltage meter (ADC_VBAT_PIN + DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC): "
                        "no battery gate and no cut-off, the countdown starts at boot")
        if usb_inhibit is None:
            usb_inhibit = 1
            warnings.append("so autostart_usb_inhibit = ON here (pass --usb-inhibit OFF to override)")
    if usb_inhibit is None:
        usb_inhibit = int(REFERENCE["cli"]["autostart_usb_inhibit"] == "ON")
    notes.append("vbat_scale starts at %s: calibrate it (step 8)" % d.get("DEFAULT_VOLTAGE_METER_SCALE", "Betaflight's default 110"))

    imu = [k for k in d if re.match(r"USE_(ACC|GYRO|ACCGYRO)_", k) and not IMU_NON_CHIP.search(k)]
    unknown_imu = [k for k in imu if k not in KNOWN_IMU]
    if imu and not [k for k in imu if k in KNOWN_IMU]:
        warnings.append("no gyro driver of Betaflight 2025.12.1 in this config (%s): the motors would never be "
                        "driven" % ", ".join(unknown_imu))
    elif unknown_imu:
        notes.append("no 2025.12.1 driver for %s: fine if the board's real gyro is another listed chip "
                     "(after flashing, `status` must show a GYRO line with a chip)" % ", ".join(unknown_imu))

    motor_pins = sorted(int(m.group(1)) for k in d for m in [re.match(r"MOTOR(\d+)_PIN$", k)] if m)
    beyond = [b for b in mask_bits(motors) if b not in motor_pins]
    if beyond:
        warnings.append("--motors includes output(s) %s, the config has motor pins %s"
                        % (", ".join(map(str, beyond)), ", ".join(map(str, motor_pins)) or "none"))
    if len(mask_bits(motors)) > 1:
        notes.append("autostart_motors %d drives outputs %s: with a 4-in-1 ESC every motor on them spins"
                     % (motors, ", ".join(map(str, mask_bits(motors)))))
    if cells == 0:
        notes.append("autostart_cells 0 = auto-detect, unreliable with a half-empty pack")

    boxes = sorted({v for k, v in d.items() if re.match(r"PINIO\d_BOX$", k) and v in ("40", "41", "42", "43")})
    if boxes:
        notes.append("PINIO boxes %s are used by the board: an RC switch (autostart_box) needs another id of 40-43"
                     % ", ".join(boxes))

    # ESC telemetry UART
    rx = rx_pins(d)
    preset_uart = uart_name(d.get("ESC_SENSOR_UART"))
    used = {uart_name(d.get(k)) for k in PRESET_UARTS if k != "ESC_SENSOR_UART"} - {None}
    free = [u for u in rx if u not in used]
    tlm_comments = [l.strip() for l in text.split("\n") if l.strip().startswith(("//", "/*", "*"))
                    and re.search(r"(?i)\besc\b.{0,30}(tlm|telem)|\b(tlm|telem)\w*.{0,30}\besc\b", l)]
    if preset_uart:
        notes.append("ESC telemetry UART preset by config.h: %s (RX pad %s)" % (preset_uart, rx.get(preset_uart, "?")))
    else:
        notes.append("no ESC telemetry UART in config.h; UARTs with an RX pad not preset for another function: %s"
                     % (", ".join("%s (%s)" % (u, rx[u]) for u in free) or "none"))
    for c in tlm_comments[:4]:
        notes.append("config.h says: " + c)
    esc_uart = None  # None = not decided, False = none
    if a.esc_telemetry:
        t = a.esc_telemetry.strip().upper().replace("USART", "UART")
        if t in ("NONE", "NO", "0"):
            esc_uart = False
        elif t in rx:
            esc_uart = t
            if t in used:
                warnings.append("%s is preset for another function in config.h (receiver, GPS, MSP or VTX): "
                                "the ESC_SENSOR line replaces it" % t)
        else:
            print("refused: --esc-telemetry %s: this config has no RX pad for it (UARTs with RX: %s)"
                  % (a.esc_telemetry, ", ".join(rx) or "none"))
            return 1
    else:
        warnings.append("--esc-telemetry not given: say which UART gets the ESC TX wire (UARTn) or none")

    result = text + "\n" + block(cells, motors, usb_inhibit)
    flash, check_cmd = after_flash(a.board, esc_uart, preset_uart, rx, cells, motors, usb_inhibit, vbat_meter, name,
                                   None if a.print_only else repo_commit())
    target = REPO / "configs" / a.board

    print("source: %s%s" % (origin, "" if a.src else " (branch %s @ %s)" % (BRANCH, source_commit() or "?")))
    for n in notes:
        print("note: " + n)
    for w in warnings:
        print("WARNING: " + w)
    if a.print_only:
        print("\n----- configs/%s/config.h -----\n%s----- configs/%s/after-flash.txt -----\n%s" % (a.board, result, a.board, flash))
        return 0
    if (target / "config.h").exists() and not a.force:
        print("refused: %s exists (use --force to overwrite)" % (target / "config.h"))
        return 1
    target.mkdir(parents=True, exist_ok=True)
    with open(target / "config.h", "w", encoding="utf-8", newline="\n") as f:
        f.write(result)
    if config_c is not None:
        with open(target / "config.c", "w", encoding="utf-8", newline="\n") as f:
            f.write(config_c.replace("\r\n", "\n"))
    with open(target / "after-flash.txt", "w", encoding="utf-8", newline="\n") as f:
        f.write(flash)
    print("wrote configs/%s/config.h (sha256 %s)%s and configs/%s/after-flash.txt"
          % (a.board, hashlib.sha256(result.encode("utf-8")).hexdigest()[:16], " + config.c" if config_c is not None else "", a.board))
    print("next: build it (AGENT_PORTING.md, step 6) with the docker prefix of your shell:")
    for shell, run in RUN.items():
        print("  %-18s %s bash /repo/build/build.sh %s" % (shell + ":", run, a.board))
    print("check after flashing: " + check_cmd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
