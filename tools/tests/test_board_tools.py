"""Tests of tools/make_board_config.py, tools/check_reference.py and the pure parts of tools/battery_test.py
(no hardware, no network).

    python -m unittest discover -s tools/tests -v

Every rule has a negative control: a generic build, a wrong cell count, a board that already sets the DShot
speed, the stock build cutting the block, a board without gyro or voltage meter.
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
ALL = ["--cells", "6", "--motors", "15", "--esc-telemetry", "UART5"]

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
    return mbc.defines(text.split(mbc.MARKER, 1)[1])


def fails(rows):
    return {r[1] for r in rows if r[0] == "FAIL"}


class CheckReference(unittest.TestCase):
    def test_reference_board_passes(self):
        rows = cr.check(cr.parse(FIXTURE), 6, 15, "OFF", commit="3c1808c4", board="HGLRC_F405_S8")
        self.assertEqual(fails(rows), set())
        self.assertIn(("PASS", "gyro (status)", "(1) ICM42688P enabled locked dma", "a detected gyro: Betaflight drives the motors only with one"), rows)
        # 149 differs from the default 210: changed (calibrated), not a warning
        self.assertEqual([r[0] for r in rows if r[1] == "vbat_scale"], ["INFO"])

    def test_generic_build_fails_exactly_where_it_differs(self):
        generic = (FIXTURE.replace("autostart_mode = POWER", "autostart_mode = OFF")
                   .replace("autostart_motors = 15", "autostart_motors = 1")
                   .replace("autostart_usb_inhibit = OFF", "autostart_usb_inhibit = ON")
                   .replace("autostart_cells = 6", "autostart_cells = 0")
                   .replace("motor_pwm_protocol = DSHOT300", "motor_pwm_protocol = DSHOT600")
                   .replace("debug_mode = AUTOSTART", "debug_mode = NONE")
                   .replace(" ESC_SENSOR ", " "))
        self.assertEqual(fails(cr.check(cr.parse(generic), 6, 15, "OFF")),
                         {"autostart_mode", "autostart_motors", "autostart_usb_inhibit", "autostart_cells",
                          "motor_pwm_protocol", "debug_mode", "feature ESC_SENSOR"})

    def test_adapted_values(self):
        # a 4S pack on one ESC at output 1: the reference board fails on cells and motors, a matching one passes
        self.assertEqual(fails(cr.check(cr.parse(FIXTURE), 4, 1, "OFF")), {"autostart_cells", "autostart_motors"})
        adapted = FIXTURE.replace("autostart_cells = 6", "autostart_cells = 4").replace("autostart_motors = 15", "autostart_motors = 1")
        self.assertEqual(fails(cr.check(cr.parse(adapted), 4, 1, "OFF")), set())

    def test_esc_uart(self):
        self.assertEqual(fails(cr.check(cr.parse(FIXTURE), 6, 15, "OFF", esc_uart="UART5")), set())
        self.assertEqual(fails(cr.check(cr.parse(FIXTURE), 6, 15, "OFF", esc_uart="UART7")), {"serial ESC_SENSOR (1024)"})
        two = FIXTURE.replace("serial UART3 0 ", "serial UART3 1024 ")
        self.assertEqual(fails(cr.check(cr.parse(two), 6, 15, "OFF")), {"serial ESC_SENSOR (1024)"})
        # Betaflight reads the first UART with the function: the wired one must be the only one
        self.assertEqual(fails(cr.check(cr.parse(two), 6, 15, "OFF", esc_uart="UART5")), {"serial ESC_SENSOR (1024)"})

    def test_esc_sensor_needs_the_uart_function(self):
        no_port = FIXTURE.replace("serial UART5 1024", "serial UART5 0")
        self.assertEqual(fails(cr.check(cr.parse(no_port), 6, 15, "OFF")), {"serial ESC_SENSOR (1024)"})
        no_wire = no_port.replace(" ESC_SENSOR ", " ")
        self.assertEqual(fails(cr.check(cr.parse(no_wire), 6, 15, "OFF", esc_sensor=False)), set())

    def test_firmware_commit_and_board(self):
        stock = FIXTURE.replace("(as-3c1808c)", "(norevision)")
        self.assertIn("firmware", fails(cr.check(cr.parse(stock), 6, 15, "OFF")))
        self.assertEqual(fails(cr.check(cr.parse(FIXTURE), 6, 15, "OFF", commit="1a6d505")), {"firmware commit"})
        self.assertEqual(fails(cr.check(cr.parse(FIXTURE), 6, 15, "OFF", board="SPEEDYBEEF405V4")), {"board_name"})

    def test_gyro(self):
        none = FIXTURE.replace("GYRO: (1) ICM42688P enabled locked dma", "GYRO: None")
        self.assertEqual(fails(cr.check(cr.parse(none), 6, 15, "OFF")), {"gyro (status)"})
        old = FIXTURE.replace("GYRO: (1) ICM42688P enabled locked dma", "GYRO=ICM42688P, ACC=ICM42688P")
        self.assertEqual(fails(cr.check(cr.parse(old), 6, 15, "OFF")), set())
        missing = FIXTURE.replace("GYRO: (1) ICM42688P enabled locked dma\n", "")
        self.assertEqual(fails(cr.check(cr.parse(missing), 6, 15, "OFF")), {"gyro (status)"})

    def test_battery_meter(self):
        none = FIXTURE.replace("battery_meter = ADC", "battery_meter = NONE")
        self.assertEqual(fails(cr.check(cr.parse(none), 6, 15, "OFF")), {"battery_meter"})
        # a board without voltage sensing: no gate, so USB inhibit must be ON (main() makes it the expectation)
        rows = cr.check(cr.parse(none), 6, 15, "ON", vbat_meter=False)
        self.assertEqual(fails(rows), {"autostart_usb_inhibit"})
        self.assertEqual(fails(cr.check(cr.parse(none.replace("autostart_usb_inhibit = OFF", "autostart_usb_inhibit = ON")), 6, 15, "ON", vbat_meter=False)), set())

    def test_pwm_esc(self):
        pwm = FIXTURE.replace("motor_pwm_protocol = DSHOT300", "motor_pwm_protocol = PWM").replace(" ESC_SENSOR ", " ")
        self.assertEqual(fails(cr.check(cr.parse(pwm), 6, 15, "OFF")), {"motor_pwm_protocol", "feature ESC_SENSOR"})
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cli.txt"
            p.write_text(pwm, encoding="utf-8")
            code, out = run_tool(cr.main, ["--from-file", str(p), "--protocol", "PWM"])
            self.assertEqual(code, 0, out)

    def test_vbat_scale(self):
        rows = cr.check(cr.parse(FIXTURE), 6, 15, "OFF", vbat_scale=152)
        self.assertIn(("FAIL", "vbat_scale", "149", "152"), rows)
        self.assertIn(("PASS", "vbat_scale", "149", "149"), cr.check(cr.parse(FIXTURE), 6, 15, "OFF", vbat_scale=149))
        at_default = FIXTURE.replace("vbat_scale = 149\nAllowed range: 0 - 255\nDefault value: 210\n", "vbat_scale = 210\nAllowed range: 0 - 255\n")
        rows = cr.check(cr.parse(at_default), 6, 15, "OFF")
        self.assertEqual([r[0] for r in rows if r[1] == "vbat_scale"], ["WARN"])
        self.assertEqual(fails(rows), set())  # a warning, not a failure

    def test_cli_from_file_utf8_utf16_and_blank_lines(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "cli.txt"
            for enc in ("utf-8", "utf-8-sig", "utf-16"):  # utf-16: what Windows PowerShell 5.1 '>' writes
                p.write_bytes(FIXTURE.encode(enc))
                code, out = run_tool(cr.main, ["--from-file", str(p), "--commit", "3c1808c", "--board", "HGLRC_F405_S8"])
                self.assertEqual(code, 0, enc + out)
                self.assertIn("RESULT: PASS", out)
            # Betaflight may print a blank line between the matches of `get autostart`
            p.write_text(FIXTURE.replace("\nautostart_", "\n\nautostart_"), encoding="utf-8")
            self.assertEqual(run_tool(cr.main, ["--from-file", str(p)])[0], 0)
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
        flash = out.split("after-flash.txt -----\n")[-1] if "after-flash.txt -----" in out else ""
        return code, out, cfg, flash

    def test_block_is_last_and_replaces_the_boards_own_lines(self):
        code, out, cfg, flash = self.make(*ALL)
        self.assertEqual(code, 0, out)
        d = mbc.defines(cfg)
        self.assertEqual(d["DEFAULT_MOTOR_DSHOT_SPEED"], "MOTOR_PROTOCOL_DSHOT300")
        self.assertNotIn("DEFAULT_DSHOT_TELEMETRY", d)  # commented out: Betaflight's default OFF applies
        self.assertEqual(len(re.findall(r"^#define DEFAULT_MOTOR_DSHOT_SPEED", cfg, re.M)), 1)
        self.assertTrue(cfg.rstrip().endswith("DEBUG_AUTOSTART           // state / timing for the configurator and tools/"))
        self.assertIn("ESC telemetry UART preset by config.h: UART5 (RX pad PD2)", out)
        self.assertIn("PINIO boxes 40", out)
        self.assertNotIn("WARNING", out)
        # UART5 is preset: only the feature has to be sent
        self.assertIn('python tools/bf_cli.py <PORT> "feature ESC_SENSOR" "save"', flash)
        self.assertNotIn("serial UART5", flash)
        self.assertIn("check_reference.py <PORT> --cells 6 --motors 15 --esc-uart UART5 --vbat-scale", flash)

    def test_stock_build_cut_leaves_the_vendor_config(self):
        stock = stock_cut(self.make(*ALL)[2])
        self.assertNotIn("AUTOSTART", stock.replace("// replaced by the Shramko Motor Autostart block below", ""))
        self.assertEqual(mbc.defines(stock)["FC_TARGET_MCU"], "STM32F405")

    def test_reference_values_and_adaptation(self):
        self.assertEqual(block_defines(self.make(*ALL)[2]), REFERENCE["build_block"])
        got = block_defines(self.make("--cells", "4", "--motors", "1", "--usb-inhibit", "ON", "--esc-telemetry", "none")[2])
        self.assertEqual((got["AUTOSTART_DEFAULT_CELLS"], got["AUTOSTART_DEFAULT_MOTOR_MASK"], got["AUTOSTART_DEFAULT_USB_INHIBIT"]),
                         ("4", "0x01", "1"))

    def test_missing_choices_are_warned(self):
        code, out, cfg, flash = self.make()
        self.assertEqual(code, 0)
        for what in ("--cells not given", "--motors not given", "--esc-telemetry not given"):
            self.assertIn("WARNING: " + what, out)
        self.assertEqual(block_defines(cfg), REFERENCE["build_block"])  # the reference values
        self.assertIn("ESC telemetry not decided", flash)

    def test_esc_telemetry_choices(self):
        board = BOARD_H.replace("#define ESC_SENSOR_UART      SERIAL_PORT_UART5\n", "")
        code, out, _, flash = self.make("--cells", "6", "--motors", "1", "--esc-telemetry", "UART3", board_h=board)
        self.assertEqual(code, 0, out)
        self.assertIn('"serial UART3 1024 115200 57600 0 115200" "feature ESC_SENSOR" "save"', flash)
        self.assertNotIn("--no-esc-sensor", flash)
        code, out, _, flash = self.make("--cells", "6", "--motors", "1", "--esc-telemetry", "none", board_h=board)
        self.assertIn("Nothing to send: skip this file.", flash)
        self.assertIn("--no-esc-sensor", flash)
        self.assertNotIn("feature ESC_SENSOR\n", flash)
        # a UART without an RX pad in the config is refused; the receiver's UART is allowed with a warning
        self.assertEqual(self.make("--esc-telemetry", "UART4", board_h=board)[0], 1)
        out = self.make("--cells", "6", "--motors", "1", "--esc-telemetry", "USART2", board_h=board)[1]
        self.assertIn("WARNING: UART2 is preset for another function", out)

    def test_free_uarts_have_a_pad_and_are_sorted(self):
        board = (BOARD_H.replace("#define ESC_SENSOR_UART      SERIAL_PORT_UART5\n", "")
                 + "#define UART10_RX_PIN PA0\n#define UART6_RX_PIN NONE\n#define VTX_SMARTAUDIO_UART SERIAL_PORT_UART3\n")
        out = self.make(*ALL[:4], board_h=board)[1]
        self.assertIn("not preset for another function: UART5 (PD2), UART10 (PA0)", out)

    def test_hglrc_config_block_equals_the_reference(self):
        hglrc = (REPO / "configs" / "HGLRC_F405_S8" / "config.h").read_text(encoding="utf-8")
        self.assertIn(mbc.MARKER, hglrc)
        self.assertEqual(block_defines(hglrc), REFERENCE["build_block"])
        self.assertEqual(stock_cut(hglrc).count("AUTOSTART"), 0)

    def test_hglrc_after_flash_matches_the_tool(self):
        hglrc = REPO / "configs" / "HGLRC_F405_S8"
        code, out, _, flash = self.make(*ALL, board_h=(hglrc / "config.h").read_text(encoding="utf-8").split(mbc.MARKER)[0],
                                        board="HGLRC_F405_S8")
        self.assertEqual(code, 0, out)
        self.assertEqual((hglrc / "after-flash.txt").read_text(encoding="utf-8"), flash)

    def test_refusals_and_notes(self):
        code, out, _, _ = self.make(*ALL, board="OTHER")  # a folder whose BOARD_NAME differs (real: BROTHERHOBBYF405V2)
        self.assertEqual(code, 0, out)
        self.assertIn("the firmware will report board_name TESTF405", out)
        code, out, _, _ = self.make(*ALL, board_h=BOARD_H.replace("STM32F405", "STM32N657"))
        self.assertEqual(code, 1)
        self.assertIn("no platform in Betaflight 2025.12.1", out)
        cfg = self.make(*ALL)[2]
        self.assertEqual(self.make(*ALL, board_h=cfg)[0], 1)  # already has the block
        self.assertEqual(self.make("--cells", "13")[0], 1)
        self.assertEqual(self.make("--motors", "0")[0], 1)

    def test_force_replaces_an_existing_block(self):
        cfg = self.make("--cells", "4", "--motors", "15", "--esc-telemetry", "UART5")[2]
        code, out, again, _ = self.make("--force", *ALL, board_h=cfg)
        self.assertEqual(code, 0, out)
        self.assertEqual(again.count(mbc.MARKER), 1)
        self.assertEqual(block_defines(again)["AUTOSTART_DEFAULT_CELLS"], "6")

    def test_no_voltage_meter_turns_usb_inhibit_on(self):
        no_vbat = BOARD_H.replace("#define ADC_VBAT_PIN         PC0\n", "")
        code, out, cfg, flash = self.make(*ALL, board_h=no_vbat)
        self.assertEqual(code, 0)
        self.assertIn("no battery gate and no cut-off", out)
        self.assertEqual(block_defines(cfg)["AUTOSTART_DEFAULT_USB_INHIBIT"], "1")
        self.assertIn("--motors 15 --no-vbat-meter --esc-uart", flash)  # check_reference then expects inhibit ON
        for form in (["--usb-inhibit", "OFF"], ["--usb-inhibit=OFF"]):
            _, _, cfg, flash = self.make(*ALL, *form, board_h=no_vbat)
            self.assertEqual(block_defines(cfg)["AUTOSTART_DEFAULT_USB_INHIBIT"], "0", form)
            self.assertIn("--no-vbat-meter --usb-inhibit OFF", flash)
            self.assertIn("NO battery gate", cfg)

    def test_battery_pad_without_meter_source_gets_it(self):
        # 22 real boards (CRAZYBEEF405, BETAFLIGHTF4, ...) have ADC_VBAT_PIN but no DEFAULT_VOLTAGE_METER_SOURCE
        board = BOARD_H.replace("#define DEFAULT_VOLTAGE_METER_SOURCE VOLTAGE_METER_ADC\n", "")
        code, out, cfg, flash = self.make(*ALL, board_h=board)
        self.assertEqual(code, 0)
        self.assertNotIn("WARNING", out)
        d = block_defines(cfg)
        self.assertEqual((d["DEFAULT_VOLTAGE_METER_SOURCE"], d["AUTOSTART_DEFAULT_USB_INHIBIT"]), ("VOLTAGE_METER_ADC", "0"))
        self.assertNotIn("--no-vbat-meter", flash)
        self.assertNotIn("VOLTAGE_METER", stock_cut(cfg))  # the stock build keeps the board's own meter setting
        other = BOARD_H.replace("VOLTAGE_METER_ADC", "VOLTAGE_METER_NONE")
        cfg = self.make(*ALL, board_h=other)[2]
        self.assertEqual(mbc.defines(cfg)["DEFAULT_VOLTAGE_METER_SOURCE"], "VOLTAGE_METER_ADC")
        self.assertEqual(len(re.findall(r"^#define DEFAULT_VOLTAGE_METER_SOURCE", cfg, re.M)), 1)

    def test_wired_uart_other_than_the_preset(self):
        _, _, _, flash = self.make("--cells", "6", "--motors", "1", "--esc-telemetry", "UART3")
        self.assertIn('"serial UART5 0 115200 57600 0 115200" "serial UART3 1024 115200 57600 0 115200" "feature ESC_SENSOR"', flash)
        self.assertIn("--esc-uart UART3", flash)

    def test_motors_above_the_mixer(self):
        self.assertIn("outputs above 4", self.make("--cells", "6", "--motors", "16", "--esc-telemetry", "none",
                                                   board_h=BOARD_H + "#define MOTOR5_PIN PC9\n")[1])
        self.assertNotIn("outputs above 4", self.make(*ALL)[1])

    def test_backup_check(self):
        backup = "# Betaflight / STM32F405 (S405) 4.5.1 Jan 01 2025\n# board: manufacturer_id: TEST, board_name: TESTF405\nGYRO: (1) ICM42688P enabled\n"
        with tempfile.TemporaryDirectory() as d:
            b = Path(d) / "before.txt"
            for text, warn in ((backup, None),
                               (backup.replace("ICM42688P", "LSM6DSK320X"), "has no Betaflight 2025.12.1 driver"),
                               (backup.replace("ICM42688P", "BMI270"), "has no Betaflight 2025.12.1 driver"),
                               (backup.replace("GYRO: (1) ICM42688P enabled", "GYRO: None"), "shows no gyro"),
                               (backup.replace("board_name: TESTF405", "board_name: OTHERF405"), "wrong config?"),
                               (backup.replace("STM32F405", "STM32F7X2"), "wrong config")):
                b.write_bytes(text.encode("utf-16"))  # as PowerShell writes it
                out = self.make(*ALL, "--backup", str(b))[1]
                if warn:
                    self.assertIn(warn, out, text)
                else:
                    self.assertIn("backup: board_name TESTF405, MCU STM32F405, gyro ICM42688P (driver in the config)", out)
                    self.assertNotIn("WARNING", out)

    def test_exst_board_warns(self):
        out = self.make(*ALL, board_h=BOARD_H.replace("STM32F405", "STM32H730") + "#define FC_VMA_ADDRESS 0x90100000\n")[1]
        self.assertIn("WARNING: EXST board", out)
        self.assertNotIn("EXST", self.make(*ALL)[1])

    def test_gyro_without_driver(self):
        only_unknown = BOARD_H.replace("USE_GYRO_SPI_ICM42688P", "USE_ACCGYRO_LSM6DSK320X").replace("#define USE_ACC_SPI_ICM42688P\n", "")
        self.assertIn("WARNING: no gyro driver of Betaflight 2025.12.1", self.make(*ALL, board_h=only_unknown)[1])
        out = self.make(*ALL, board_h=BOARD_H + "#define USE_ACCGYRO_LSM6DSK320X\n")[1]
        self.assertNotIn("WARNING: no gyro driver", out)
        self.assertIn("no 2025.12.1 driver for USE_ACCGYRO_LSM6DSK320X", out)


class BatteryTestLogic(unittest.TestCase):
    def setUp(self):
        import importlib
        self.bt = importlib.import_module("battery_test")

    def test_calibration(self):
        c = self.bt.calibration
        new, verdict, _ = c(31.36, 22.32, 6, 210)   # the reference unit on 2026-10-20: 210 -> 149
        self.assertEqual((new, verdict), (149, None))
        self.assertEqual(c(22.25, 22.32, 6, 149)[:2], (None, True))     # within 2 %
        self.assertEqual(c(22.90, 22.32, 6, 149)[0], 145)               # 2.6 % off: applied (was skipped at 3 %)
        self.assertEqual(c(0.10, 22.32, 6, 210)[:2], (None, False))     # VBAT pad does not see the pack
        self.assertEqual(c(22.0, 0, 6, 210)[:2], (None, None))          # no ESC telemetry: nothing to judge
        self.assertEqual(c(12.7, 12.6, 6, 210)[:2], (None, False))      # a 3S pack with autostart_cells 6
        self.assertEqual(c(17.6, 16.4, 0, 210)[:2], (None, False))      # cells unknown

    def test_battery_present(self):
        bp = self.bt.battery_present
        self.assertFalse(bp([dict(v_fc=0.1, esc=None), dict(v_fc=0.0, esc=dict(volts=0.0))]))
        self.assertTrue(bp([dict(v_fc=0.1, esc=None), dict(v_fc=22.3, esc=None)]))
        # the ESC voltage is not proof: MSP keeps its last value after the battery is unplugged
        self.assertFalse(bp([dict(v_fc=0.0, esc=dict(volts=22.3))]))

    def test_sample_follows_the_motor_mask(self):
        import struct
        motors = struct.pack("<8H", 1000, 1000, 1150, 1000, 1000, 1000, 1000, 1000)
        dbg = struct.pack("<8h", 3, 150, 0, 100, 8, 223, 50, 1)
        bat = bytes(9) + struct.pack("<H", 2230) + bytes(2)
        tel = bytes([4])
        for i in range(4):  # TX-wire telemetry: no bad frames anywhere; only output 3 has an ESC
            tel += struct.pack("<IHBHHH", 5200 if i == 2 else 0, 0, 31 if i == 2 else 0, 2512 if i == 2 else 0, 0, 0)
        answers = {104: motors, 254: dbg, 139: tel, 130: bat}
        real = self.bt.msp
        self.bt.msp = lambda s, cmd, timeout=0.3: answers.get(cmd)
        try:
            x = self.bt.sample(None, mask=4)
            self.assertEqual((x["motor"], x["esc"]["out"], x["esc"]["volts"], x["esc"]["rpm"]), (1150, 3, 25.12, 5200))
            # negative control: the old behaviour (output 1 only) would see a stopped motor
            self.assertEqual(self.bt.sample(None, mask=1)["motor"], 1000)
        finally:
            self.bt.msp = real


class FcPeekVerdict(unittest.TestCase):
    def test_battery_verdict(self):
        import fc_peek
        v = fc_peek.battery_verdict
        self.assertEqual(v([0.1, 0.0, 0.1], 1)[0], 0)
        self.assertEqual(v([0.1, 22.3], 1)[0], 1)
        self.assertEqual(v([], 1)[0], 2)          # the board is in the CLI: nothing proven
        self.assertEqual(v([0.0, 0.0], 0)[0], 3)  # battery_meter NONE: 0 V proves nothing
        self.assertEqual(v([0.0], None)[0], 0)    # meter source not read: the voltage still decides


class SelftestRefusals(unittest.TestCase):
    """autostart_selftest.capture(): never reboot a board whose battery cannot be checked, always STOP"""

    def setUp(self):
        import importlib
        self.st = importlib.import_module("autostart_selftest")
        self.saved = (self.st.battery_volts, self.st._capture, self.st.send_stop)
        self.stops = []
        self.st.send_stop = lambda port, s=None: self.stops.append(port) or True

    def tearDown(self):
        self.st.battery_volts, self.st._capture, self.st.send_stop = self.saved

    def args(self, hot=False, motor=1):
        class A:
            pass
        a = A()
        a.port, a.hot, a.motor = "COMX", hot, motor
        return a

    def test_refusals(self):
        ran = []
        self.st._capture = lambda a: ran.append(a) or []
        for volts, hot in ((None, False), (None, True), (22.3, False)):
            self.st.battery_volts = lambda port, v=volts: v
            with self.assertRaises(SystemExit):
                self.st.capture(self.args(hot))
        with self.assertRaises(SystemExit):
            self.st.capture(self.args(motor=9))
        self.assertEqual(ran, [])
        self.st.battery_volts = lambda port: 22.3
        self.st.capture(self.args(hot=True))
        self.st.battery_volts = lambda port: 0.1
        self.st.capture(self.args())
        self.assertEqual(len(ran), 2)
        self.assertEqual(len(self.stops), 2)

    def test_stop_after_an_error(self):
        def boom(a):
            raise RuntimeError("port gone")
        self.st._capture = boom
        self.st.battery_volts = lambda port: 0.0
        with self.assertRaises(RuntimeError):
            self.st.capture(self.args())
        self.assertEqual(self.stops, ["COMX"])


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
