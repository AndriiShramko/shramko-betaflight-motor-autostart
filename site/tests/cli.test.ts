import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cli, parseGetOutput, parseSetOutput } from '../web/src/fc/cli.ts';
import { MockFc, MockSerial } from '../web/src/fc/mockfc.ts';
import { WebSerialTransport } from '../web/src/fc/transport.ts';

// text exactly as Betaflight 2025.12.1 prints `get autostart` (cli.c: cliGet + cliPrintVarRange + cliPrintVarDefault)
const GET = [
    'get autostart',
    'autostart_mode = POWER',
    'Allowed values: OFF, POWER, BUTTON',
    '',
    'autostart_delay = 11',
    'Allowed range: 0 - 600',
    'Default value: 10',
    '',
    'autostart_box = 255',
    'Allowed range: 0 - 255',
    ''
].join('\r\n');

test('parseGetOutput: names, values, allowed values, ranges, defaults', () => {
    const m = parseGetOutput(GET);
    assert.deepEqual([...m.keys()], ['autostart_mode', 'autostart_delay', 'autostart_box']);
    assert.deepEqual(m.get('autostart_mode')!.allowed, ['OFF', 'POWER', 'BUTTON']);
    assert.equal(m.get('autostart_delay')!.value, '11');
    assert.equal(m.get('autostart_delay')!.min, 0);
    assert.equal(m.get('autostart_delay')!.max, 600);
    assert.equal(m.get('autostart_delay')!.default, '10');
    assert.equal(m.get('autostart_mode')!.default, undefined);
});

test('parseGetOutput: negative ranges and junk lines', () => {
    const m = parseGetOutput('###ERROR IN get: INVALID NAME: x###\r\nfoo = -3\r\nAllowed range: -10 - 10\r\nrandom line\r\n');
    assert.equal(m.get('foo')!.min, -10);
    assert.equal(m.size, 1);
});

test('parseSetOutput: success, invalid value, invalid name', () => {
    assert.deepEqual(parseSetOutput('autostart_delay set to 11', 'autostart_delay'), { ok: true, name: 'autostart_delay', value: '11' });
    const bad = parseSetOutput('###ERROR IN set: INVALID VALUE###\r\nAllowed range: 0 - 600', 'autostart_delay');
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.error, 'invalid-value');
    const nm = parseSetOutput('###ERROR IN set: INVALID NAME: autostart_foo = 1###', 'autostart_foo');
    assert.equal(!nm.ok && nm.error, 'invalid-name');
    // a different variable's echo is not a success (negative control)
    assert.equal(parseSetOutput('autostart_ramp set to 11', 'autostart_delay').ok, false);
});

const open = async (opts = {}) => {
    const mock = new MockFc({ rebootMs: 100, ...opts });
    const t = new WebSerialTransport(new MockSerial(mock));
    await t.open();
    return { mock, t, cli: new Cli(t, { enterWaitMs: 400 }) };
};

test('Cli against the emulator: enter, get, set, exit noreboot (no reboot, values in RAM)', async () => {
    const { mock, t, cli } = await open();
    await cli.enter();
    assert.equal(mock.cliMode, true);
    const vars = await cli.get('autostart');
    assert.equal(vars.get('autostart_mode')!.value, 'POWER');
    assert.ok(vars.has('autostart_gust_pause_max'));
    const r = await cli.set('autostart_delay', 12);
    assert.equal(r.ok, true);
    assert.equal(mock.ram.autostart_delay, '12');
    assert.equal(mock.flash.autostart_delay, '10');
    await cli.exitNoReboot();
    assert.equal(mock.cliMode, false);
    assert.equal(mock.reboots, 0);
    await t.close();
});

test('Cli: "#" sent into an already-open CLI is flushed by the newline, commands still work', async () => {
    const { mock, t, cli } = await open({ cliOpenAtStart: true });
    await cli.enter();
    const out = await cli.exec('version');
    assert.match(out, /Betaflight/);
    // the "#" became a comment, not part of a command
    assert.ok(!mock.cliLog.some(l => l.includes('#')));
    await t.close();
});

test('Cli: invalid value is reported, nothing stored', async () => {
    const { mock, t, cli } = await open();
    await cli.enter();
    const r = await cli.set('autostart_delay', 601);
    assert.equal(r.ok, false);
    assert.equal(mock.ram.autostart_delay, '10');
    await t.close();
});

test('Cli: never sends a capital R in MSP mode (bootloader trap)', async () => {
    const { mock, t, cli } = await open();
    await cli.enter();
    await cli.exitNoReboot();
    await cli.leaveIfStuck();
    assert.equal(mock.dfuEntered, false);
    await t.close();
});

test('emulator negative control: a lone "R" in MSP mode does enter the bootloader', async () => {
    const { mock, t } = await open();
    await t.write(new TextEncoder().encode('R'));
    await new Promise(r => setTimeout(r, 30));
    assert.equal(mock.dfuEntered, true);
    await t.close().catch(() => undefined);
});
