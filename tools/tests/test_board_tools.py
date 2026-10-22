"""Tests of tools/make_board_config.py and tools/check_reference.py (no hardware, no network).

    python -m unittest discover -s tools/tests -v

Every rule has a negative control: a generic build, a wrong cell count, a board that already sets the DShot
speed, the stock build cutting the block.
"""
import contextlib
import io
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))
import check_reference as cr  # noqa: E402
import make_board_config as mbc  # noqa: E402

FIXTURE = (Path(__file__).parent / "fixtures" / "reference_board_cli.txt").read_text(encoding="utf-8")
REFERENCE = json.loads((REPO / "configs" / "reference" / "reference.json").read_text(encoding="utf-8"))

# a made-up board in the shape of betaflight/config 2025.12-config: it already sets the DShot speed and
# bidirectional DShot (as 10 and 20 real boards do), presets UART5 for ESC telemetry, uses PINIO box 40
BOARD_H = """#pragma once
#define FC_TARGET_MCU     STM32F405
#define BOARD_NAME        TESTF405
#define MANUFACTURER_ID   TEST
#define USE_GYRO
#define USE_GYRO_SPI_ICM42688P
#define USE_ACC_SPI_ICM42688P
#define MOTOR1_PIN           PB0
#define MOTOR2_PIN           PB1
#define MOTOR3_PIN           PA3
#define MOTOR4_PIN           PA2
#define UART2_RX_PIN         PA3
#define UART5_RX_PIN         PD2
#define UART3_RX_PIN         PB11
#define ADC_VBAT_PIN         PC0
#define DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC
#define DEFAULT_MOTOR_DSHOT_SPEED    PWM_TYPE_DSHOT600
#define DEFAULT_DSHOT_TELEMETRY      DSHOT_TELEMETRY_ON
#define SERIALRX_UART        SERIAL_PORT_USART2
#define ESC_SENSOR_UART      SERIAL_PORT_UART5
#define PINIO1_BOX           40
"""


def run_tool(main, argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(argv)
    return code, out.getvalue()


def stock_cut(text):
    """what build/build.sh --stock does: sed '/---- Shramko Motor Autostart/,$d'"""
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if "---- Shramko Motor Autostart" in line:
            return "\n".join(lines[:i])
    return text


def block_defines(text):
    return {k: v for k, v in mbc.defines(text.split(mbc.MARKER, 1)[1]).items()}


class CheckReference(unittest.TestCase):
    def test_reference_board_passes(self):
        rows = cr.check(cr.parse(FIXTURE), 6, 15, "OFF")
        fails = [r for r in rows if r[0] == "FAIL"]
        self.assertEqual(fails, [])
        self.assertIn(("INFO", "board", "HGLRC_F405_S8 (STM32F405)", ""), rows)
        self.assertEqual(len([r for r in rows if r[0] == "PASS"]), 1 + len(REFERENCE["cli"]) + 2)

    def test_generic_build_fails_exactly_where_it_differs(self):
        generic = (FIXTURE.replace("autostart_mode = POWER", "autostart_mode = OFF")
                   .replace("autostart_motors = 15", "autostart_motors = 1")
                   .replace("autostart_usb_inhibit = OFF", "autostart_usb_inhibit = ON")
                   .replace("autostart_cells = 6", "autostart_cells = 0")
                   .replace("motor_pwm_protocol = DSHOT300", "motor_pwm_protocol = DSHOT600")
                   .replace("debug_mode = AUTOSTART", "debug_mode = NONE")
                   .replace(" ESC_SENSOR ", " "))
        fails = {r[1] for r in cr.check(cr.parse(generic), 6, 15, "OFF") if r[0] == "FAIL"}
        self.assertEqual(fails, {"autostart_mode", "autostart_motors", "autostart_usb_inhibit", "autostart_cells",
                                 "motor_pwm_protocol", "debug_mode", "feature ESC_SENSOR"})

    def test_adapted_values(self):
        # a 4S pack on one ESC at output 1: the reference board fails on cells and motors, a matching one passes
        fails = {r[1] for r in cr.check(cr.parse(FIXTURE), 4, 1, "OFF") if r[0] == "FAIL"}
        self.assertEqual(fails, {"autostart_cells", "autostart_motors"})
        adapted = FIXTURE.replace("autostart_cells = 6", "autostart_cells = 4").replace("autostart_motors = 15", "autostart_motors = 1")
        self.assertEqual([r for r in cr.check(cr.parse(adapted), 4, 1, "OFF") if r[0] == "FAIL"], [])

    def test_esc_sensor_needs_the_uart_function(self):
        no_port = FIXTURE.replace("serial UART5 1024", "serial UART5 0")
        fails = {r[1] for r in cr.check(cr.parse(no_port), 6, 15, "OFF") if r[0] == "FAIL"}
        self.assertEqual(fails, {"serial ESC_SENSOR (1024)"})
        # without the TX wire neither is expected
        no_wire = no_port.replace(" ESC_SENSOR ", " ")
        self.assertEqual([r for r in cr.check(cr.parse(no_wire), 6, 15, "OFF", esc_sensor=False) if r[0] == "FAIL"], [])

    def test_stock_firmware_and_vbat_scale(self):
        stock = FIXTURE.replace("(as-3c18)", "(norevision)")
        self.assertIn("firmware", {r[1] for r in cr.check(cr.parse(stock), 6, 15, "OFF") if r[0] == "FAIL"})
        rows = cr.check(cr.parse(FIXTURE), 6, 15, "OFF", vbat_scale=152)
        self.assertIn(("FAIL", "vbat_scale", "149", "152"), rows)
        self.assertIn(("PASS", "vbat_scale", "149", "149"), cr.check(cr.parse(FIXTURE), 6, 15, "OFF", vbat_scale=149))

    def test_cli_from_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cli.txt"
            p.write_text(FIXTURE, encoding="utf-8")
            code, out = run_tool(cr.main, ["--from-file", str(p)])
            self.assertEqual(code, 0, out)
            self.assertIn("RESULT: PASS", out)
            code, out = run_tool(cr.main, ["--from-file", str(p), "--cells", "4"])
            self.assertEqual(code, 1)
            self.assertIn("FAIL, 1 setting(s) differ: autostart_cells", out)
            p.write_text("nothing here", encoding="utf-8")
            self.assertEqual(run_tool(cr.main, ["--from-file", str(p)])[0], 2)


class MakeBoardConfig(unittest.TestCase):
    def make(self, *args, board_h=BOARD_H, board="TESTF405"):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "config.h"
            src.write_text(board_h, encoding="utf-8")
            code, out = run_tool(mbc.main, [board, "--from", str(src), "--print", *args])
        cfg = out.split("----- configs/%s/config.h -----\n" % board)[-1].split("----- configs/%s/after-flash.txt -----" % board)[0]
        return code, out, cfg

    def test_block_is_last_and_replaces_the_boards_own_lines(self):
        code, out, cfg = self.make()
        self.assertEqual(code, 0, out)
        d = mbc.defines(cfg)
        self.assertEqual(d["DEFAULT_MOTOR_DSHOT_SPEED"], "MOTOR_PROTOCOL_DSHOT300")
        self.assertNotIn("DEFAULT_DSHOT_TELEMETRY", d)  # commented out: Betaflight's default OFF applies
        self.assertEqual(len(re.findall(r"^#define DEFAULT_MOTOR_DSHOT_SPEED", cfg, re.M)), 1)
        self.assertTrue(cfg.rstrip().endswith("DEBUG_AUTOSTART           // state / timing for the configurator and tools/"))
        self.assertIn("ESC telemetry UART preset by config.h: UART5 (RX pad PD2)", out)
        self.assertIn("PINIO boxes 40", out)
        self.assertIn("feature ESC_SENSOR\n", out.split("after-flash.txt -----")[1])

    def test_stock_build_cut_leaves_the_vendor_config(self):
        _, _, cfg = self.make()
        stock = stock_cut(cfg)
        self.assertNotIn("AUTOSTART", stock.replace("// replaced by the Shramko Motor Autostart block below", ""))
        self.assertEqual(mbc.defines(stock)["FC_TARGET_MCU"], "STM32F405")

    def test_reference_values_and_adaptation(self):
        _, _, cfg = self.make()
        want = {k: v for k, v in REFERENCE["build_block"].items()}
        self.assertEqual(block_defines(cfg), want)
        _, _, cfg = self.make("--cells", "4", "--motors", "1", "--usb-inhibit", "ON")
        got = block_defines(cfg)
        self.assertEqual((got["AUTOSTART_DEFAULT_CELLS"], got["AUTOSTART_DEFAULT_MOTOR_MASK"], got["AUTOSTART_DEFAULT_USB_INHIBIT"]),
                         ("4", "0x01", "1"))

    def test_hglrc_config_block_equals_the_reference(self):
        hglrc = (REPO / "configs" / "HGLRC_F405_S8" / "config.h").read_text(encoding="utf-8")
        self.assertIn(mbc.MARKER, hglrc)
        self.assertEqual(block_defines(hglrc), REFERENCE["build_block"])
        self.assertEqual(stock_cut(hglrc).count("AUTOSTART"), 0)

    def test_refusals(self):
        self.assertEqual(self.make(board="OTHER")[0], 1)  # BOARD_NAME differs from the folder name
        code, out, _ = self.make(board_h=BOARD_H.replace("STM32F405", "STM32N657"))
        self.assertEqual(code, 1)
        self.assertIn("no platform in Betaflight 2025.12.1", out)
        _, _, cfg = self.make()
        self.assertEqual(self.make(board_h=cfg)[0], 1)  # already has the block
        self.assertEqual(self.make("--cells", "13")[0], 1)
        self.assertEqual(self.make("--motors", "0")[0], 1)

    def test_force_replaces_an_existing_block(self):
        _, _, cfg = self.make("--cells", "4")
        code, out, again = self.make("--force", board_h=cfg)
        self.assertEqual(code, 0, out)
        self.assertEqual(again.count(mbc.MARKER), 1)
        self.assertEqual(block_defines(again)["AUTOSTART_DEFAULT_CELLS"], "6")

    def test_no_voltage_meter_turns_usb_inhibit_on(self):
        no_vbat = BOARD_H.replace("#define ADC_VBAT_PIN         PC0\n", "")
        code, out, cfg = self.make(board_h=no_vbat)
        self.assertEqual(code, 0)
        self.assertIn("no battery gate and no cut-off", out)
        self.assertEqual(block_defines(cfg)["AUTOSTART_DEFAULT_USB_INHIBIT"], "1")
        _, _, cfg = self.make("--usb-inhibit", "OFF", board_h=no_vbat)
        self.assertEqual(block_defines(cfg)["AUTOSTART_DEFAULT_USB_INHIBIT"], "0")

    def test_gyro_without_driver(self):
        only_unknown = BOARD_H.replace("USE_GYRO_SPI_ICM42688P", "USE_ACCGYRO_LSM6DSK320X").replace("#define USE_ACC_SPI_ICM42688P\n", "")
        out = self.make(board_h=only_unknown)[1]
        self.assertIn("WARNING: no gyro driver of Betaflight 2025.12.1", out)
        both = BOARD_H + "#define USE_ACCGYRO_LSM6DSK320X\n"
        out = self.make(board_h=both)[1]
        self.assertNotIn("WARNING: no gyro driver", out)
        self.assertIn("no 2025.12.1 driver for USE_ACCGYRO_LSM6DSK320X", out)

    def test_no_esc_sensor_uart_lists_free_uarts(self):
        out = self.make(board_h=BOARD_H.replace("#define ESC_SENSOR_UART      SERIAL_PORT_UART5\n", ""))[1]
        self.assertIn("UARTs with an RX pad not preset for RX/GPS/MSP: UART3, UART5", out)
        self.assertIn("# serial UART<n> 1024 115200 57600 0 115200", out)


class SettingsDoc(unittest.TestCase):
    def test_reference_matches_settings_md(self):
        """the Default column of docs/settings.md (the author build) equals the reference"""
        md = (REPO / "docs" / "settings.md").read_text(encoding="utf-8")
        found = {}
        col, prev = None, []
        for line in md.splitlines():
            cells = [c.strip() for c in line.strip().strip("|").split("|")]
            if line.startswith("|---"):
                # a new table: its header is the line before; only tables with a "Default" column count
                col = next((i for i, c in enumerate(prev) if c.startswith("Default")), None)
                continue
            prev = cells
            m = re.match(r"`(autostart_\w+)`", cells[0]) if line.startswith("|") and col is not None else None
            if m and len(cells) > col:
                found[m.group(1)] = re.sub(r"[`\s].*$", "", cells[col].strip("`")) or cells[col]
        ref = {k: v for k, v in REFERENCE["cli"].items() if k.startswith("autostart_")}
        self.assertEqual(found, ref)


if __name__ == "__main__":
    unittest.main()
