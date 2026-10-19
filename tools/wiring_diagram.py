"""Draws the wiring diagram for Shramko Motor Autostart (HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A, 6S).
usage: python wiring_diagram.py <out.png> [ru|en]
"""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Rectangle, Circle

out = sys.argv[1]
lang = sys.argv[2] if len(sys.argv) > 2 else "en"
T = {
    "en": dict(
        title="Shramko Motor Autostart — wiring (6S)",
        batt="LiPo 6S battery\n(XT60)", esc="Flycolor X-Cross HV3 160A\n(BLHeli_32, no BEC)",
        fc="HGLRC F405 8S V2 — underside\n8-pin connector \"4321RCGB\"",
        motor="Motor\n(any phase order)", thick="thick 10 AWG (ESC power)",
        thin="thin pair 20–22 AWG = FC power,\ntaken from the ESC battery pads V+ / V−\n(not from the battery plug);\ntwist it with the signal pair",
        sig="factory twisted pair:\nyellow = signal (S)\nblack = signal ground",
        unused="M4 M3 M2 RX5 CU: not used, insulate each wire",
        cut="cut one end off the supplied 8-pin cable, solder to its wires",
        btn="Optional button (later):\ntop-side pads RX4 + GND\n(internal pull-up, no resistors).\nDo not touch BB- next to RX4.",
        warn="Max 8S on BAT! First power-up WITHOUT propeller.",
        beeps="Correct wiring = ESC plays 3 rising tones, then 1 low + 1 high tone.",
    ),
    "ru": dict(
        title="Shramko Motor Autostart — распайка (6S)",
        batt="Батарея LiPo 6S\n(XT60)", esc="Flycolor X-Cross HV3 160A\n(BLHeli_32, без BEC)",
        fc="HGLRC F405 8S V2 — низ платы\nразъём 8 pin «4321RCGB»",
        motor="Мотор\n(фазы в любом порядке)", thick="толстые 10 AWG (питание ESC)",
        thin="тонкая пара 20–22 AWG = питание полётника,\nс площадок V+ / V− на ESC\n(не с разъёма батареи);\nскрутить с сигнальной парой",
        sig="заводская витая пара:\nжёлтый = сигнал (S)\nчёрный = земля сигнала",
        unused="M4 M3 M2 RX5 CU: не нужны, каждый провод заизолировать",
        cut="у шлейфа 8 pin из коробки отрезать один разъём, паять к его проводам",
        btn="Кнопка (потом):\nверхние пятаки RX4 + GND рядом\n(подтяжка внутри, без резисторов).\nНе задеть BB- рядом с RX4.",
        warn="На BAT не больше 8S! Первый запуск — БЕЗ винта.",
        beeps="Распаяно верно = ESC играет 3 восходящих тона, потом 1 низкий + 1 высокий.",
    ),
}[lang]

fig, ax = plt.subplots(figsize=(16, 10), dpi=110)
ax.set_xlim(0, 160)
ax.set_ylim(-12, 90)
ax.axis("off")
ax.text(80, 87, T["title"], ha="center", va="center", fontsize=20, weight="bold")
ax.text(80, 82, T["warn"], ha="center", fontsize=13, color="#c00000", weight="bold")

def box(x, y, w, h, label, fc="#f2f2f2", ec="#333", fs=12, ty=None):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.6", fc=fc, ec=ec, lw=2))
    ax.text(x + w / 2, (y + h - 2.5) if ty is None else ty, label, ha="center", va="top", fontsize=fs, weight="bold")

# battery
box(4, 55, 22, 16, T["batt"], fc="#fff3c4")
ax.text(15, 59, "+   −", ha="center", fontsize=16, weight="bold")
# ESC
box(48, 50, 40, 26, T["esc"], fc="#e3eefc")
pads = [("V+", "#d62728"), ("TX", "#999999"), ("S", "#e6b800"), ("GND", "#111111"), ("V−", "#111111")]
for i, (p, c) in enumerate(pads):
    px = 52 + i * 8
    ax.add_patch(Rectangle((px - 2.5, 51), 5, 3.5, fc="#c8a24a", ec="#333"))
    ax.text(px, 56, p, ha="center", fontsize=10, weight="bold")
# phases + motor
for i, ph in enumerate("ABC"):
    y = 70 - i * 6
    ax.add_patch(Rectangle((91, y), 4, 3.5, fc="#c8a24a", ec="#333"))
    ax.text(93, y + 5, ph, ha="center", va="center", fontsize=10, weight="bold")
    ax.plot([95, 117], [y + 1.7, 64 + (1 - i) * 3], color="#444", lw=4)
ax.add_patch(Circle((126, 64), 9, fc="#dddddd", ec="#333", lw=2))
ax.text(126, 64, T["motor"].split(chr(10))[0], ha="center", va="center", fontsize=12, weight="bold")
ax.text(126, 52.5, T["motor"].split(chr(10))[1], ha="center", va="center", fontsize=10)

# thick power battery -> ESC
ax.plot([26, 40, 40, 52, 52], [68, 68, 47, 47, 51], color="#d62728", lw=6)
ax.plot([26, 36, 36, 84, 84], [61, 61, 44, 44, 51], color="#111", lw=6)
ax.text(4, 75, T["thick"], fontsize=10, color="#333", va="center")

# FC connector (pins on top edge of the box, title below them)
fx, fy = 52, 16
box(fx - 6, 0, 66, 22, T["fc"], fc="#e8f5e9", ty=10.5)
pins = ["M4", "M3", "M2", "M1", "RX5", "CU", "GND", "BAT"]
silk = list("4321RCGB")
for i, (p, s_) in enumerate(zip(pins, silk)):
    px = fx + i * 7.5
    used = p in ("M1", "GND", "BAT")
    ax.add_patch(Rectangle((px - 2.5, fy), 5, 5, fc="#ffffff" if used else "#eeeeee", ec="#333", lw=2.5 if used else 1))
    ax.text(px, fy + 2.5, s_, ha="center", va="center", fontsize=12, weight="bold")
    ax.text(px, fy - 2, p, ha="center", va="center", fontsize=9, color="#000" if used else "#999", weight="bold" if used else "normal")
x_m1, x_gnd, x_bat = fx + 3 * 7.5, fx + 6 * 7.5, fx + 7 * 7.5
top = fy + 5
# signal pair from ESC S/GND
ax.plot([68, 68, x_m1, x_m1], [51, 38, 38, top], color="#e6b800", lw=3.5)
ax.plot([76, 76, x_gnd - 0.8, x_gnd - 0.8], [51, 40, 40, top], color="#111", lw=3.5)
ax.text(100, 45, T["sig"], fontsize=10, color="#333", va="center")
# thin FC power from battery
ax.plot([53.2, 53.2, 44, 44, x_bat, x_bat], [51, 49, 49, 30, 30, top], color="#d62728", lw=2)
ax.plot([85.5, 85.5, 92, 92, x_gnd + 0.8, x_gnd + 0.8], [51, 49, 49, 27, 27, top], color="#111", lw=2)
ax.text(2, 30, T["thin"], fontsize=10, color="#333", va="top")
ax.text(fx - 6, -3.5, T["unused"], fontsize=9, color="#555")
ax.text(fx - 6, -6.5, T["cut"], fontsize=9, color="#555")

ax.text(116, 12, T["btn"], fontsize=9.5, color="#1f4e9a", va="center")
ax.text(2, -11, T["beeps"], fontsize=10.5, color="#1b5e20", weight="bold")
fig.savefig(out, bbox_inches="tight", facecolor="white")
print("saved", out)
