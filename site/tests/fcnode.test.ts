// tools/fc-node: the serialport adapter and the bench harness, against the emulated board
// through a serialport binding (open/read/write/reboot), never real hardware.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MockFc } from '../web/src/fc/mockfc.ts';
import { FcError } from '../web/src/fc/transport.ts';
import { runCheck } from '../tools/fc-node/harness.ts';
import { mockFcBinding } from '../tools/fc-node/mockfc-binding.ts';
import { NodeSerialTransport } from '../tools/fc-node/node-transport.ts';

const nodeRig = (opts: ConstructorParameters<typeof MockFc>[0] = {}) => {
    const mock = new MockFc({ rebootMs: 200, ...opts });
    const transport = new NodeSerialTransport('MOCK', { binding: mockFcBinding(mock), pollMs: 50 });
    return { mock, transport };
};

test('harness over the serialport adapter: identify, read all, write test with two reboots, restored', async () => {
    const { mock, transport } = nodeRig();
    const lines: string[] = [];
    const r = await runCheck(transport, { writeTest: true, print: l => lines.push(l), reconnectTimeoutMs: 3000 });
    assert.equal(r.ok, true, r.error ?? "");
    assert.equal(r.verdict, 'autostart');
    assert.equal(r.level, '1.1');
    assert.equal(Object.keys(r.settings).length, 21);
    assert.deepEqual(r.writeTest, { from: 10, to: 11, restored: true });
    assert.equal(mock.flash.autostart_delay, '10');
    assert.equal(mock.reboots, 2);
    assert.ok(lines.some(l => l.startsWith('  autostart_gust_pause_max')));
    assert.ok(lines.includes('RESULT    PASS'));
    assert.equal(mock.dfuEntered, false);
});

test('harness on stock Betaflight reports FAIL with the reason (negative control)', async () => {
    const { transport } = nodeRig({ firmware: 'stock' });
    const r = await runCheck(transport, { print: () => undefined });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /autostart module is not on this board/);
});

test('adapter errors: busy port, missing port', async () => {
    const busy = nodeRig({ busy: true }).transport;
    await assert.rejects(busy.open(), (e: unknown) => e instanceof FcError && e.code === 'busy');
    const missing = new NodeSerialTransport('COM99', { binding: mockFcBinding(new MockFc(), 'MOCK') });
    await assert.rejects(missing.open(), (e: unknown) => e instanceof FcError && e.code === 'not-open');
});

test('adapter: a reboot is reported as "lost" and reconnect reopens the same path', async () => {
    const { mock, transport } = nodeRig();
    await transport.open();
    const reasons: string[] = [];
    transport.onClose(r => reasons.push(r));
    mock.reboot();
    for (let i = 0; i < 100 && !reasons.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(reasons, ['lost']);
    await transport.reconnect(2000);
    assert.equal(transport.isOpen, true);
    await transport.close();
    assert.deepEqual(reasons, ['lost', 'closed']);
});

test('check.mjs: --mock passes (exit 0), no arguments is a usage error (exit 2)', () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const ok = spawnSync(process.execPath, ['tools/fc-node/check.mjs', '--mock'], { cwd, encoding: 'utf8', timeout: 60000 });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /RESULT {4}PASS/);
    const usage = spawnSync(process.execPath, ['tools/fc-node/check.mjs'], { cwd, encoding: 'utf8', timeout: 60000 });
    assert.equal(usage.status, 2);
});
