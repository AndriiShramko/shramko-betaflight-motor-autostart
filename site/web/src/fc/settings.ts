// Typed schema of the autostart settings, written by hand from docs/settings.md (firmware 1.1),
// plus validation (clamping, min/max swap), unit conversion, the simple panel / drawer split, the gust
// recipe, the program in words (describeProgram) and the diff against the board.
// The board is the final authority: ranges/values it prints in `get` narrow this schema.

import type { CliVar } from './cli';

export type GroupId = 'start' | 'power' | 'gusts' | 'battery' | 'outputs' | 'advanced';
export const GROUPS: GroupId[] = ['start', 'power', 'gusts', 'battery', 'outputs', 'advanced'];

/** raw CLI unit → how the form shows it */
export type Unit =
    | 's' // seconds
    | 'ds' // 0.1 s, shown in seconds
    | 'ms' // milliseconds, shown in seconds
    | 'pct' // %
    | 'cV' // 0.01 V, shown in volts
    | 'dV' // 0.1 V, shown in volts
    | 'cells'
    | 'raw';

export type Value = number | string;

interface Base {
    name: string;
    group: GroupId;
    /** firmware version that introduced it ('bf' = stock Betaflight) */
    since: '1.0' | '1.1' | 'bf';
}
export interface EnumDef extends Base {
    kind: 'enum';
    values: string[];
    def: string;
}
export interface NumDef extends Base {
    kind: 'num';
    unit: Unit;
    min: number;
    max: number;
    def: number;
    /** 0 is a special value with its own checkbox ("no cut-off", "until power off", ...) */
    zero?: 'off' | 'auto' | 'forever' | 'nocheck';
    /** smallest allowed value other than 0 (cell cut-off: 0 or 250–420) */
    minNonZero?: number;
    /** the other end of a min/max pair */
    pair?: { other: string; role: 'min' | 'max' };
}
export interface MaskDef extends Base {
    kind: 'mask';
    bits: number;
    def: number;
}
export interface ChoiceDef extends Base {
    kind: 'choice';
    choices: number[];
    def: number;
}
export type SettingDef = EnumDef | NumDef | MaskDef | ChoiceDef;

export const SCHEMA: SettingDef[] = [
    // Start
    { name: 'autostart_mode', group: 'start', since: '1.0', kind: 'enum', values: ['OFF', 'POWER', 'BUTTON'], def: 'POWER' },
    { name: 'autostart_delay', group: 'start', since: '1.0', kind: 'num', unit: 's', min: 0, max: 600, def: 10 },
    { name: 'autostart_ramp', group: 'start', since: '1.0', kind: 'num', unit: 'ds', min: 0, max: 6000, def: 100 },
    // Power
    { name: 'autostart_throttle', group: 'power', since: '1.0', kind: 'num', unit: 'pct', min: 0, max: 100, def: 15 },
    { name: 'autostart_throttle_limit', group: 'power', since: '1.1', kind: 'num', unit: 'pct', min: 1, max: 100, def: 100 },
    { name: 'autostart_run_time', group: 'power', since: '1.1', kind: 'num', unit: 's', min: 0, max: 65535, def: 0, zero: 'forever' },
    { name: 'autostart_pattern', group: 'power', since: '1.1', kind: 'enum', values: ['STEADY', 'GUSTS'], def: 'STEADY' },
    // Gusts
    { name: 'autostart_gust_min', group: 'gusts', since: '1.1', kind: 'num', unit: 'pct', min: 0, max: 100, def: 40, pair: { other: 'autostart_gust_max', role: 'min' } },
    { name: 'autostart_gust_max', group: 'gusts', since: '1.1', kind: 'num', unit: 'pct', min: 0, max: 100, def: 80, pair: { other: 'autostart_gust_min', role: 'max' } },
    { name: 'autostart_gust_len_min', group: 'gusts', since: '1.1', kind: 'num', unit: 'ms', min: 50, max: 10000, def: 300, pair: { other: 'autostart_gust_len_max', role: 'min' } },
    { name: 'autostart_gust_len_max', group: 'gusts', since: '1.1', kind: 'num', unit: 'ms', min: 50, max: 10000, def: 800, pair: { other: 'autostart_gust_len_min', role: 'max' } },
    { name: 'autostart_gust_pause_min', group: 'gusts', since: '1.1', kind: 'num', unit: 'ds', min: 0, max: 6000, def: 20, pair: { other: 'autostart_gust_pause_max', role: 'min' } },
    { name: 'autostart_gust_pause_max', group: 'gusts', since: '1.1', kind: 'num', unit: 'ds', min: 0, max: 6000, def: 80, pair: { other: 'autostart_gust_pause_min', role: 'max' } },
    // Battery
    { name: 'autostart_cells', group: 'battery', since: '1.1', kind: 'num', unit: 'cells', min: 0, max: 12, def: 6, zero: 'auto' },
    { name: 'autostart_cell_cutoff', group: 'battery', since: '1.1', kind: 'num', unit: 'cV', min: 0, max: 420, def: 330, zero: 'off', minNonZero: 250 },
    // Outputs & safety
    { name: 'autostart_motors', group: 'outputs', since: '1.0', kind: 'mask', bits: 8, def: 15 },
    { name: 'autostart_usb_inhibit', group: 'outputs', since: '1.0', kind: 'enum', values: ['OFF', 'ON'], def: 'OFF' },
    // Advanced
    { name: 'autostart_vbat_min', group: 'advanced', since: '1.0', kind: 'num', unit: 'dV', min: 0, max: 600, def: 60, zero: 'nocheck' },
    { name: 'autostart_cutoff_time', group: 'advanced', since: '1.1', kind: 'num', unit: 's', min: 1, max: 60, def: 5 },
    { name: 'autostart_box', group: 'advanced', since: '1.0', kind: 'choice', choices: [255, 40, 41, 42, 43], def: 255 },
    { name: 'vbat_scale', group: 'advanced', since: 'bf', kind: 'num', unit: 'raw', min: 10, max: 255, def: 210 }
];

export const DEF: Record<string, SettingDef> = Object.fromEntries(SCHEMA.map(d => [d.name, d]));

/** Read-only Betaflight values the tool looks at (not edited in the form). */
export const EXTRA_READS = ['debug_mode', 'dshot_bidir'] as const;

export const STATE_NAMES = ['IDLE', 'DELAY', 'RAMP', 'RUN', 'DONE', 'LOW_BATTERY'] as const;

// ---------- the board's view of a setting ----------

export interface Effective {
    def: SettingDef;
    /** present in the firmware on the board */
    present: boolean;
    min: number;
    max: number;
    values: string[];
    /** firmware default for this build (printed by the CLI, or equal to the current value) */
    boardDefault: Value;
}

const intersect = (a0: number, a1: number, b0?: number, b1?: number): [number, number] => {
    if (b0 === undefined || b1 === undefined) return [a0, a1];
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    return lo <= hi ? [lo, hi] : [b0, b1];
};

export const effective = (def: SettingDef, v?: CliVar): Effective => {
    let min = 0;
    let max = 0;
    let values: string[] = [];
    if (def.kind === 'num') [min, max] = intersect(def.min, def.max, v?.min, v?.max);
    else if (def.kind === 'mask') [min, max] = [1, 2 ** def.bits - 1];
    else if (def.kind === 'enum') values = v?.allowed?.length ? v.allowed.map(s => s.toUpperCase()) : def.values;
    let boardDefault: Value = def.def;
    if (v) boardDefault = fromCli(def, v.default ?? v.value) ?? def.def;
    return { def, present: !!v, min, max, values, boardDefault };
};

/** CLI text → typed value (undefined when it cannot be read). */
export const fromCli = (def: SettingDef, text: string): Value | undefined => {
    if (def.kind === 'enum') return text.trim().toUpperCase();
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? n : undefined;
};

export const toCli = (def: SettingDef, v: Value): string => (def.kind === 'enum' ? String(v).toUpperCase() : String(Math.round(Number(v))));

// ---------- validation ----------

export type NoteKind = 'clamped' | 'swapped' | 'rounded' | 'invalid' | 'mask-empty';
export interface Note {
    name: string;
    kind: NoteKind;
    from?: Value;
    to?: Value;
}

/** Make one value valid for the board (never throws; anything typed becomes something allowed). */
export const clampValue = (e: Effective, input: unknown, notes?: Note[]): Value => {
    const d = e.def;
    const note = (kind: NoteKind, from: unknown, to: Value) => notes?.push({ name: d.name, kind, from: from as Value, to });
    if (d.kind === 'enum') {
        const s = String(input ?? '').trim().toUpperCase();
        if (e.values.includes(s)) return s;
        const to = String(e.values.includes(String(e.boardDefault)) ? e.boardDefault : e.values[0]);
        note('invalid', input, to);
        return to;
    }
    let n = typeof input === 'number' ? input : parseFloat(String(input ?? '').replace(',', '.'));
    if (!Number.isFinite(n)) {
        const to = Number(e.boardDefault);
        note('invalid', input, to);
        return to;
    }
    const r = Math.round(n);
    if (r !== n) note('rounded', n, r);
    n = r;
    if (d.kind === 'choice') {
        if (d.choices.includes(n)) return n;
        note('invalid', input, 255);
        return 255;
    }
    if (d.kind === 'mask') {
        const m = n & (2 ** d.bits - 1);
        if (m === 0) {
            note('mask-empty', input, 1);
            return 1;
        }
        if (m !== n) note('clamped', n, m);
        return m;
    }
    let c = Math.min(e.max, Math.max(e.min, n));
    if (d.minNonZero && c > 0 && c < d.minNonZero) c = d.minNonZero;
    if (c !== n) note('clamped', n, c);
    return c;
};

/** Validate a whole set of values: clamp each, then swap min/max pairs that are the wrong way round. */
export const normalize = (eff: Record<string, Effective>, values: Record<string, Value>): { values: Record<string, Value>; notes: Note[] } => {
    const notes: Note[] = [];
    const out: Record<string, Value> = {};
    for (const [name, v] of Object.entries(values)) {
        const e = eff[name];
        out[name] = e ? clampValue(e, v, notes) : v;
    }
    for (const d of SCHEMA) {
        if (d.kind !== 'num' || d.pair?.role !== 'min') continue;
        const a = out[d.name];
        const b = out[d.pair.other];
        if (typeof a === 'number' && typeof b === 'number' && a > b) {
            out[d.name] = b;
            out[d.pair.other] = a;
            notes.push({ name: d.name, kind: 'swapped', from: a, to: b });
        }
    }
    return { values: out, notes };
};

/** Changed values only (normalized), in schema order. */
export const diff = (board: Record<string, Value>, edited: Record<string, Value>): Record<string, Value> => {
    const out: Record<string, Value> = {};
    const names = [...SCHEMA.map(d => d.name), ...Object.keys(edited).filter(k => !DEF[k])];
    for (const k of names) {
        if (!(k in edited) || !(k in board)) continue;
        if (String(edited[k]).toUpperCase() !== String(board[k]).toUpperCase()) out[k] = edited[k];
    }
    return out;
};

// ---------- units ----------

const SCALE: Record<Unit, number> = { s: 1, ds: 10, ms: 1000, pct: 1, cV: 100, dV: 10, cells: 1, raw: 1 };
const DECIMALS: Record<Unit, number> = { s: 0, ds: 1, ms: 2, pct: 0, cV: 2, dV: 1, cells: 0, raw: 0 };

export const unitScale = (u: Unit) => SCALE[u];
export const unitDecimals = (u: Unit) => DECIMALS[u];
/** raw integer → number shown in the form */
export const toDisplay = (d: NumDef, raw: number) => raw / SCALE[d.unit];
/** number typed in the form → raw integer (rounded) */
export const fromDisplay = (d: NumDef, shown: number) => Math.round(shown * SCALE[d.unit]);
export const displayStep = (d: NumDef) => (d.unit === 'ms' ? 0.05 : 1 / SCALE[d.unit]);

// ---------- the simple panel and the "More settings" drawer ----------

/** The five questions of the simple panel (Step 3), in order. */
export const SIMPLE = ['autostart_delay', 'autostart_throttle', 'autostart_run_time', 'autostart_pattern', 'autostart_cells'];

/** Quick-pick chips of the simple questions (raw values); any other value is shown under "Other". */
export const CHIP_VALUES: Record<string, number[]> = {
    autostart_delay: [5, 10, 30, 60],
    autostart_throttle: [15, 30, 50, 80],
    autostart_cells: [3, 4, 6, 8]
};

export type MoreId = 'start' | 'gusts' | 'battery' | 'outputs' | 'expert';
export const MORE_IDS: MoreId[] = ['start', 'gusts', 'battery', 'outputs', 'expert'];

export const GUST_KEYS = ['autostart_gust_min', 'autostart_gust_max', 'autostart_gust_len_min', 'autostart_gust_len_max', 'autostart_gust_pause_min', 'autostart_gust_pause_max'];

/** Fieldsets of the drawer. Battery also holds the "count cells automatically" switch of autostart_cells (its number is on the panel). */
export const MORE: Record<MoreId, string[]> = {
    start: ['autostart_mode', 'autostart_ramp', 'autostart_throttle_limit'],
    gusts: GUST_KEYS,
    battery: ['autostart_cell_cutoff', 'autostart_cutoff_time'],
    outputs: ['autostart_motors', 'autostart_usb_inhibit'],
    expert: ['autostart_vbat_min', 'autostart_box', 'vbat_scale']
};

/** Drawer fieldset that holds a setting (null for the simple panel). */
export const moreOf = (name: string): MoreId | null => MORE_IDS.find(id => MORE[id].includes(name)) ?? null;

const same = (a: Value | undefined, b: Value | undefined) => String(a).toUpperCase() === String(b).toUpperCase();

/** Safety-relevant values: when present they open the drawer by themselves (and are named in amber). */
const ATTENTION: [string, (v: Value, e: Effective) => boolean][] = [
    ['autostart_mode', v => !same(v, 'POWER')],
    ['autostart_cells', v => Number(v) === 0],
    ['autostart_cell_cutoff', v => Number(v) === 0],
    ['autostart_motors', v => (Number(v) & 1) === 0],
    ['autostart_usb_inhibit', (v, e) => !same(v, e.boardDefault)],
    ['autostart_vbat_min', v => Number(v) === 0],
    ['autostart_cutoff_time', v => Number(v) > 10],
    ['autostart_box', v => Number(v) !== 255]
];

/** Names (schema order) of the values that need a look: no cut-off, cells automatic, no battery wait, USB rule changed, motor 1 off, start ≠ battery, a long cut-off wait, an RC switch. */
export const attention = (values: Record<string, Value>, eff: Record<string, Effective>): string[] => {
    const hit = new Set(ATTENTION.filter(([k, test]) => eff[k]?.present && k in values && test(values[k], eff[k])).map(([k]) => k));
    return SCHEMA.map(d => d.name).filter(k => hit.has(k));
};

/** Maximum power below 100 %: a badge on the closed drawer (no auto-open). */
export const capOf = (values: Record<string, Value>, eff: Record<string, Effective>): number | null => {
    if (!eff.autostart_throttle_limit?.present) return null;
    const v = Number(values.autostart_throttle_limit);
    return Number.isFinite(v) && v < 100 ? v : null;
};

/** Hidden values (inside the drawer) that differ from THIS build's default, minus the attention list and the cap badge. */
export const hiddenDiffs = (values: Record<string, Value>, eff: Record<string, Effective>): string[] => {
    const skip = new Set(attention(values, eff));
    if (capOf(values, eff) !== null) skip.add('autostart_throttle_limit');
    const hidden = new Set(MORE_IDS.flatMap(id => MORE[id]));
    return SCHEMA.map(d => d.name).filter(k => hidden.has(k) && !skip.has(k) && eff[k]?.present && k in values && !same(values[k], eff[k].boardDefault));
};

// ---------- gusts ----------

/** The owner's gust recipe: 50–90 %, 0.2–0.6 s long, every 1.5–6 s (only the 6 gust settings). */
export const SUGGESTED_GUSTS: Record<string, number> = {
    autostart_gust_min: 50,
    autostart_gust_max: 90,
    autostart_gust_len_min: 200,
    autostart_gust_len_max: 600,
    autostart_gust_pause_min: 15,
    autostart_gust_pause_max: 60
};
/** Power between gusts that goes with the recipe; offered separately, never applied with it. */
export const SUGGESTED_GUST_POWER = 20;

/** The suggested gust mix for the settings this board has; null when it has no gusts (firmware 1.0). */
export const gustMix = (eff: Record<string, Effective>): Record<string, Value> | null => {
    if (!eff.autostart_pattern?.present || !eff.autostart_pattern.values.includes('GUSTS')) return null;
    const out: Record<string, Value> = {};
    for (const [k, v] of Object.entries(SUGGESTED_GUSTS)) if (eff[k]?.present) out[k] = v;
    return out;
};

export type PresetId = 'steady' | 'gusts';

/**
 * Presets change only the pattern and the shape of the gusts — never Power, Maximum power or How long
 * (until 2026-10-20 they reset autostart_throttle, _throttle_limit and _run_time to the defaults).
 */
export const PRESET_KEYS = ['autostart_pattern', ...GUST_KEYS];

/** Steady = gusts off; Gusts = gusts on with the suggested mix. null when the board cannot do it (no gusts in 1.0). */
export const presetValues = (id: PresetId, eff: Record<string, Effective>): Record<string, Value> | null => {
    if (!eff.autostart_pattern?.present) return null;
    if (id === 'steady') return { autostart_pattern: 'STEADY' };
    const mix = gustMix(eff);
    return mix ? { autostart_pattern: 'GUSTS', ...mix } : null;
};

// ---------- run time as minutes + seconds ----------

export const RUN_TIME_MAX = 65535;

/** Seconds → minutes and seconds (0–59). */
export const splitMinSec = (total: number): { min: number; sec: number } => {
    const t = Number.isFinite(total) ? Math.min(RUN_TIME_MAX, Math.max(0, Math.round(total))) : 0;
    return { min: Math.floor(t / 60), sec: t % 60 };
};

/** Minutes + seconds → a run time the board accepts: seconds clamped to 0–59, the total to 1–65535 s. */
export const joinMinSec = (min: number, sec: number): number => {
    const m = Number.isFinite(min) ? Math.max(0, Math.round(min)) : 0;
    const s = Number.isFinite(sec) ? Math.min(59, Math.max(0, Math.round(sec))) : 0;
    return Math.min(RUN_TIME_MAX, Math.max(1, m * 60 + s));
};

// ---------- the program in words ----------

/** The firmware never drives the motor before the ESC has had this long of stop frames (AUTOSTART_MIN_UPTIME_MS). */
export const MIN_START_S = 3;

export type ProgramRow = 'start' | 'power' | 'cap' | 'run' | 'usb' | 'rc';
export interface ProgramLine {
    row: ProgramRow;
    /** string key under tool.prog. */
    key: string;
    /** numbers for the text: delay/ramp/t/time in s, pct/lo/hi/limit/thr in %, v/cut in V, n cells */
    vars: Record<string, number>;
    tone?: 'warn' | 'bad';
}

/**
 * What the board does with these values, line by line, exactly as the firmware runs it
 * (docs/settings.md + patches/0001: programStart(), batteryCutoffReached(), escHadTimeToArm()):
 * the delay counts from the battery (or the click) but nothing spins before the ESC had 3 s of power;
 * the ramp goes to min(Power, Maximum power); gust peaks lie in min(Maximum power, max(Power, gust min … max));
 * run time counts after the ramp; the battery stop fires after cells × cut-off stayed low for cut-off time s,
 * in every running state. Firmware 1.0 has no cut-off, run time, gusts or maximum power.
 */
export const describeProgram = (values: Record<string, Value>, level: '1.0' | '1.1' | null): ProgramLine[] => {
    const num = (k: string): number => {
        const n = typeof values[k] === 'number' ? (values[k] as number) : parseInt(String(values[k] ?? ''), 10);
        return Number.isFinite(n) ? n : Number(DEF[k].def);
    };
    const str = (k: string) => String(values[k] ?? DEF[k].def).toUpperCase();
    const v11 = level !== '1.0';
    const mode = str('autostart_mode');
    if (mode === 'OFF') return [{ row: 'start', key: 'start.off', vars: {}, tone: 'warn' }];
    const out: ProgramLine[] = [];
    const delay = num('autostart_delay');
    const tooSoon = delay < MIN_START_S ? 'Min' : '';
    if (mode === 'BUTTON') out.push({ row: 'start', key: 'start.button', vars: { delay } });
    else out.push({ row: 'start', key: `start.${num('autostart_vbat_min') === 0 ? 'always' : 'power'}${tooSoon}`, vars: { delay } });

    const limit = v11 ? Math.min(100, Math.max(1, num('autostart_throttle_limit'))) : 100;
    const thr = num('autostart_throttle');
    const pct = Math.min(thr, limit);
    const ramp = num('autostart_ramp') / 10;
    const gusts = v11 && str('autostart_pattern') === 'GUSTS';
    const gLo = Math.min(num('autostart_gust_min'), num('autostart_gust_max'));
    const gHi = Math.max(num('autostart_gust_min'), num('autostart_gust_max'));
    const vars: Record<string, number> = { ramp, pct };
    // the firmware raises both gust ends to Power (programStart: gustMin = MAX(MIN(min, max), throttle)) and
    // caps every output at Maximum power
    const lo = Math.min(limit, Math.max(thr, gLo));
    const hi = Math.min(limit, Math.max(thr, gHi));
    // every gust the same: "gusts at N %", or "capped at N % by Maximum power" when the cap made them so
    const shape = !gusts ? 'steady' : lo < hi ? 'gusts' : Math.max(thr, gHi) > limit ? 'gustsCap' : 'gustsOne';
    if (gusts) Object.assign(vars, { lo, hi });
    out.push({ row: 'power', key: `power.${shape}${ramp > 0 ? '' : 'Now'}`, vars });
    if (limit < 100) out.push({ row: 'cap', key: 'cap', vars: { limit, thr }, tone: thr > limit || (gusts && gHi > limit) ? 'warn' : undefined });

    if (!v11) out.push({ row: 'run', key: 'run.fw10', vars: {}, tone: 'bad' });
    else {
        const cutCv = num('autostart_cell_cutoff');
        const cells = num('autostart_cells');
        const run = num('autostart_run_time');
        const prot = cutCv === 0 ? 'Off' : cells === 0 ? 'Auto' : '';
        const low: Record<string, string> = { Off: 'run.off', Auto: 'run.lowAuto', '': 'run.low' };
        const key = run === 0 ? low[prot] : `run.time${prot}`;
        const rv: Record<string, number> = { cut: cutCv / 100, t: num('autostart_cutoff_time'), n: cells, time: run };
        if (cells > 0 && cutCv > 0) rv.v = (cells * cutCv) / 100;
        out.push({ row: 'run', key, vars: rv, tone: prot === 'Off' ? 'bad' : prot === 'Auto' ? 'warn' : undefined });
    }
    if (str('autostart_usb_inhibit') === 'ON') out.push({ row: 'usb', key: 'usb', vars: {}, tone: 'warn' });
    const box = num('autostart_box');
    if (box >= 40 && box <= 43) out.push({ row: 'rc', key: 'rc', vars: { n: box - 39 } });
    return out;
};

// ---------- the cell count against the live voltage ----------

/** Volts per cell a LiPo shows at rest, roughly empty to full. */
export const CELL_REST_MIN = 3.0;
export const CELL_REST_MAX = 4.35;
const FIT_ORDER = [3, 4, 6, 8, 1, 2, 5, 7, 9, 10, 11, 12];

/**
 * Does the live voltage fit the chosen cell count? null without a battery (under 6 V) or without a count.
 * When it does not, `guess` is the first count (common packs first) that fits — a suggestion, never applied by itself.
 */
export const cellFit = (volts: number, cells: number): { fits: boolean; perCell: number; guess: number | null } | null => {
    if (!(volts >= 6) || !(cells > 0)) return null;
    const ok = (n: number) => volts / n >= CELL_REST_MIN && volts / n <= CELL_REST_MAX;
    const fits = ok(cells);
    return { fits, perCell: volts / cells, guess: fits ? null : FIT_ORDER.find(ok) ?? null };
};

/** Board defaults for every present setting except the voltage calibration. */
export const defaultValues = (eff: Record<string, Effective>): Record<string, Value> => {
    const out: Record<string, Value> = {};
    for (const [k, e] of Object.entries(eff)) if (e.present && k !== 'vbat_scale') out[k] = e.boardDefault;
    return out;
};

// ---------- battery ----------

export type CalibrationResult = { ok: true; scale: number; clamped: boolean } | { ok: false; reason: 'no-reading' | 'bad-input' };

/** New vbat_scale from a multimeter reading: old × real / shown, clamped to 10–255. */
export const calibrateVbatScale = (oldScale: number, realVolts: number, shownVolts: number): CalibrationResult => {
    if (!Number.isFinite(shownVolts) || shownVolts < 1) return { ok: false, reason: 'no-reading' };
    if (!Number.isFinite(realVolts) || realVolts <= 0 || !Number.isFinite(oldScale) || oldScale <= 0) return { ok: false, reason: 'bad-input' };
    const raw = Math.round((oldScale * realVolts) / shownVolts);
    const scale = Math.min(255, Math.max(10, raw));
    return { ok: true, scale, clamped: scale !== raw };
};

/** Cut-off voltage of the whole pack, or null when off / cell count unknown. */
export const cutoffVolts = (cellCutoff: number, cells: number) => (cellCutoff > 0 && cells > 0 ? (cellCutoff * cells) / 100 : null);

/** True when a setting matters for the current pattern (gust fields only for GUSTS). */
export const isRelevant = (name: string, values: Record<string, Value>) => {
    if (DEF[name]?.group === 'gusts') return values.autostart_pattern === 'GUSTS';
    if (name === 'autostart_cutoff_time') return values.autostart_cell_cutoff !== 0;
    return true;
};
