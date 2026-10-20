// The four tool.<locale>.json files: same keys, no empty strings, same {placeholders},
// every key tool.ts asks for exists, every schema field has a label and a help line.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MORE_IDS, SCHEMA } from '../web/src/fc/settings.ts';

const load = (l: string) => JSON.parse(readFileSync(new URL(`../web/src/i18n/tool.${l}.json`, import.meta.url), 'utf8')) as Record<string, string>;
const en = load('en');
const others = { es: load('es'), pl: load('pl'), ru: load('ru') };
const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

test('every locale has exactly the English keys, non-empty, same placeholders', () => {
    const keys = Object.keys(en).sort();
    for (const [l, d] of Object.entries(others)) {
        assert.deepEqual(Object.keys(d).sort(), keys, `${l}: key set differs`);
        for (const k of keys) {
            assert.ok(d[k].trim().length > 0, `${l}: ${k} is empty`);
            assert.equal(ph(d[k]), ph(en[k]), `${l}: ${k} placeholders`);
        }
    }
    assert.ok(keys.every(k => k.startsWith('tool.')), 'all keys under "tool."');
});

test('translations are not English copies', () => {
    for (const [l, d] of Object.entries(others)) {
        const same = Object.keys(en).filter(k => d[k] === en[k] && /[a-z]{4,}/.test(en[k]) && !/^[A-Z0-9_ .()=%{}·-]+$/.test(en[k]));
        assert.ok(same.length <= 6, `${l}: ${same.length} strings identical to English: ${same.slice(0, 8).join(', ')}`);
    }
});

test('every literal key in tool.ts exists', () => {
    const src = readFileSync(new URL('../web/src/ui/tool.ts', import.meta.url), 'utf8');
    const literal = [...src.matchAll(/['`](tool\.[a-z][\w.-]*)['`]/g)].map(m => m[1]).filter(k => !k.endsWith('.'));
    const missing = literal.filter(k => !(k in en));
    assert.deepEqual(missing, []);
});

test('every setting has a label and help, every enum value an option label, every drawer fieldset a title', () => {
    for (const d of SCHEMA) {
        assert.ok(en[`tool.f.${d.name}.label`], `${d.name} label`);
        assert.ok(en[`tool.f.${d.name}.help`], `${d.name} help`);
        if (d.kind === 'enum') for (const v of d.values) assert.ok(en[`tool.opt.${d.name}.${v}`], `${d.name}.${v}`);
        if (d.kind === 'num' && d.zero) assert.ok(en[`tool.zero.${d.name}`], `${d.name} zero value`);
        // the special 0 has its own switch (How long uses its two choices instead)
        if (d.kind === 'num' && d.zero && d.name !== 'autostart_run_time') assert.ok(en[`tool.box.${d.name}`], `${d.name} zero switch`);
    }
    for (const id of MORE_IDS) {
        assert.ok(en[`tool.fs.${id}`], `fieldset ${id}`);
        assert.ok(Object.keys(en).some(k => k.startsWith(`tool.legend.${id}`)), `legend value ${id}`);
    }
    for (let s = 0; s <= 5; s++) assert.ok(en[`tool.state.${s}`]);
    for (const k of ['nocut', 'auto']) for (const p of ['title', 'body', 'ok']) assert.ok(en[`tool.confirm.${k}.${p}`], `confirm ${k}.${p}`);
});

test('every FcError code has a plain-words message (and the key scan really finds keys)', () => {
    const src = readFileSync(new URL('../web/src/fc/transport.ts', import.meta.url), 'utf8');
    const union = /export type FcErrorCode =([\s\S]*?);/.exec(src)![1];
    const codes = [...union.matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
    assert.ok(codes.length >= 15);
    for (const c of codes) assert.ok(en[`tool.err.${c}`], `tool.err.${c}`);
    const tool = readFileSync(new URL('../web/src/ui/tool.ts', import.meta.url), 'utf8');
    assert.ok([...tool.matchAll(/['`](tool\.[a-z][\w.-]*)['`]/g)].length > 60, 'the literal-key scan matches the source');
});
