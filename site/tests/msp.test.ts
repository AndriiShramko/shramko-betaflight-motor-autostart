import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    MspParser,
    encodeMsp,
    encodeSetMotor,
    parseBattery,
    parseBoardInfo,
    parseBuildInfo,
    parseDebug,
    parseFcVersion,
    parseMotorTelemetry,
    parseMotors,
    type MspFrame
} from '../web/src/fc/msp.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** build a reply frame the way Betaflight does */
const reply = (cmd: number, payload: number[], err = false) => {
    let c = payload.length ^ cmd;
    payload.forEach(b => (c ^= b));
    return Uint8Array.from([0x24, 0x4d, err ? 0x21 : 0x3e, payload.length, cmd, ...payload, c]);
};

test('encode: API_VERSION request is the canonical 6 bytes', () => {
    assert.equal(hex(encodeMsp(1)), '244d3c000101');
});

test('encode: SET_MOTOR with 8 x 1000 has len 16 and a correct xor', () => {
    const f = encodeMsp(214, encodeSetMotor(new Array(8).fill(1000)));
    assert.equal(f.length, 6 + 16);
    assert.equal(f[3], 16);
    let c = 0;
    for (let i = 3; i < f.length - 1; i++) c ^= f[i];
    assert.equal(f[f.length - 1], c);
    assert.equal(new DataView(f.buffer).getUint16(5, true), 1000);
});

test('encodeSetMotor clamps to 0..2000 and fills missing outputs with 1000', () => {
    const p = encodeSetMotor([3000, -5]);
    const v = new DataView(p.buffer);
    assert.equal(v.getUint16(0, true), 2000);
    assert.equal(v.getUint16(2, true), 0);
    assert.equal(v.getUint16(14, true), 1000);
});

test('parser: frames split across chunks, CLI text and garbage around them', () => {
    const got: MspFrame[] = [];
    const p = new MspParser(f => got.push(f));
    const a = reply(2, [...Buffer.from('BTFL')]);
    const b = reply(1, [0, 1, 47]);
    const stream = Uint8Array.from([...Buffer.from('# hello $ $M x'), ...a, ...Buffer.from('\r\n'), ...b]);
    for (let i = 0; i < stream.length; i += 3) p.push(stream.slice(i, i + 3));
    assert.equal(got.length, 2);
    assert.equal(Buffer.from(got[0].payload).toString(), 'BTFL');
    assert.deepEqual([...got[1].payload], [0, 1, 47]);
});

test('parser: bad checksum is dropped and counted (negative control)', () => {
    const got: MspFrame[] = [];
    const p = new MspParser(f => got.push(f));
    const f = reply(1, [0, 1, 47]);
    f[f.length - 1] ^= 0xff;
    p.push(f);
    assert.equal(got.length, 0);
    assert.equal(p.badFrames, 1);
    p.push(reply(1, [0, 1, 47]));
    assert.equal(got.length, 1);
});

test('parser: "$M!" error frame is flagged', () => {
    const got: MspFrame[] = [];
    new MspParser(f => got.push(f)).push(reply(99, [], true));
    assert.equal(got[0].error, true);
    assert.equal(got[0].cmd, 99);
});

test('FC_VERSION: pstring wins, calendar year fallback', () => {
    assert.equal(parseFcVersion(Uint8Array.from([25, 12, 1, 9, ...Buffer.from('2025.12.1')])), '2025.12.1');
    assert.equal(parseFcVersion(Uint8Array.from([25, 12, 1])), '2025.12.1');
    assert.equal(parseFcVersion(Uint8Array.from([4, 5, 1])), '4.5.1');
});

test('BUILD_INFO: date, time and our "as-" revision', () => {
    const b = parseBuildInfo(Uint8Array.from(Buffer.from('Oct 19 202619:59:53as-90d1\x00\x01')));
    assert.deepEqual(b, { date: 'Oct 19 2026', time: '19:59:53', revision: 'as-90d1' });
});

test('BOARD_INFO: identifier, target, board, manufacturer', () => {
    const ps = (s: string) => [s.length, ...Buffer.from(s)];
    const p = Uint8Array.from([...Buffer.from('S405'), 0, 0, 0, 1, ...ps('STM32F405'), ...ps('HGLRC_F405_S8'), ...ps('HGLR'), ...new Array(32).fill(0)]);
    const b = parseBoardInfo(p);
    assert.equal(b.identifier, 'S405');
    assert.equal(b.targetName, 'STM32F405');
    assert.equal(b.boardName, 'HGLRC_F405_S8');
    assert.equal(b.manufacturerId, 'HGLR');
    // truncated payload: no throw
    assert.equal(parseBoardInfo(p.slice(0, 5)).boardName, '');
});

test('BATTERY_STATE: precise voltage at offset 9, legacy fallback', () => {
    const p = Uint8Array.from([6, 0xdc, 0x05, 243, 12, 0, 0x2c, 0x01, 0, 0x8c, 0x09]);
    const b = parseBattery(p)!;
    assert.equal(b.cells, 6);
    assert.equal(b.capacityMah, 1500);
    assert.equal(b.volts, 24.44);
    assert.equal(b.amps, 3);
    assert.equal(parseBattery(p.slice(0, 9))!.volts, 24.3);
    assert.equal(parseBattery(p.slice(0, 4)), null);
});

test('MOTOR_TELEMETRY: 13 bytes per motor', () => {
    const m = (rpm: number, inv: number, t: number, v: number) => {
        const b = Buffer.alloc(13);
        b.writeUInt32LE(rpm, 0);
        b.writeUInt16LE(inv, 4);
        b.writeUInt8(t, 6);
        b.writeUInt16LE(v, 7);
        return [...b];
    };
    const p = Uint8Array.from([2, ...m(5820, 40, 31, 2440), ...m(0, 10000, 0, 0)]);
    const e = parseMotorTelemetry(p);
    assert.equal(e.length, 2);
    assert.deepEqual([e[0].rpm, e[0].invalidPct, e[0].tempC, e[0].volts], [5820, 0.4, 31, 24.4]);
    assert.equal(e[1].invalidPct, 100);
    // count larger than the payload: only complete records
    assert.equal(parseMotorTelemetry(Uint8Array.from([4, ...m(1, 0, 0, 0)])).length, 1);
});

test('MOTOR and DEBUG: u16 and signed int16', () => {
    const mb = Buffer.alloc(16);
    mb.writeUInt16LE(1150, 0);
    assert.equal(parseMotors(Uint8Array.from(mb))[0], 1150);
    const db = Buffer.alloc(16);
    db.writeInt16LE(-1, 12);
    db.writeInt16LE(3, 0);
    const d = parseDebug(Uint8Array.from(db));
    assert.equal(d[0], 3);
    assert.equal(d[6], -1);
});
