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

test('a CLI left open by an earlier session is left with a reboot (RAM forgotten), the STOP after it keeps the program held', async () => {
    const { mock, device, log } = rig({ cliOpenAtStart: true });
    const id = await device.connect();
    assert.equal(id.verdict, 'autostart');
    assert.equal(mock.reboots, 1, 'plain "exit": the board reboots');
    assert.ok(log.some(l => l.includes('CLI left open')));
    assert.equal(mock.yielded, true, 'the STOP right after the reboot holds the program, as the open CLI did');
    assert.equal(mock.cliMode, false);
    await device.disconnect();
});

test('a CLI left open with unsaved values in RAM: they never show up as the board’s program, never get saved', async () => {
    const { mock, device } = rig({ cliUnsaved: { autostart_delay: 45, autostart_throttle: 60 } });
    assert.equal(mock.ram.autostart_delay, '45', 'the emulator starts with the unsaved values in RAM');
    await device.connect();
    const s = await device.readSettings();
    assert.equal(s.values.autostart_delay, 10, 'the flash value, not the half-written 45');
    assert.equal(s.values.autostart_throttle, 15);
    // a later save of another value writes only that one: no leftovers go to flash
    await device.writeSettings({ autostart_ramp: 50 });
    assert.equal(mock.flash.autostart_delay, '10');
    assert.equal(mock.flash.autostart_throttle, '15');
    assert.equal(mock.flash.autostart_ramp, '50');
    await device.disconnect();
});

test('Disconnect while writing: the sets already made are undone, the CLI is left, nothing is saved', async () => {
    const { mock, device } = rig({ latencyMs: 15 });
    await device.connect();
    await device.readSettings();
    const p = device.writeSettings({ autostart_delay: 30, autostart_throttle: 40, autostart_ramp: 50, autostart_gust_min: 20 }).catch(e => e);
    await waitFor(() => mock.cliLog.some(l => l.startsWith('set ')), 4000, 'first set');
    await device.disconnect();
    const err = await p;
    assert.ok(err instanceof FcError && err.code === 'cancelled', String(err));
    assert.equal(mock.cliMode, false, 'left the CLI');
    assert.equal(mock.reboots, 0, 'no save, no reboot');
    for (const [k, v] of Object.entries({ autostart_delay: '10', autostart_throttle: '15', autostart_ramp: '100', autostart_gust_min: '40' })) {
        assert.equal(mock.ram[k], v, `RAM ${k} back to the flash value`);
        assert.equal(mock.flash[k], v, `flash ${k} untouched`);
    }
});

test('the board comes back after the reconnect timeout: the save is checked then (late verify)', async () => {
    const { mock, device } = rig({ neverReturnAfterReboot: true }, { reconnectTimeoutMs: 400 });
    await device.connect();
    await device.readSettings();
    const late: { ok: boolean; verified: string[] }[] = [];
    device.lateVerifyEvents.on(r => late.push(r));
    await assert.rejects(device.writeSettings({ autostart_delay: 33 }), (e: unknown) => e instanceof FcError && e.code === 'reconnect-timeout');
    assert.equal(device.awaitingCheck, true);
    mock.boot(); // the board is back by itself
    await waitFor(() => device.phase === 'ready', 5000, 'ready again');
    assert.deepEqual(late.map(r => [r.ok, r.verified]), [[true, ['autostart_delay']]]);
    assert.equal(device.settings!.values.autostart_delay, 33);
    assert.equal(device.awaitingCheck, false);
    assert.equal(mock.yielded, true, 'held after the late check (STOP after the reboot, then the CLI)');
    await device.disconnect();
});

test('a board that is back but whose port does not open (busy) is reported as busy, not as "did not come back"', async () => {
    const { mock, device } = rig({ rebootMs: 100 }, { reconnectTimeoutMs: 600 });
    await device.connect();
    await device.readSettings();
    const p = device.writeSettings({ autostart_delay: 7 });
    await waitFor(() => device.phase === 'rebooting' || device.phase === 'reconnecting', 3000, 'reboot');
    (mock.opts as { busy: boolean }).busy = true; // another program took the port during the reboot
    await assert.rejects(p, (e: unknown) => e instanceof FcError && e.code === 'busy');
    (mock.opts as { busy: boolean }).busy = false;
    await device.disconnect();
});

test('unplugged while connecting: connect fails, and the device does not keep reconnecting or polling', async () => {
    const { mock, device } = rig();
    let n = 0;
    const off = device.phaseEvents.on(() => undefined);
    const p = device.connect();
    // the 2nd MSP request of identify: the board goes away and comes back
    await waitFor(() => mock.mspLog.length >= 2, 3000, 'identify');
    mock.unplug(200);
    await assert.rejects(p);
    await device.disconnect();
    n = mock.mspLog.length;
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(mock.mspLog.length, n, 'nothing polls the board any more');
    assert.equal(device.phase, 'closed');
    off();
});

test('a write that fails with NetworkError (device gone, no disconnect event) counts as a lost port', async () => {
    const { mock, device, transport } = rig();
    await device.connect();
    // the device vanishes silently: present=false without the presence event
    (mock as unknown as { present: boolean }).present = false;
    await device.stopMotor().catch(() => undefined);
    await waitFor(() => !transport.isOpen, 2000, 'lost');
    assert.equal(device.phase, 'reconnecting');
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

test('STOP while a save opens the CLI: no MSP into the CLI, the save succeeds, the stop follows the reboot', async () => {
    const { mock, device } = rig({ rebootMs: 300 });
    await device.connect();
    await device.readSettings();
    const p = device.writeSettings({ autostart_delay: 5 });
    // the same task as Save: the CLI is not open yet, the last live poll may still be running
    assert.equal(device.phase, 'writing');
    const mark = mock.mspLog.length;
    assert.equal(await device.stopMotor(), 'already-stopped');
    await waitFor(() => mock.cliMode, 3000, 'CLI entered');
    assert.equal(await device.stopMotor(), 'already-stopped');
    const r = await p;
    assert.deepEqual(r.verified, ['autostart_delay']);
    assert.equal(mock.flash.autostart_delay, '5');
    assert.ok(mock.cliLog.every(l => !l.includes('$M')), 'no MSP frame typed into the CLI');
    assert.ok(mock.mspLog.slice(mark).includes(214), 'the stop (SET_MOTOR) went out after the reboot');
    assert.equal(mock.yielded, true, 'the program stays stopped');
    await device.disconnect();
});

test('STOP in the same moment as Run (restart) is kept and sent after the reboot: the program stays stopped', async () => {
    const { mock, device } = rig({ rebootMs: 200, speed: 1 });
    await device.connect();
    const p = device.restartProgram();
    assert.equal(device.phase, 'rebooting', 'the phase changes at once, before the last live poll ends');
    assert.equal(await device.stopMotor(), 'queued');
    await p;
    assert.equal(mock.reboots, 1);
    assert.equal(mock.yielded, true, 'held by the STOP sent after the reboot');
    await device.disconnect();
});

test('STOP while the board is identified after a restart is still sent (not left queued)', async () => {
    const { mock, device } = rig({ rebootMs: 200, speed: 1 });
    await device.connect();
    const p = device.restartProgram();
    await waitFor(() => mock.reboots === 1, 3000, 'reboot');
    const mark = mock.mspLog.length;
    // identify after the reboot starts with MSP_FC_VARIANT (2); the phase still says reconnecting
    await waitFor(() => mock.mspLog.slice(mark).includes(2), 5000, 'identify after the reboot');
    assert.equal(device.phase, 'reconnecting');
    assert.equal(await device.stopMotor(), 'queued');
    await p;
    assert.equal(mock.yielded, true, 'the stop went out before the page said ready');
    await device.disconnect();
});

test('N2: STOP while connecting is queued (never MSP into a CLI left open) and sent right after the board is identified', async () => {
    // a CLI left open: the identification leaves it with a reboot; a STOP written at once would be typed into it
    const control = rig({ cliOpenAtStart: true, rebootMs: 300 });
    await control.device.connect();
    const typed = (log: string[]) => log.join('').split('$M<').length - 1;
    const withoutStop = typed(control.mock.cliLog);
    await control.device.disconnect();
    const { mock, device } = rig({ cliOpenAtStart: true, rebootMs: 300 });
    const p = device.connect();
    await waitFor(() => device.phase === 'connecting' && device.transport.isOpen, 2000, 'port open');
    assert.equal(await device.stopMotor(), 'queued');
    await waitFor(() => mock.cliLog.length > 0 || mock.reboots > 0, 4000, 'identify tried');
    assert.equal(await device.stopMotor(), 'queued', 'still connecting');
    await p;
    assert.equal(typed(mock.cliLog), withoutStop, 'no STOP frame typed into the open CLI');
    assert.ok(mock.mspLog.includes(214), 'the STOP went out once the board answered MSP');
    assert.equal(mock.yielded, true, 'held by it');
    assert.equal(device.stopQueued, false, 'not left queued');
    await device.disconnect();
    // a port that never answers: STOPs pressed all the time do not keep it "connecting" (they used to crowd out
    // the identification for over a minute)
    const dead = rig({ noAnswer: true });
    const t0 = Date.now();
    const q = dead.device.connect().catch(e => e);
    const presser = setInterval(() => void dead.device.stopMotor().catch(() => undefined), 100);
    const err = await Promise.race([q, new Promise(r => setTimeout(() => r('still connecting after 15 s'), 15000))]);
    clearInterval(presser);
    assert.ok(err instanceof FcError && err.code === 'no-answer', String(err));
    assert.ok(Date.now() - t0 < 12000, `connect gave up after ${Date.now() - t0} ms`);
    await dead.device.disconnect();
});

test('N4: unplugged in the first moments of a read — the error is "lost" (the page reconnects by itself), never "not open"', async () => {
    for (const at of [0, 30]) {
        const { mock, device } = rig({ rebootMs: 150, latencyMs: 5 });
        await device.connect();
        const p = device.readSettings().catch(e => e);
        await new Promise(r => setTimeout(r, at));
        mock.unplug(400);
        const err = await p;
        assert.ok(err instanceof FcError && err.code === 'lost', `unplug at ${at} ms: ${String(err)}`);
        await waitFor(() => device.phase === 'ready', 5000, 'back by itself');
        await device.disconnect();
    }
});

test('N1 emulator: a battery swap with USB connected leaves MSP with the ESC’s last frame until the motor turns on the new pack', async () => {
    const { mock, device } = rig({ esc: 'sensor', escFreeze: true, batteryVolts: 25.2, speed: 20 });
    await device.connect();
    await waitFor(() => mock.program().state === 3, 4000, 'running');
    await device.stopLive();
    const live = await device.pollOnce();
    assert.ok(live!.esc[0].rpm > 0 && Math.abs(live!.esc[0].volts - 25.2) < 0.2, JSON.stringify(live!.esc[0]));
    assert.equal(await device.stopMotor(), 'sent');
    await device.pollOnce(); // the ESC still sends at a stop: rpm 0, 25.2 V
    mock.setBattery(0);
    const off = await device.pollOnce();
    assert.equal(off!.battery!.volts, 0);
    assert.ok(Math.abs(off!.esc[0].volts - 25.2) < 0.01, 'the old frame stays');
    mock.setBattery(21.6);
    const back = await device.pollOnce();
    assert.ok(Math.abs(back!.battery!.volts - 21.6) < 0.05, 'the board reads the new pack');
    assert.ok(Math.abs(back!.esc[0].volts - 25.2) < 0.01, 'MSP still has the old pack’s ESC frame');
    assert.equal(back!.esc[0].rpm, 0);
    assert.ok(back!.sinceBatteryS! < 3, `debug[6] counts from the plug-in: ${back!.sinceBatteryS}`);
    // the motor turns on the new pack: the ESC sends again
    await device.restartProgram();
    await device.stopLive();
    await waitFor(() => mock.program().state === 3, 4000, 'running again');
    const fresh = await device.pollOnce();
    assert.ok(fresh!.esc[0].rpm > 0 && Math.abs(fresh!.esc[0].volts - 21.6) < 0.2, JSON.stringify(fresh!.esc[0]));
    await device.disconnect();
    // 'rpm': unplugged while the motor turned — the old rpm is kept too; without the option nothing is kept
    for (const [freeze, rpmKept, volts] of [['rpm', true, 25.2], [false, false, 0]] as const) {
        const r = rig({ esc: 'sensor', escFreeze: freeze, batteryVolts: 25.2, speed: 20 });
        await r.device.connect();
        await waitFor(() => r.mock.program().state === 3, 4000, 'running');
        await r.device.stopLive();
        assert.ok((await r.device.pollOnce())!.esc[0].rpm > 0, 'turning when the battery goes');
        r.mock.setBattery(0);
        // held while the battery is out: the motor does not turn on the new pack
        assert.equal(await r.device.stopMotor(), 'sent');
        r.mock.setBattery(21.6);
        const s = await r.device.pollOnce();
        assert.equal(s!.esc[0].rpm > 0, rpmKept, `freeze ${freeze}: rpm`);
        assert.ok(Math.abs(s!.esc[0].volts - volts) < 0.2, `freeze ${freeze}: ${s!.esc[0].volts}`);
        await r.device.disconnect();
    }
});

test('pickBestOutput: fewest bad frames among enabled outputs', () => {
    const e = (rpm: number, inv: number) => ({ rpm, invalidPct: inv, tempC: 0, volts: 0, amps: 0, mah: 0 });
    assert.equal(pickBestOutput([e(0, 100), e(5000, 0.4), e(0, 100), e(0, 100)]), 1);
    assert.equal(pickBestOutput([e(0, 100), e(5000, 0.4)], 1), -1);
    assert.equal(pickBestOutput([]), -1);
    // ESC sensor wire (no DShot telemetry): bad frames are always 0; the ESC is the one that sends data
    const v = (volts: number, t = 0) => ({ rpm: 0, invalidPct: 0, tempC: t, volts, amps: 0, mah: 0 });
    assert.equal(pickBestOutput([v(0), v(0), v(24.3, 31), v(0)]), 2);
    assert.equal(pickBestOutput([v(0), v(0), v(0), v(0)]), -1, 'all zeros = nothing answers');
});

test('debug flag 32: a miscalibrated board reports an implausible voltage, a calibrated one does not', async () => {
    const bad = rig({ flash: { vbat_scale: 120 }, speed: 2 });
    await bad.device.connect();
    await bad.device.stopLive();
    // like the firmware: hidden for the first 3 s after the battery appeared (the filtered voltage still rises)
    const early = await bad.device.pollOnce();
    assert.ok(early!.uptimeS! < 3);
    assert.equal(early!.flags!.implausible, false, 'not in the first 3 s');
    await waitFor(() => Date.now() - bad.mock.bootAt > 1600, 3000, '3 s of board time');
    const s = await bad.device.pollOnce();
    assert.equal(s!.flags!.implausible, true);
    assert.ok(s!.battery!.volts < 15);
    await bad.device.disconnect();
    const good = rig();
    await good.device.connect();
    await good.device.stopLive();
    assert.equal((await good.device.pollOnce())!.flags!.implausible, false);
    await good.device.disconnect();
});
