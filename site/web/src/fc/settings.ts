// Typed schema of the autostart settings, written by hand from docs/settings.md (firmware 1.1),
// plus validation (clamping, min/max swap), unit conversion, presets and the diff against the board.
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

// ---------- presets ----------

export type PresetId = 'steady' | 'gusts';

/** Presets touch only the throttle pattern (Power + Gusts groups), never start, battery or outputs. */
export const PRESET_KEYS = [
    'autostart_throttle',
    'autostart_throttle_limit',
    'autostart_run_time',
    'autostart_pattern',
    'autostart_gust_min',
    'autostart_gust_max',
    'autostart_gust_len_min',
    'autostart_gust_len_max',
    'autostart_gust_pause_min',
    'autostart_gust_pause_max'
];

const GUSTS: Record<string, Value> = {
    autostart_pattern: 'GUSTS',
    autostart_throttle: 20,
    autostart_gust_min: 50,
    autostart_gust_max: 90,
    autostart_gust_len_min: 200,
    autostart_gust_len_max: 600,
    autostart_gust_pause_min: 15,
    autostart_gust_pause_max: 60
};

/** Values of a preset for the settings the board has; null when the board cannot do it (no gusts in 1.0). */
export const presetValues = (id: PresetId, eff: Record<string, Effective>): Record<string, Value> | null => {
    const out: Record<string, Value> = {};
    for (const k of PRESET_KEYS) if (eff[k]?.present) out[k] = eff[k].boardDefault;
    if (id === 'steady') {
        if (eff.autostart_pattern?.present) out.autostart_pattern = 'STEADY';
        return out;
    }
    if (!eff.autostart_pattern?.present || !eff.autostart_pattern.values.includes('GUSTS')) return null;
    for (const [k, v] of Object.entries(GUSTS)) if (eff[k]?.present) out[k] = v;
    return out;
};

export const matchPreset = (values: Record<string, Value>, eff: Record<string, Effective>): PresetId | null => {
    for (const id of ['steady', 'gusts'] as PresetId[]) {
        const p = presetValues(id, eff);
        if (p && Object.keys(p).length && Object.entries(p).every(([k, v]) => String(values[k]) === String(v))) return id;
    }
    return null;
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
export const cutoffVolts = (cellCutoff: number, cells: number) => (cellCutoff > 0 && cells > 0 ? (cellCutoff / 100) * cells : null);

/** True when a setting matters for the current pattern (gust fields only for GUSTS). */
export const isRelevant = (name: string, values: Record<string, Value>) => {
    if (DEF[name]?.group === 'gusts') return values.autostart_pattern === 'GUSTS';
    if (name === 'autostart_cutoff_time') return values.autostart_cell_cutoff !== 0;
    return true;
};
