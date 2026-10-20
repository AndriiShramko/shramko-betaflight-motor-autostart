"""Draws the wiring diagram for Shramko Motor Autostart (HGLRC F405 8S V2 + Flycolor X-Cross HV3 160A, 6S),
with the real colours of the 8-wire cable that comes with the flight controller.
usage: python wiring_diagram.py <out.png> [ru|en]
"""
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
plt.rcParams["svg.fonttype"] = "none"
from matplotlib.patches import FancyBboxPatch, Rectangle, Circle

out = sys.argv[1]
lang = sys.argv[2] if len(sys.argv) > 2 else "en"
T = {
    "en": dict(
        title="Shramko Motor Autostart — wiring (6S)",
        warn="Max 8S on the red wire (B)! First power-up WITHOUT propeller.",
        batt="LiPo 6S battery", esc="Flycolor X-Cross HV3 160A\n(BLHeli_32, no BEC)",
        motor="Motor", phases="(any phase order)",
        thick="thick ESC power leads",
        fc="HGLRC F405 8S V2 — underside, connector \"4 3 2 1 R C G B\"\nwith the supplied 8-wire cable plugged in",
        sig="ESC thin pair:\nyellow = signal, black = ground",
        tap="NEW thin wire 22–24 AWG:\nbattery + (ESC V+ pad or the\n+ cup of the ESC's battery plug)",
        j1="ESC yellow → cable WHITE next to the yellow (pin 1)",
        j2="ESC black → cable BLACK (G)",
        j3="new thin + → cable RED (B)",
        cut="cut short + insulate each:\n3 other whites, green\n(and the yellow, if you skip TX)",
        notyellow="the cable's yellow is NOT the signal\n(it is the ESC telemetry input)",
        opt="recommended: ESC pad TX → cable YELLOW (R)\nESC voltage, RPM, temperature: calibrate without\na multimeter (either cable's yellow works);\nTX sits next to V+ — no solder bridge!",
        glue="plug: a drop of hot glue / silicone\nover it so vibration can't pull it out",
        beeps="Correct wiring = ESC plays 3 rising tones, then 1 low + 1 high tone.",
        joints="3 solder joints (+1 recommended, TX), each with heat-shrink; twist the wires together",
    ),
    "es": dict(
        title="Shramko Motor Autostart — conexiones (6S)",
        warn="¡Máximo 8S en el cable rojo (B)! Primer encendido SIN hélice.",
        batt="Batería LiPo 6S", esc="Flycolor X-Cross HV3 160A\n(BLHeli_32, sin BEC)",
        motor="Motor", phases="(fases en cualquier orden)",
        thick="cables gruesos de potencia del ESC",
        fc="HGLRC F405 8S V2 — cara inferior, conector «4 3 2 1 R C G B»\ncon el cable de 8 hilos incluido",
        sig="par fino del ESC:\namarillo = señal, negro = masa",
        tap="cable fino NUEVO 22–24 AWG:\n+ de la batería (pad V+ del ESC o el\n+ del conector de batería del ESC)",
        j1="amarillo del ESC → BLANCO del cable junto al amarillo (pin 1)",
        j2="negro del ESC → NEGRO del cable (G)",
        j3="nuevo + fino → ROJO del cable (B)",
        cut="cortar corto y aislar cada uno:\nlos otros 3 blancos, el verde\n(y el amarillo si no usas TX)",
        notyellow="el amarillo del cable NO es la señal\n(es la entrada de telemetría del ESC)",
        opt="recomendado: pad TX del ESC → AMARILLO del cable (R)\ntensión, RPM y temperatura del ESC: calibrar sin\npolímetro (vale el amarillo de cualquier cable);\nTX está junto a V+: ¡sin puentes de estaño!",
        glue="conector: una gota de cola caliente /\nsilicona para que la vibración no lo saque",
        beeps="Conexión correcta = el ESC suena 3 tonos ascendentes y luego 1 grave + 1 agudo.",
        joints="3 soldaduras (+1 recomendada, TX), cada una con termorretráctil; trenza los cables",
    ),
    "pl": dict(
        title="Shramko Motor Autostart — okablowanie (6S)",
        warn="Na czerwony przewód (B) maks. 8S! Pierwsze uruchomienie BEZ śmigła.",
        batt="Akumulator LiPo 6S", esc="Flycolor X-Cross HV3 160A\n(BLHeli_32, bez BEC)",
        motor="Silnik", phases="(fazy w dowolnej kolejności)",
        thick="grube przewody zasilania ESC",
        fc="HGLRC F405 8S V2 — spód, złącze „4 3 2 1 R C G B”\nz dołączonym 8-żyłowym kablem",
        sig="cienka para ESC:\nżółty = sygnał, czarny = masa",
        tap="NOWY cienki przewód 22–24 AWG:\nplus akumulatora (pad V+ na ESC\nlub „+” wtyczki akumulatora ESC)",
        j1="żółty z ESC → BIAŁY z kabla obok żółtego (pin 1)",
        j2="czarny z ESC → CZARNY z kabla (G)",
        j3="nowy cienki plus → CZERWONY z kabla (B)",
        cut="skrócić i zaizolować każdy osobno:\npozostałe 3 białe, zielony\n(i żółty, jeśli bez TX)",
        notyellow="żółty z kabla to NIE sygnał\n(to wejście telemetrii ESC)",
        opt="zalecane: pad TX na ESC → ŻÓŁTY z kabla (R)\nnapięcie, obroty i temperatura ESC: kalibracja bez\nmultimetru (pasuje żółty z każdego kabla);\nTX jest tuż przy V+ — bez mostka cyny!",
        glue="złącze: kropla kleju na gorąco /\nsilikonu, żeby drgania go nie wysunęły",
        beeps="Dobrze podłączone = ESC gra 3 rosnące tony, potem 1 niski + 1 wysoki.",
        joints="3 luty (+1 zalecany, TX), każdy w koszulce termokurczliwej; skręć przewody razem",
    ),
    "ru": dict(
        title="Shramko Motor Autostart — распайка (6S)",
        warn="На красный провод (B) не больше 8S! Первый запуск — БЕЗ пропеллера.",
        batt="Батарея LiPo 6S", esc="Flycolor X-Cross HV3 160A\n(BLHeli_32, без BEC)",
        motor="Мотор", phases="(фазы в любом порядке)",
        thick="толстые провода питания ESC",
        fc="HGLRC F405 8S V2 — низ платы, разъём «4 3 2 1 R C G B»\nс родным 8-жильным шлейфом",
        sig="тонкая пара ESC:\nжёлтый = сигнал, чёрный = земля",
        tap="НОВЫЙ тонкий провод 22–24 AWG:\nплюс батареи (площадка V+ на ESC\nили «+» разъёма батареи ESC)",
        j1="жёлтый ESC → БЕЛЫЙ шлейфа рядом с жёлтым (контакт 1)",
        j2="чёрный ESC → ЧЁРНЫЙ шлейфа (G)",
        j3="новый тонкий «+» → КРАСНЫЙ шлейфа (B)",
        cut="обрезать коротко и заизолировать\nкаждый: 3 других белых, зелёный\n(и жёлтый, если без TX)",
        notyellow="жёлтый шлейфа — НЕ сигнал\n(это вход телеметрии ESC)",
        opt="рекомендуется: пятак TX на ESC → ЖЁЛТЫЙ шлейфа (R)\nнапряжение, обороты, температура ESC: калибровка\nбез тестера (подходит жёлтый любого из шлейфов);\nTX вплотную к V+ — без перемычки припоя!",
        glue="разъём: капля термоклея / силикона\nсверху, чтобы вибрация не вытянула",
        beeps="Распаяно верно = ESC играет 3 восходящих тона, потом 1 низкий + 1 высокий.",
        joints="3 пайки (+1 рекомендуется, TX), на каждую термоусадка; провода скрутить вместе",
    ),
}[lang]

fig, ax = plt.subplots(figsize=(16, 10.5), dpi=110)
ax.set_xlim(0, 160)
ax.set_ylim(-16, 92)
ax.axis("off")
ax.text(80, 89, T["title"], ha="center", va="center", fontsize=20, weight="bold")
ax.text(80, 84, T["warn"], ha="center", fontsize=13, color="#c00000", weight="bold")


def box(x, y, w, h, label, fc, fs=12, ty=None):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.6", fc=fc, ec="#333", lw=2))
    ax.text(x + w / 2, (y + h - 2.2) if ty is None else ty, label, ha="center", va="top", fontsize=fs, weight="bold")


# battery + thick leads
box(4, 60, 22, 12, T["batt"], "#fff3c4", fs=10.5)
ax.text(15, 63, "+   −", ha="center", fontsize=16, weight="bold")
ax.plot([26, 38, 38, 52, 52], [69, 69, 50, 50, 54], color="#d62728", lw=6)
ax.plot([26, 34, 34, 84, 84], [64, 64, 47, 47, 54], color="#111", lw=6)
ax.text(4, 76, T["thick"], fontsize=10, color="#333")

# ESC with pads V+ TX S GND V-
box(46, 53, 44, 25, T["esc"], "#e3eefc")
pads = ["V+", "TX", "S", "GND", "V−"]
for i, p in enumerate(pads):
    px = 52 + i * 8
    ax.add_patch(Rectangle((px - 2.5, 54), 5, 3.5, fc="#c8a24a", ec="#333"))
    ax.text(px, 59, p, ha="center", fontsize=10, weight="bold")
for i, ph in enumerate("ABC"):
    y = 72 - i * 6
    ax.add_patch(Rectangle((93, y), 4, 3.5, fc="#c8a24a", ec="#333"))
    ax.text(95, y + 5, ph, ha="center", va="center", fontsize=10, weight="bold")
    ax.plot([97, 119], [y + 1.7, 66 + (1 - i) * 3], color="#444", lw=4)
ax.add_patch(Circle((128, 66), 8.5, fc="#dddddd", ec="#333", lw=2))
ax.text(128, 66, T["motor"], ha="center", va="center", fontsize=12, weight="bold")
ax.text(128, 55.5, T["phases"], ha="center", fontsize=10)

# FC connector + cable stubs with real colours
fx, fy = 50, 6
box(fx - 6, -9, 70, 23, T["fc"], "#e8f5e9", fs=11, ty=1.0)
labels = list("4321RCGB")
colors = ["#f4f4f4", "#f4f4f4", "#f4f4f4", "#f4f4f4", "#e6b800", "#1b8a3a", "#111111", "#d62728"]
names = ["M4", "M3", "M2", "M1", "RX5", "CU", "GND", "BAT"]
xs = [fx + i * 8 for i in range(8)]
for x, lab, col, nm in zip(xs, labels, colors, names):
    used = lab in ("1", "G", "B")
    ax.add_patch(Rectangle((x - 2.6, fy), 5.2, 5, fc="#ffffff", ec="#333", lw=2.5 if used else 1))
    ax.text(x, fy + 2.5, lab, ha="center", va="center", fontsize=12, weight="bold")
    ax.text(x, fy - 1.8, nm, ha="center", va="center", fontsize=8.5, color="#000" if used else "#888")
    top = 30 if used else 17
    ax.plot([x, x], [fy + 5, top], color="#777" if col == "#f4f4f4" else col, lw=6 if used else 4, solid_capstyle="butt")
    if col == "#f4f4f4":
        ax.plot([x, x], [fy + 5.3, top - 0.3], color=col, lw=4.5 if used else 3, solid_capstyle="butt")
    if not used:
        ax.plot([x - 1.6, x + 1.6], [top + 0.6, top - 0.6], color="#c00000", lw=2)   # cut mark
x_m1, x_g, x_b = xs[3], xs[6], xs[7]

# ESC thin pair -> cable
ax.plot([68, 68, x_m1, x_m1], [54, 40, 40, 30.5], color="#e6b800", lw=3.5)
ax.plot([76, 76, x_g, x_g], [54, 42, 42, 30.5], color="#111", lw=3.5)
# new thin + from ESC V+ pad -> red
ax.plot([53.5, 53.5, 110, 110, x_b, x_b], [54, 34, 34, 32.6, 32.6, 30.5], color="#d62728", lw=2.2, ls=(0, (4, 2)))
x_r = xs[4]
ax.plot([60, 60, 86, 86, x_r, x_r], [54, 37.5, 37.5, 19, 19, 17.5], color="#b8860b", lw=2, ls=(0, (1, 1.6)))
ax.text(122, 24, T["opt"], fontsize=9, color="#8a6d00", va="center")
for x in (x_m1, x_g, x_b):
    ax.add_patch(Rectangle((x - 1.4, 29.5), 2.8, 2.6, fc="#ffffff", ec="#000", lw=1.2, hatch="////"))   # solder joint + heat-shrink

ax.text(92, 47, T["sig"], fontsize=10, color="#333", va="center")
ax.text(120, 40, T["tap"], fontsize=9.5, color="#a01010", va="center")
for i, key in enumerate(("j1", "j2", "j3")):
    ax.text(1, 30 - i * 3.6, "%d)" % (i + 1), fontsize=11, weight="bold", va="center")
    ax.text(4, 30 - i * 3.6, T[key], fontsize=10, va="center")
ax.text(4, 19.5, T["joints"], fontsize=9, color="#333", va="center")
ax.text(1, 12, T["cut"], fontsize=9.5, color="#c00000", va="center")
ax.text(1, 2, T["notyellow"], fontsize=9.5, color="#8a6d00", va="center")
ax.text(124, 6, T["glue"], fontsize=9.5, color="#1f4e9a", va="center")
ax.text(1, -14, T["beeps"], fontsize=10.5, color="#1b5e20", weight="bold")
fig.savefig(out, bbox_inches="tight", facecolor="white")
print("saved", out)
