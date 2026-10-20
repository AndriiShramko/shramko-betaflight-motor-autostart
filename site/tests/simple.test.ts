// The simple panel and its drawer (fc/settings.ts): the program in words against the firmware, minutes + seconds,
// the drawer's attention list / not-default list / cap badge, the cell-count check, and the gust recipe
// that must never touch Power, Maximum power or How long (negative control for the old PRESET_KEYS bug).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    CHIP_VALUES,
    DEF,
    MORE,
    MORE_IDS,
    SCHEMA,
    SIMPLE,
    attention,
    capOf,
    cellFit,
    describeProgram,
    effective,
    gustMix,
    hiddenDiffs,
    joinMinSec,
    moreOf,
    presetValues,
    splitMinSec,
    type Effective,
    type NumDef,
    type ProgramLine,
    type Value
} from '../web/src/fc/settings.ts';

const en = JSON.parse(readFileSync(new URL('../web/src/i18n/tool.en.json', import.meta.url), 'utf8')) as Record<string, string>;

/** a board whose CLI reports `boardValues` (default value = the current value, like the project build) */
const board = (boardValues: Record<string, Value> = {}, present = SCHEMA.map(d => d.name)): Record<string, Effective> =>
    Object.fromEntries(SCHEMA.map(d => [d.name, effective(d, present.includes(d.name) ? { name: d.name, value: String(boardValues[d.name] ?? d.def) } : undefined)]));
const defaults = (): Record<string, Value> => Object.fromEntries(SCHEMA.map(d => [d.name, d.def]));
const prog = (over: Record<string, Value> = {}, level: '1.0' | '1.1' = '1.1') => describeProgram({ ...defaults(), ...over }, level);
const line = (lines: ProgramLine[], row: string) => lines.find(l => l.row === row);
const seen: ProgramLine[] = [];
const keep = (lines: ProgramLine[]) => (seen.push(...lines), lines);

test('program: the factory defaults (10 s after the battery, 10 s to 15 %, battery stop 19.8 V after 5 s)', () => {
    const p = keep(prog());
    assert.deepEqual(p.map(l => l.row), ['start', 'power', 'run']);
    assert.deepEqual(line(p, 'start'), { row: 'start', key: 'start.power', vars: { delay: 10 } });
    assert.deepEqual(line(p, 'power'), { row: 'power', key: 'power.steady', vars: { ramp: 10, pct: 15 } });
    const run = line(p, 'run')!;
    assert.equal(run.key, 'run.low');
    assert.deepEqual([run.vars.v, run.vars.n, run.vars.cut, run.vars.t], [19.8, 6, 3.3, 5]);
    assert.equal(run.tone, undefined);
});

test('program: the start — 3 s minimum after the ESC gets power, no battery wait, button, off', () => {
    assert.equal(line(keep(prog({ autostart_delay: 2 })), 'start')!.key, 'start.powerMin');
    assert.equal(line(keep(prog({ autostart_delay: 3 })), 'start')!.key, 'start.power');
    assert.equal(line(keep(prog({ autostart_vbat_min: 0 })), 'start')!.key, 'start.always');
    assert.equal(line(keep(prog({ autostart_vbat_min: 0, autostart_delay: 0 })), 'start')!.key, 'start.alwaysMin');
    const b = keep(prog({ autostart_mode: 'BUTTON', autostart_delay: 0 }));
    assert.deepEqual(line(b, 'start'), { row: 'start', key: 'start.button', vars: { delay: 0 } });
    const off = keep(prog({ autostart_mode: 'OFF', autostart_pattern: 'GUSTS', autostart_cell_cutoff: 0 }));
    assert.deepEqual(off, [{ row: 'start', key: 'start.off', vars: {}, tone: 'warn' }], 'OFF never starts: nothing else is promised');
});

test('program: speed-up in seconds, straight to the power without a ramp', () => {
    assert.deepEqual(line(keep(prog({ autostart_ramp: 25 })), 'power')!.vars, { ramp: 2.5, pct: 15 });
    assert.deepEqual(line(keep(prog({ autostart_ramp: 0 })), 'power'), { row: 'power', key: 'power.steadyNow', vars: { ramp: 0, pct: 15 } });
    assert.equal(line(keep(prog({ autostart_ramp: 0, autostart_pattern: 'GUSTS' })), 'power')!.key, 'power.gustsNow');
});

test('program: gusts — peak = min(maximum power, max(power, gust max)), swapped min/max, the cap', () => {
    const g = keep(prog({ autostart_pattern: 'GUSTS' }));
    assert.deepEqual(line(g, 'power')!.vars, { ramp: 10, pct: 15, lo: 40, hi: 80 });
    assert.equal(line(g, 'cap'), undefined, 'no cap line at 100 %');
    const capped = keep(prog({ autostart_pattern: 'GUSTS', autostart_gust_min: 50, autostart_gust_max: 90, autostart_throttle_limit: 60 }));
    assert.deepEqual([line(capped, 'power')!.vars.lo, line(capped, 'power')!.vars.hi], [50, 60]);
    assert.deepEqual(line(capped, 'cap'), { row: 'cap', key: 'cap', vars: { limit: 60, thr: 15 }, tone: 'warn' });
    const swapped = keep(prog({ autostart_pattern: 'GUSTS', autostart_gust_min: 90, autostart_gust_max: 50 }));
    assert.deepEqual([line(swapped, 'power')!.vars.lo, line(swapped, 'power')!.vars.hi], [50, 90]);
    const below = keep(prog({ autostart_pattern: 'GUSTS', autostart_throttle: 50, autostart_gust_min: 20, autostart_gust_max: 30 }));
    assert.equal(line(below, 'power')!.vars.hi, 50, 'the steady power is the highest output when every gust is weaker');
});

test('program: gusts never dip below Power (firmware raises the gust floor), every gust the same gets its own line', () => {
    // Power 50 % chip + gusts On with the default 40–80: the firmware gives 50–80, not 40–80
    const p50 = line(keep(prog({ autostart_pattern: 'GUSTS', autostart_throttle: 50 })), 'power')!;
    assert.deepEqual([p50.key, p50.vars.lo, p50.vars.hi], ['power.gusts', 50, 80]);
    // Power 30, Maximum power 40, the suggested mix (50–90): every gust is capped at 40 %
    const capped = line(keep(prog({ autostart_pattern: 'GUSTS', autostart_throttle: 30, autostart_throttle_limit: 40, autostart_gust_min: 50, autostart_gust_max: 90 })), 'power')!;
    assert.deepEqual([capped.key, capped.vars.lo, capped.vars.hi, capped.vars.pct], ['power.gustsCap', 40, 40, 30]);
    assert.equal(line(keep(prog({ autostart_pattern: 'GUSTS', autostart_throttle: 30, autostart_throttle_limit: 40, autostart_gust_min: 50, autostart_gust_max: 90, autostart_ramp: 0 })), 'power')!.key, 'power.gustsCapNow');
    // gusts weaker than Power: the firmware runs them at Power (60–60), no "random gusts of 20–60 %"
    const weak = line(keep(prog({ autostart_pattern: 'GUSTS', autostart_throttle: 60, autostart_gust_min: 20, autostart_gust_max: 40 })), 'power')!;
    assert.deepEqual([weak.key, weak.vars.lo, weak.vars.hi], ['power.gustsOne', 60, 60]);
    assert.equal(line(keep(prog({ autostart_pattern: 'GUSTS', autostart_gust_min: 70, autostart_gust_max: 70, autostart_ramp: 0 })), 'power')!.key, 'power.gustsOneNow');
    // negative control: a real range stays a range
    assert.equal(line(keep(prog({ autostart_pattern: 'GUSTS', autostart_throttle: 20 })), 'power')!.key, 'power.gusts');
});

test('program: maximum power caps the steady power too; a cap that does not bite is not a warning', () => {
    const p = keep(prog({ autostart_throttle: 30, autostart_throttle_limit: 20 }));
    assert.equal(line(p, 'power')!.vars.pct, 20);
    assert.equal(line(p, 'cap')!.tone, 'warn');
    const loose = keep(prog({ autostart_throttle_limit: 80 }));
    assert.deepEqual(line(loose, 'cap'), { row: 'cap', key: 'cap', vars: { limit: 80, thr: 15 }, tone: undefined });
});

test('program: how long — run time after the ramp, battery stop, automatic cells, no protection', () => {
    const timed = line(keep(prog({ autostart_run_time: 120 })), 'run')!;
    assert.deepEqual([timed.key, timed.vars.time, timed.vars.v, timed.tone], ['run.time', 120, 19.8, undefined]);
    const auto = line(keep(prog({ autostart_cells: 0 })), 'run')!;
    assert.deepEqual([auto.key, auto.tone, 'v' in auto.vars], ['run.lowAuto', 'warn', false]);
    assert.equal(line(keep(prog({ autostart_cells: 0, autostart_run_time: 60 })), 'run')!.key, 'run.timeAuto');
    const off = line(keep(prog({ autostart_cell_cutoff: 0 })), 'run')!;
    assert.deepEqual([off.key, off.tone], ['run.off', 'bad']);
    const offTimed = line(keep(prog({ autostart_cell_cutoff: 0, autostart_run_time: 90 })), 'run')!;
    assert.deepEqual([offTimed.key, offTimed.tone, offTimed.vars.time], ['run.timeOff', 'bad', 90]);
    assert.equal(line(keep(prog({ autostart_cutoff_time: 20 })), 'run')!.vars.t, 20);
    assert.equal(line(keep(prog({ autostart_cells: 8, autostart_cell_cutoff: 350 })), 'run')!.vars.v, 28);
});

test('program: USB inhibit and the RC switch are named; firmware 1.0 promises no cut-off, run time, gusts or cap', () => {
    const usb = keep(prog({ autostart_usb_inhibit: 'ON' }));
    assert.deepEqual(line(usb, 'usb'), { row: 'usb', key: 'usb', vars: {}, tone: 'warn' });
    assert.deepEqual(line(keep(prog({ autostart_box: 41 })), 'rc'), { row: 'rc', key: 'rc', vars: { n: 2 } });
    assert.equal(line(prog({ autostart_box: 255 }), 'rc'), undefined);
    const v10 = Object.fromEntries(SCHEMA.filter(d => d.since !== '1.1').map(d => [d.name, d.def]));
    const p = keep(describeProgram({ ...v10, autostart_pattern: 'GUSTS', autostart_throttle_limit: 10, autostart_throttle: 40 }, '1.0'));
    assert.deepEqual(p.map(l => l.key), ['start.power', 'power.steady', 'run.fw10']);
    assert.equal(line(p, 'power')!.vars.pct, 40);
    assert.equal(line(p, 'run')!.tone, 'bad');
});

test('program: every key and row has an English text with the placeholders it gets', () => {
    assert.ok(seen.length > 30);
    for (const l of seen) {
        const s = en[`tool.prog.${l.key}`];
        assert.ok(s, `tool.prog.${l.key}`);
        assert.ok(en[`tool.prog.row.${l.row}`], `tool.prog.row.${l.row}`);
        for (const m of s.matchAll(/\{(\w+)\}/g)) assert.ok(m[1] in l.vars, `tool.prog.${l.key} needs {${m[1]}}`);
    }
});

test('run time minutes + seconds: split, join, clamp 1–65535 s, seconds 0–59', () => {
    assert.deepEqual(splitMinSec(0), { min: 0, sec: 0 });
    assert.deepEqual(splitMinSec(59), { min: 0, sec: 59 });
    assert.deepEqual(splitMinSec(125), { min: 2, sec: 5 });
    assert.deepEqual(splitMinSec(65535), { min: 1092, sec: 15 });
    assert.deepEqual(splitMinSec(70000), { min: 1092, sec: 15 });
    assert.deepEqual(splitMinSec(-5), { min: 0, sec: 0 });
    assert.deepEqual(splitMinSec(NaN), { min: 0, sec: 0 });
    assert.equal(joinMinSec(2, 5), 125);
    assert.equal(joinMinSec(0, 0), 1, 'never 0: that is "until the battery is low", a different choice');
    assert.equal(joinMinSec(1, 75), 119, 'seconds clamp to 59');
    assert.equal(joinMinSec(0, -3), 1);
    assert.equal(joinMinSec(1092, 59), 65535);
    assert.equal(joinMinSec(5000, 0), 65535);
    assert.equal(joinMinSec(NaN, 30), 30, 'an empty minutes box counts as 0');
    assert.equal(joinMinSec(1.4, 0.6), 61);
    for (const t of [1, 59, 60, 61, 90, 3599, 3600, 65535]) assert.equal(joinMinSec(splitMinSec(t).min, splitMinSec(t).sec), t);
});

test('drawer: attention list — every safety-relevant case, against THIS build’s defaults; all defaults → empty', () => {
    const e = board();
    assert.deepEqual(attention(defaults(), e), [], 'negative control: factory values need no look');
    const cases: [string, Value][] = [
        ['autostart_cell_cutoff', 0],
        ['autostart_cells', 0],
        ['autostart_vbat_min', 0],
        ['autostart_usb_inhibit', 'ON'],
        ['autostart_motors', 14],
        ['autostart_mode', 'BUTTON'],
        ['autostart_mode', 'OFF'],
        ['autostart_cutoff_time', 11],
        ['autostart_box', 40]
    ];
    for (const [k, v] of cases) assert.deepEqual(attention({ ...defaults(), [k]: v }, e), [k], `${k} = ${v}`);
    for (const [k, v] of [['autostart_cutoff_time', 10], ['autostart_motors', 1], ['autostart_box', 255], ['autostart_cells', 8]] as [string, Value][])
        assert.deepEqual(attention({ ...defaults(), [k]: v }, e), [], `${k} = ${v} is fine`);
    // usb_inhibit: a build whose default is ON (generic builds) needs no look at ON, but at OFF
    const generic = board({ autostart_usb_inhibit: 'ON' });
    assert.deepEqual(attention({ ...defaults(), autostart_usb_inhibit: 'ON' }, generic), []);
    assert.deepEqual(attention({ ...defaults(), autostart_usb_inhibit: 'OFF' }, generic), ['autostart_usb_inhibit']);
    assert.deepEqual(attention({ ...defaults(), autostart_box: 41, autostart_cell_cutoff: 0, autostart_mode: 'OFF' }, e), ['autostart_mode', 'autostart_cell_cutoff', 'autostart_box'], 'schema order');
});

test('drawer: not-default list names hidden values only (minus attention and the cap badge)', () => {
    const e = board();
    assert.deepEqual(hiddenDiffs(defaults(), e), []);
    assert.deepEqual(hiddenDiffs({ ...defaults(), autostart_ramp: 200, autostart_gust_min: 50 }, e), ['autostart_ramp', 'autostart_gust_min']);
    assert.deepEqual(hiddenDiffs({ ...defaults(), autostart_delay: 5, autostart_throttle: 30 }, e), [], 'simple questions are visible anyway');
    assert.deepEqual(hiddenDiffs({ ...defaults(), autostart_cell_cutoff: 0 }, e), [], 'named in the attention list instead');
    assert.deepEqual(hiddenDiffs({ ...defaults(), autostart_throttle_limit: 40 }, e), [], 'shown as the badge instead');
    assert.equal(capOf({ ...defaults(), autostart_throttle_limit: 40 }, e), 40);
    assert.equal(capOf(defaults(), e), null);
    // compared with the board's default, not the schema's: a calibrated board's vbat_scale is its default
    const calibrated = board({ vbat_scale: 250 });
    assert.deepEqual(hiddenDiffs({ ...defaults(), vbat_scale: 250 }, calibrated), []);
    assert.deepEqual(hiddenDiffs({ ...defaults(), vbat_scale: 250 }, e), ['vbat_scale']);
});

test('panel + drawer hold every setting exactly once; chips sit inside the ranges', () => {
    const all = [...SIMPLE, ...MORE_IDS.flatMap(id => MORE[id])];
    assert.deepEqual([...all].sort(), SCHEMA.map(d => d.name).sort());
    assert.equal(new Set(all).size, all.length);
    assert.equal(moreOf('autostart_delay'), null);
    assert.equal(moreOf('autostart_ramp'), 'start');
    assert.equal(moreOf('vbat_scale'), 'expert');
    for (const [k, chips] of Object.entries(CHIP_VALUES)) {
        assert.ok(SIMPLE.includes(k));
        const d = DEF[k] as NumDef;
        for (const c of chips) assert.ok(c >= d.min && c <= d.max && c !== 0, `${k} chip ${c}`);
    }
});

test('cell count vs the live voltage: fits, a suggestion when it does not, nothing without a battery', () => {
    assert.deepEqual(cellFit(24.4, 6)?.fits, true);
    assert.deepEqual(cellFit(21.0, 6)?.fits, true, 'a half-empty 6S still fits 6S');
    const big = cellFit(33.6, 6)!;
    assert.deepEqual([big.fits, big.guess], [false, 8]);
    assert.equal(cellFit(29.6, 6)!.guess, 8, 'common pack sizes first');
    assert.equal(cellFit(12.6, 6)!.guess, 3);
    assert.equal(cellFit(4.8, 6), null, 'USB back-feed is no battery');
    assert.equal(cellFit(24, 0), null, 'automatic count: nothing to check');
});

test('negative control for the old PRESET_KEYS bug: saved Power 30, Maximum power 40, run time 120 survive gusts On and the mix', () => {
    const e = board({ autostart_throttle: 30, autostart_throttle_limit: 40, autostart_run_time: 120 });
    const saved = { ...defaults(), autostart_throttle: 30, autostart_throttle_limit: 40, autostart_run_time: 120 };
    const edited: Record<string, Value> = { ...saved, autostart_pattern: 'GUSTS' }; // the Random gusts switch
    Object.assign(edited, gustMix(e)); // "Use the suggested gust mix"
    assert.deepEqual([edited.autostart_throttle, edited.autostart_throttle_limit, edited.autostart_run_time], [30, 40, 120]);
    assert.deepEqual(Object.keys(gustMix(e)!).sort(), ['autostart_gust_len_max', 'autostart_gust_len_min', 'autostart_gust_max', 'autostart_gust_min', 'autostart_gust_pause_max', 'autostart_gust_pause_min']);
    const p = presetValues('gusts', e)!;
    assert.ok(!('autostart_throttle' in p) && !('autostart_throttle_limit' in p) && !('autostart_run_time' in p));
    assert.equal(gustMix(board({}, SCHEMA.filter(d => d.since !== '1.1').map(d => d.name))), null, 'no gusts on firmware 1.0');
});
