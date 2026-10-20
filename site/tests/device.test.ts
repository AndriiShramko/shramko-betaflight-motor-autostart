// device.ts end to end against the emulated board (MSP + CLI + save/reboot + reconnect).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickBestOutput, type LiveSample } from '../web/src/fc/device.ts';
import { FcError } from '../web/src/fc/transport.ts';
import { rig, waitFor } from './helpers.ts';

test('connect → identify our build → read → change 3 values → save with reboot → reconnect → verify', async () => {
    const { mock, device } = rig();
    const id = await device.connect();
    assert.equal(id.verdict, 'autostart');
    assert.equal(id.variant, 'BTFL');
    assert.equal(id.fcVersion, '2025.12.1');
    assert.equal(id.board.boardName, 'HGLRC_F405_S8');
    assert.equal(id.build.revision, 'as-90d1');

    const s = await device.readSettings();
    assert.equal(s.level, '1.1');
    assert.equal(s.values.autostart_mode, 'POWER');
    assert.equal(s.values.autostart_delay, 10);
    assert.equal(s.values.vbat_scale, 210);
    assert.equal(s.debugMode, 'AUTOSTART');
    assert.equal(s.missing.length, 0);
    assert.equal(mock.cliMode, false, 'left the CLI without a reboot');
    assert.equal(mock.reboots, 0);

    const steps: string[] = [];
    const r = await device.writeSettings({ autostart_delay: 12, autostart_pattern: 'GUSTS', autostart_cell_cutoff: 340 }, p => steps.push(p.step));
    assert.deepEqual(r.verified.sort(), ['autostart_cell_cutoff', 'autostart_delay', 'autostart_pattern']);
    assert.equal(mock.flash.autostart_delay, '12');
    assert.equal(mock.flash.autostart_pattern, 'GUSTS');
    assert.equal(mock.flash.autostart_cell_cutoff, '340');
    assert.equal(mock.reboots, 1);
    assert.ok(steps.includes('reconnect') && steps.at(-1) === 'done');
    // only the changes were sent
    const sets = mock.cliLog.filter(l => l.startsWith('set '));
    assert.deepEqual(sets, ['set autostart_delay = 12', 'set autostart_pattern = GUSTS', 'set autostart_cell_cutoff = 340']);
    assert.equal(device.phase, 'ready');
    assert.equal(device.settings!.values.autostart_delay, 12);
    assert.equal(mock.dfuEntered, false);
    await device.disconnect();
});

test('live view: 5 Hz samples move through DELAY → RAMP → RUN, then STOP takes the motor to 1000', async () => {
    const { mock, device } = rig({ speed: 20 }); // 10 s delay + 10 s ramp in ~1 s
    await device.connect();
    const samples: LiveSample[] = [];
    device.liveEvents.on(s => samples.push(s));
    await waitFor(() => samples.some(s => s.state === 3), 4000, 'RUN state');
    const states = new Set(samples.map(s => s.state));
    assert.ok(states.has(1) || states.has(2), 'saw the countdown or the ramp');
    const run = samples.find(s => s.state === 3)!;
    assert.equal(run.pct, 15);
    assert.equal(run.motors[0], 1150);
    assert.ok(run.battery && Math.abs(run.battery.volts - 24.31) < 0.05, `battery ${run.battery?.volts}`);
    assert.equal(run.bestOutput, 0);
    assert.ok(run.esc[0].rpm > 0);
    assert.equal(run.flags!.battery, true);

    assert.equal(await device.stopMotor(), 'sent');
    samples.length = 0;
    await waitFor(() => samples.length >= 2, 2000, 'samples after stop');
    const after = samples.at(-1)!;
    assert.equal(after.state, 0);
    assert.deepEqual(after.motors.slice(0, 4), [1000, 1000, 1000, 1000]);
    assert.equal(mock.yielded, true);
    await device.disconnect();
});

test('restart program: MSP reboot, reconnect, countdown runs again', async () => {
    const { mock, device } = rig({ speed: 1 });
    await device.connect();
    await device.stopMotor();
    assert.equal(mock.yielded, true);
    await device.restartProgram();
    assert.equal(mock.reboots, 1);
    assert.equal(mock.yielded, false);
    const s = await device.pollOnce();
    assert.equal(s!.state, 1);
    await device.disconnect();
});

test('negative control: the board answers "Invalid value" → error, nothing saved, RAM rolled back, no reboot', async () => {
    const { mock, device } = rig({ invalidValueFor: ['autostart_ramp'] });
    await device.connect();
    await device.readSettings();
    await assert.rejects(
        device.writeSettings({ autostart_delay: 30, autostart_ramp: 50 }),
        (e: unknown) => e instanceof FcError && e.code === 'cli-invalid-value' && e.detail.name === 'autostart_ramp'
    );
    assert.equal(mock.flash.autostart_delay, '10');
    assert.equal(mock.ram.autostart_delay, '10', 'already-set value rolled back');
    assert.equal(mock.reboots, 0);
    assert.equal(mock.cliMode, false);
    assert.equal(device.phase, 'ready');
    await device.disconnect();
});

test('negative control: the board never comes back after save → reconnect-timeout, then keeps waiting', async () => {
    const { device } = rig({ neverReturnAfterReboot: true }, { reconnectTimeoutMs: 500 });
    await device.connect();
    await device.readSettings();
    const t0 = Date.now();
    await assert.rejects(device.writeSettings({ autostart_delay: 30 }), (e: unknown) => e instanceof FcError && e.code === 'reconnect-timeout');
    assert.ok(Date.now() - t0 < 4000);
    assert.equal(device.phase, 'reconnecting');
    await device.disconnect();
    assert.equal(device.phase, 'closed');
});

test('negative control: the board does not keep a value → "verify" error naming it', async () => {
    const { device } = rig({ saveIgnores: ['autostart_throttle'] });
    await device.connect();
    await device.readSettings();
    await assert.rejects(device.writeSettings({ autostart_throttle: 40, autostart_delay: 5 }), (e: unknown) => {
        if (!(e instanceof FcError) || e.code !== 'verify') return false;
        const m = e.detail.mismatches as { name: string; expected: string; got: string }[];
        return m.length === 1 && m[0].name === 'autostart_throttle' && m[0].expected === '40' && m[0].got === '15';
    });
    await device.disconnect();
});

test('values are validated before sending: out of range is clamped, pairs swapped', async () => {
    const { mock, device } = rig();
    await device.connect();
    await device.readSettings();
    await device.writeSettings({ autostart_delay: 9999, autostart_gust_min: 95, autostart_gust_max: 30 });
    assert.equal(mock.flash.autostart_delay, '600');
    assert.equal(mock.flash.autostart_gust_min, '30');
    assert.equal(mock.flash.autostart_gust_max, '95');
    await device.disconnect();
});

test('a CLI left open by an earlier session is closed without a reboot, then identify works', async () => {
    const { mock, device, log } = rig({ cliOpenAtStart: true });
    const id = await device.connect();
    assert.equal(id.verdict, 'autostart');
    assert.equal(mock.reboots, 0);
    assert.ok(log.some(l => l.includes('CLI left open')));
    await device.disconnect();
});

test('stock Betaflight: verdict betaflight-other, settings show no autostart module', async () => {
    const { device } = rig({ firmware: 'stock' });
    const id = await device.connect();
    assert.equal(id.verdict, 'betaflight-other');
    const s = await device.readSettings();
    assert.equal(s.level, null);
    assert.equal(device.identity!.verdict, 'betaflight-other');
    await device.disconnect();
});

test('INAV board: verdict not-betaflight', async () => {
    const { device } = rig({ firmware: 'inav' });
    assert.equal((await device.connect()).verdict, 'not-betaflight');
    await device.disconnect();
});

test('firmware 1.0: the new settings are reported missing, writes to them are refused before the CLI', async () => {
    const { mock, device } = rig({ firmware: '1.0' });
    await device.connect();
    const s = await device.readSettings();
    assert.equal(s.level, '1.0');
    assert.ok(s.missing.includes('autostart_pattern'));
    assert.ok(!s.missing.includes('autostart_delay'));
    await assert.rejects(device.writeSettings({ autostart_pattern: 'GUSTS' }), (e: unknown) => e instanceof FcError && e.code === 'cli-invalid-name');
    assert.equal(mock.cliLog.filter(l => l.startsWith('set')).length, 0);
    await device.disconnect();
});

test('unplugged while live: phase reconnecting, back to ready when plugged in again', async () => {
    const { mock, device } = rig();
    await device.connect();
    mock.unplug(200);
    await waitFor(() => device.phase === 'reconnecting', 2000, 'reconnecting');
    await waitFor(() => device.phase === 'ready', 4000, 'ready again');
    const s = await device.pollOnce();
    assert.equal(s!.misses, 0);
    await device.disconnect();
});

test('STOP pressed during a save is queued and sent right after the reconnect', async () => {
    const { mock, device } = rig({ rebootMs: 300 });
    await device.connect();
    await device.readSettings();
    const p = device.writeSettings({ autostart_delay: 3 });
    await waitFor(() => device.phase === 'rebooting' || device.phase === 'reconnecting', 3000, 'reboot');
    assert.notEqual(await device.stopMotor(), 'sent');
    await p;
    assert.ok(mock.mspLog.includes(214), 'SET_MOTOR sent after the reboot');
    await device.disconnect();
});

test('pickBestOutput: fewest bad frames among enabled outputs', () => {
    const e = (rpm: number, inv: number) => ({ rpm, invalidPct: inv, tempC: 0, volts: 0, amps: 0, mah: 0 });
    assert.equal(pickBestOutput([e(0, 100), e(5000, 0.4), e(0, 100), e(0, 100)]), 1);
    assert.equal(pickBestOutput([e(0, 100), e(5000, 0.4)], 1), -1);
    assert.equal(pickBestOutput([]), -1);
});
