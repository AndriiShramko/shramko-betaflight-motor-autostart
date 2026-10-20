// Live data the page can trust (fc/live.ts), against the real-hardware facts of 2026-10-20:
// a stale ESC voltage after a restart, sparse TX-wire samples, the firmware's stopping counters, the rising voltage
// after a plug-in. Every rule has a negative control.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EscTracker, StateClock, VoltSettle, plausibleVolts } from '../web/src/fc/live.ts';
import type { EscTelemetry } from '../web/src/fc/msp.ts';

const e = (rpm: number, volts: number, tempC = 0, invalidPct = 0): EscTelemetry => ({ rpm, invalidPct, tempC, volts, amps: 0, mah: 0 });
const zero = e(0, 0);
/** the TX wire: 4 outputs, the ESC on output 1, no DShot statistics */
const wire = (rpm: number, volts: number, t = 31) => [e(rpm, volts, t), zero, zero, zero];

test('stale ESC voltage after a restart (14.81 V kept by MSP, rpm 0, value never moves): not fresh, never usable', () => {
    const tr = new EscTracker();
    let v = tr.push(0, wire(0, 14.81, 0));
    for (let i = 1; i < 20; i++) v = tr.push(i * 200, wire(0, 14.81, 0));
    assert.equal(v.output, 0, 'the output answers (with an old value)');
    assert.equal(v.volts, 14.81);
    assert.equal(v.fresh, false, 'rpm 0 and the same value every time: an old reading');
    // the motor turns once: from now on the ESC is sending
    v = tr.push(4000, wire(5700, 22.2));
    assert.equal(v.fresh, true);
    assert.equal(v.turned, true);
    // a restart: fresh again only after the motor turned (a moving value is not enough)
    tr.restart();
    v = tr.push(5000, wire(0, 22.2));
    assert.equal(v.fresh, false, 'after a restart MSP may show the last value');
    v = tr.push(5200, wire(0, 22.19));
    assert.equal(v.fresh, false, 'after a restart a moving value is not enough');
    v = tr.push(5400, wire(5600, 22.1));
    assert.equal(v.fresh, true, 'a turn: the ESC is sending');
    assert.equal(v.seen, true, 'an ESC was seen in this session');
});

test('N1: a battery swap with USB connected — the old pack’s frame (also with its old rpm) is never fresh; only a turn on the new battery is, and the median starts there', () => {
    const stop = [1000, 1000, 1000, 1000];
    const run = [1150, 1000, 1000, 1000];
    const tr = new EscTracker();
    // pack A 25.2 V, the motor runs: fresh
    let v = tr.push(0, wire(5700, 25.2), 0xff, run);
    v = tr.push(200, wire(5710, 25.19), 0xff, run);
    assert.equal(v.fresh, true);
    // the battery goes away: the ESC restarts; MSP keeps the last frame — at a stop (rpm 0) or while it turned
    for (const frozenRpm of [0, 5710]) {
        tr.restart('battery');
        for (let i = 1; i <= 25; i++) v = tr.push(200 + i * 200, wire(frozenRpm, 25.19), 0xff, stop);
        assert.equal(v.output, 0, 'the old frame is still shown');
        assert.equal(v.fresh, false, `frozen frame (rpm ${frozenRpm}) at outputs 1000: never fresh`);
        assert.equal(v.turned, false);
    }
    // a value that moves is not enough after a battery plug-in (only a turn is)
    v = tr.push(6000, wire(0, 25.17), 0xff, stop);
    assert.equal(v.fresh, false, 'needs a turn after a battery restart');
    // the motor turns on the new pack (21.6 V): fresh, and the old 25.2 V readings are out of the median at once
    v = tr.push(6200, wire(5600, 21.6), 0xff, run);
    assert.equal(v.fresh, true);
    assert.equal(v.turned, true);
    assert.ok(Math.abs(v.volts - 21.6) < 0.01, `median from the new pack only: ${v.volts}`);
    // a motor that coasts down after STOP (outputs 1000, rpm changing) is a real turn too
    tr.restart('battery');
    tr.push(7000, wire(3000, 21.5), 0xff, stop);
    v = tr.push(7200, wire(2100, 21.5), 0xff, stop);
    assert.equal(v.fresh, true, 'coasting: the rpm changes');
    // a board restart needs a turn too (real board: the TX telemetry is silent until the motor turns once); a value
    // that moves is not enough — and a 'board' restart after a 'battery' one must not loosen the rule
    tr.restart('battery');
    tr.restart('board');
    tr.push(8000, wire(0, 21.5), 0xff, stop);
    v = tr.push(8200, wire(0, 21.49), 0xff, stop);
    assert.equal(v.fresh, false, 'board restart: a moving value is not fresh');
    v = tr.push(8400, wire(5600, 21.4), 0xff, run);
    assert.equal(v.fresh, true, 'board restart: fresh after a turn');
    // negative control: a new session (reset, the board did not restart) keeps the "value moves" rule
    tr.reset();
    tr.push(9000, wire(0, 21.5), 0xff, stop);
    v = tr.push(9200, wire(0, 21.49), 0xff, stop);
    assert.equal(v.fresh, true, 'new session: the ESC sends at a stop');
});

test('sparse TX-wire samples (every 2nd answer empty) do not flicker "no answer"; the voltage is a median', () => {
    const tr = new EscTracker();
    const outs: number[] = [];
    for (let i = 0; i < 30; i++) {
        const v = tr.push(i * 200, i % 2 ? [zero, zero, zero, zero] : wire(5700, 24.3 + (i % 4 === 0 ? 0.02 : 0)));
        outs.push(v.output);
    }
    assert.deepEqual([...new Set(outs)], [0], 'output 1 all the time');
    // a single wild sample does not move the median
    const v = tr.push(6200, wire(5700, 3.1));
    assert.ok(Math.abs(v.volts - 24.3) < 0.05, `median ${v.volts}`);
    // negative control: really gone (no answer for longer than the hold) → no answer
    let gone = tr.push(6400, [zero, zero, zero, zero]);
    for (let t = 6600; t <= 9800; t += 200) gone = tr.push(t, [zero, zero, zero, zero]);
    assert.equal(gone.output, -1);
    assert.equal(gone.seen, true);
});

test('DShot telemetry: live frames make the voltage fresh at stop; empty outputs (100 % bad frames) never answer', () => {
    const tr = new EscTracker();
    const v = tr.push(0, [e(0, 24.4, 31, 0.4), e(0, 0, 0, 100), e(0, 0, 0, 100), e(0, 0, 0, 100)]);
    assert.deepEqual([v.output, v.fresh, v.dshot], [0, true, true]);
    // a locked ESC (BLHeli_32 after a restart on a USB bench): 100 % everywhere = nothing answers
    const locked = new EscTracker().push(0, [e(0, 0, 0, 100), e(0, 0, 0, 100), e(0, 0, 0, 100), e(0, 0, 0, 100)]);
    assert.equal(locked.output, -1);
    // the motor mask: an ESC on an output the program does not drive is not used
    assert.equal(new EscTracker().push(0, [zero, e(5000, 24, 30)], 0b01).output, -1);
});

test('plausible voltages: 2.50–4.45 V per cell for the known count, any LiPo when the count is unknown', () => {
    assert.equal(plausibleVolts(24.4, 6), true);
    assert.equal(plausibleVolts(14.81, 6), false, '2.47 V per cell');
    assert.equal(plausibleVolts(29.0, 6), false, '4.83 V per cell');
    assert.equal(plausibleVolts(244, 6), false);
    assert.equal(plausibleVolts(2.44, 6), false);
    assert.equal(plausibleVolts(14.81, null), true, 'fits 4S when the count is unknown');
    assert.equal(plausibleVolts(244, null), false, 'no LiPo up to 12S reads 244 V');
    assert.equal(plausibleVolts(0, null), false);
});

test('time in a state past the firmware counters: 655.35 s (1.1) and 327.67 s (1.0); connected after the stop: only a bound', () => {
    // a 1-hour run on 1.1: [2] stops at 655 350 ms, [3] (uptime) keeps running
    const c = new StateClock();
    const at = (s: number) => 1_000_000 + s * 1000;
    let t = c.update({ at: at(0), state: 3, msInState: 600_000, uptimeS: 700 }, '1.1');
    assert.deepEqual(t, { sec: 600, exact: true });
    t = c.update({ at: at(100), state: 3, msInState: 655_350, uptimeS: 800 }, '1.1');
    assert.ok(t.exact && Math.abs(t.sec - 700) < 0.01, JSON.stringify(t));
    t = c.update({ at: at(2900), state: 3, msInState: 655_350, uptimeS: 3600 }, '1.1');
    assert.ok(Math.abs(t.sec - 3500) < 0.01, `counts on with the board's clock: ${t.sec}`);
    // the uptime stops too (3276.7 s): the page's clock goes on (at the board's measured rate)
    c.update({ at: at(3000), state: 3, msInState: 655_350, uptimeS: 3276.7 }, '1.1');
    t = c.update({ at: at(3100), state: 3, msInState: 655_350, uptimeS: 3276.7 }, '1.1');
    assert.ok(t.sec > 3500, `still counting: ${t.sec}`);
    // firmware 1.0: [2] stops at 327.67 s, also when the level is not known yet (the value stops moving)
    const c10 = new StateClock();
    c10.update({ at: at(0), state: 1, msInState: 300_000, uptimeS: 310 }, null);
    c10.update({ at: at(27.67), state: 1, msInState: 327_670, uptimeS: 337.67 }, null);
    t = c10.update({ at: at(60), state: 1, msInState: 327_670, uptimeS: 370 }, null);
    assert.ok(t.exact && Math.abs(t.sec - 360) < 0.05, JSON.stringify(t));
    // connected mid-run, counter already stopped: a lower bound only
    const late = new StateClock();
    t = late.update({ at: at(0), state: 3, msInState: 655_350, uptimeS: 2000 }, '1.1');
    assert.deepEqual(t, { sec: 655.35, exact: false });
    // negative control: a new state starts a new count
    t = c.update({ at: at(3200), state: 4, msInState: 1_000, uptimeS: 3276.7 }, '1.1');
    assert.deepEqual(t, { sec: 1, exact: true });
});

test('the battery reading settles: 3 s after it appeared (debug[6]), or 3 calm samples without debug', () => {
    const s = new VoltSettle();
    assert.equal(s.update(15.1, 1.5), false, 'the filtered voltage still rises');
    assert.equal(s.update(22.0, 2.9), false);
    assert.equal(s.update(22.2, 3.0), true);
    const nd = new VoltSettle();
    assert.equal(nd.update(14.8, null), false);
    assert.equal(nd.update(19.0, null), false, 'jumping');
    assert.equal(nd.update(22.0, null), false);
    assert.equal(nd.update(22.1, null), false, 'one calm sample');
    assert.equal(nd.update(22.15, null), true, 'two calm steps in a row');
    assert.equal(new VoltSettle().update(0, 10), false, 'no battery');
});
