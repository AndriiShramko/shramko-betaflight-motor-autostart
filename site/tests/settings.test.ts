import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGetOutput } from '../web/src/fc/cli.ts';
import {
    DEF,
    SCHEMA,
    calibrateVbatScale,
    clampValue,
    cutoffVolts,
    defaultValues,
    diff,
    effective,
    fromDisplay,
    matchPreset,
    normalize,
    presetValues,
    toDisplay,
    type Effective,
    type NumDef,
    type Note
} from '../web/src/fc/settings.ts';

const allEff = (present = SCHEMA.map(d => d.name)): Record<string, Effective> =>
    Object.fromEntries(SCHEMA.map(d => [d.name, effective(d, present.includes(d.name) ? { name: d.name, value: String(d.def) } : undefined)]));

test('schema matches docs/settings.md: 21 settings, defaults inside ranges', () => {
    assert.equal(SCHEMA.length, 21);
    for (const d of SCHEMA) {
        if (d.kind === 'num') assert.ok(d.def >= d.min && d.def <= d.max, d.name);
        if (d.kind === 'enum') assert.ok(d.values.includes(d.def), d.name);
    }
    assert.equal((DEF.autostart_ramp as NumDef).max, 6000);
    assert.equal((DEF.autostart_cell_cutoff as NumDef).minNonZero, 250);
});

test('clamp: numbers to range, rounding, junk to default', () => {
    const e = allEff();
    const notes: Note[] = [];
    assert.equal(clampValue(e.autostart_delay, 9999, notes), 600);
    assert.equal(clampValue(e.autostart_delay, -4, notes), 0);
    assert.equal(clampValue(e.autostart_delay, '12,6', notes), 13);
    assert.equal(clampValue(e.autostart_delay, 'abc', notes), 10);
    assert.equal(clampValue(e.autostart_throttle_limit, 0, notes), 1);
    assert.deepEqual(notes.map(n => n.kind), ['clamped', 'clamped', 'rounded', 'invalid', 'clamped']);
});

test('clamp: cell cut-off is 0 or 250..420', () => {
    const e = allEff();
    assert.equal(clampValue(e.autostart_cell_cutoff, 0), 0);
    assert.equal(clampValue(e.autostart_cell_cutoff, 100), 250);
    assert.equal(clampValue(e.autostart_cell_cutoff, 500), 420);
    assert.equal(clampValue(e.autostart_cell_cutoff, 330), 330);
});

test('clamp: enums, motor mask, RC switch choices', () => {
    const e = allEff();
    assert.equal(clampValue(e.autostart_mode, 'button'), 'BUTTON');
    assert.equal(clampValue(e.autostart_mode, 'TURBO'), 'POWER');
    assert.equal(clampValue(e.autostart_motors, 0), 1);
    assert.equal(clampValue(e.autostart_motors, 256 + 3), 3);
    assert.equal(clampValue(e.autostart_box, 41), 41);
    assert.equal(clampValue(e.autostart_box, 7), 255);
});

test('board ranges narrow the schema, empty intersection falls back to the board', () => {
    const v = parseGetOutput('autostart_delay = 5\r\nAllowed range: 0 - 300\r\n').get('autostart_delay');
    const e = effective(DEF.autostart_delay, v);
    assert.equal(e.max, 300);
    assert.equal(e.boardDefault, 5);
    const w = parseGetOutput('autostart_delay = 5\r\nAllowed range: 700 - 900\r\nDefault value: 800\r\n').get('autostart_delay');
    const e2 = effective(DEF.autostart_delay, w);
    assert.deepEqual([e2.min, e2.max, e2.boardDefault], [700, 900, 800]);
});

test('normalize swaps min/max pairs', () => {
    const { values, notes } = normalize(allEff(), { autostart_gust_min: 90, autostart_gust_max: 50, autostart_gust_len_min: 100, autostart_gust_len_max: 900 });
    assert.equal(values.autostart_gust_min, 50);
    assert.equal(values.autostart_gust_max, 90);
    assert.equal(values.autostart_gust_len_min, 100);
    assert.equal(notes.filter(n => n.kind === 'swapped').length, 1);
});

test('units: display ↔ raw', () => {
    const r = DEF.autostart_ramp as NumDef;
    assert.equal(toDisplay(r, 100), 10);
    assert.equal(fromDisplay(r, 12.34), 123);
    const ms = DEF.autostart_gust_len_min as NumDef;
    assert.equal(toDisplay(ms, 300), 0.3);
    assert.equal(fromDisplay(ms, 0.3), 300);
    const cv = DEF.autostart_cell_cutoff as NumDef;
    assert.equal(fromDisplay(cv, 3.3), 330);
    assert.equal(cutoffVolts(330, 6), 19.8);
    assert.equal(cutoffVolts(0, 6), null);
});

test('diff: only changed keys, case-insensitive enums', () => {
    assert.deepEqual(diff({ autostart_mode: 'POWER', autostart_delay: 10, autostart_ramp: 100 }, { autostart_mode: 'power', autostart_delay: 11, autostart_ramp: 100 }), { autostart_delay: 11 });
});

test('presets: Steady = defaults of the pattern settings, Gusts = the spec values; not on 1.0 boards', () => {
    const e = allEff();
    const s = presetValues('steady', e)!;
    assert.equal(s.autostart_pattern, 'STEADY');
    assert.equal(s.autostart_throttle, 15);
    assert.ok(!('autostart_delay' in s), 'presets never touch the start settings');
    const g = presetValues('gusts', e)!;
    assert.deepEqual(
        [g.autostart_pattern, g.autostart_throttle, g.autostart_gust_min, g.autostart_gust_max, g.autostart_gust_len_min, g.autostart_gust_len_max, g.autostart_gust_pause_min, g.autostart_gust_pause_max],
        ['GUSTS', 20, 50, 90, 200, 600, 15, 60]
    );
    assert.equal(matchPreset({ ...defaultValues(e), ...g }, e), 'gusts');
    assert.equal(matchPreset(defaultValues(e), e), 'steady');
    assert.equal(matchPreset({ ...defaultValues(e), autostart_throttle: 33 }, e), null);
    const old = allEff(SCHEMA.filter(d => d.since === '1.0').map(d => d.name));
    assert.equal(presetValues('gusts', old), null);
});

test('defaults never reset the voltage calibration', () => {
    assert.ok(!('vbat_scale' in defaultValues(allEff())));
});

test('vbat calibration: old × real / shown, clamped 10..255', () => {
    assert.deepEqual(calibrateVbatScale(200, 24.0, 22.86), { ok: true, scale: 210, clamped: false });
    assert.deepEqual(calibrateVbatScale(250, 30, 10), { ok: true, scale: 255, clamped: true });
    assert.deepEqual(calibrateVbatScale(210, 24, 0), { ok: false, reason: 'no-reading' });
    assert.deepEqual(calibrateVbatScale(210, -1, 24), { ok: false, reason: 'bad-input' });
});
