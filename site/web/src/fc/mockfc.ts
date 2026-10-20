// In-memory emulator of an HGLRC F405 8S running Shramko Motor Autostart on Betaflight 2025.12.1:
// MSP v1, the interactive CLI (echo, get/set/save/exit), flash vs RAM, reboot with the USB port
// disappearing and coming back as a new port object, and a simple program timeline
// (DELAY → RAMP → RUN, gusts, run time) so the live view moves. Used by the tests and by ?mock=1.
// Behaviour copied from betaflight-2025.12.1/src/main/cli/cli.c and msp/msp_serial.c.

import { SCHEMA, type SettingDef } from './settings';
import type { SerialLike, SerialPortLike } from './transport';

export type MockFirmware = '1.1' | '1.0' | 'stock' | 'inav';
/** How the ESC's telemetry reaches the board: the ESC's TX wire on the cable's yellow (feature ESC_SENSOR, the
 *  recommended wiring), bidirectional DShot on the signal wire (dshot_bidir ON), or none at all. */
export type MockEsc = 'sensor' | 'bidir' | 'none';

export interface MockOptions {
    firmware?: MockFirmware;
    /** how long the USB port is gone during a reboot */
    rebootMs?: number;
    /** program clock multiplier (tests run the timeline faster) */
    speed?: number;
    /** real battery voltage at the B pad (0 = USB only) */
    batteryVolts?: number;
    /** initial flash values (CLI text or numbers) */
    flash?: Record<string, string | number>;
    /** negative controls */
    invalidValueFor?: string[];
    neverReturnAfterReboot?: boolean;
    saveIgnores?: string[];
    cliOpenAtStart?: boolean;
    busy?: boolean;
    cancelPicker?: boolean;
    /** which output the ESC is plugged into (0-based) */
    escOutput?: number;
    /** latency of every answer */
    latencyMs?: number;
    /** how the ESC's telemetry reaches the board (default: the TX wire, feature ESC_SENSOR) */
    esc?: MockEsc;
    /** TX wire: the voltage MSP keeps from before the restart until the motor turns once (a stale value; 0 = none) */
    escStaleVolts?: number;
    /** TX wire: share of telemetry answers that come back empty (0–1; on the real board some samples are 0) */
    escSparse?: number;
    /** a BLHeli_32 that stayed on the battery while the board restarted: after a restart it only beeps (no turn, no
     *  telemetry) until the battery is plugged in again */
    escLocked?: boolean;
    /** TX wire, battery unplugged or swapped with USB connected: MSP keeps the ESC's last frame (Betaflight keeps its
     *  ESC sensor data) until the motor turns on the next battery. true = the frame as sent at a stop (rpm 0);
     *  'rpm' = unplugged while the motor turned (the old rpm stays too) */
    escFreeze?: boolean | 'rpm';
    /** the port opens, but nothing ever answers */
    noAnswer?: boolean;
    /** the board starts held by the computer (bit 64), e.g. a page reload while the settings were open */
    heldAtStart?: boolean;
    /** the CLI is open at start with these values set in RAM but not saved (a write that was interrupted) */
    cliUnsaved?: Record<string, string | number>;
}

interface VarSpec {
    name: string;
    kind: 'lookup' | 'num';
    values?: string[];
    min?: number;
    max?: number;
    def: string;
}

const BF_VARS: VarSpec[] = [
    { name: 'vbat_scale', kind: 'num', min: 0, max: 255, def: '110' },
    { name: 'debug_mode', kind: 'lookup', values: ['NONE', 'CYCLETIME', 'BATTERY', 'GYRO_FILTERED', 'AUTOSTART'], def: 'NONE' },
    { name: 'dshot_bidir', kind: 'lookup', values: ['OFF', 'ON'], def: 'OFF' }
];

/** project build defaults (HGLRC_F405_S8 config): what `get` reports as "Default value".
 *  dshot_bidir stays OFF (config.h: an ESC older than BLHeli_32 32.7 would never arm with it). */
const BUILD_DEFAULTS: Record<string, string> = { vbat_scale: '210', debug_mode: 'AUTOSTART', dshot_bidir: 'OFF' };

/** firmware ranges as the CLI prints them (the firmware stores bytes; the schema is stricter) */
const FW_RANGE: Record<string, [number, number]> = { autostart_box: [0, 255], autostart_cell_cutoff: [0, 420] };

const toSpec = (d: SettingDef): VarSpec => {
    if (d.kind === 'enum') return { name: d.name, kind: 'lookup', values: d.values, def: d.def };
    if (d.kind === 'mask') return { name: d.name, kind: 'num', min: 1, max: 255, def: String(d.def) };
    if (d.kind === 'choice') return { name: d.name, kind: 'num', min: 0, max: 255, def: String(d.def) };
    const r = FW_RANGE[d.name] ?? [d.min, d.max];
    return { name: d.name, kind: 'num', min: r[0], max: r[1], def: String(d.def) };
};

const varsFor = (fw: MockFirmware): VarSpec[] => {
    const own = SCHEMA.filter(d => d.since !== 'bf' && (fw === '1.1' || (fw === '1.0' && d.since === '1.0'))).map(toSpec);
    return [...own, ...BF_VARS.map(v => ({ ...v, def: BUILD_DEFAULTS[v.name] ?? v.def }))];
};

const enc = new TextEncoder();

/** mulberry32 — deterministic gusts */
const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** The value `set` would store for this variable (a number out of range is clamped here; the CLI would refuse it), or null. */
const cliValue = (v: VarSpec, raw: string | number): string | null => {
    const t = String(raw).trim();
    if (v.kind === 'lookup') return v.values!.find(x => x.toLowerCase() === t.toLowerCase()) ?? null;
    if (!/^-?\d+$/.test(t)) return null;
    return String(Math.min(v.max!, Math.max(v.min!, parseInt(t, 10))));
};

export interface ProgramView {
    state: number;
    pct: number;
    msInState: number;
    gust: boolean;
    source: number;
}

export class MockFc {
    readonly opts: Required<Omit<MockOptions, 'flash' | 'cliUnsaved'>>;
    readonly vars: VarSpec[];
    flash: Record<string, string> = {};
    ram: Record<string, string> = {};
    present = true;
    /** increments on every boot: a re-enumerated USB device is a new SerialPort object */
    generation = 1;
    cliMode = false;
    private cliBuf = '';
    /** program stopped by the CLI or MSP_SET_MOTOR until the next boot */
    yielded = false;
    motorsOverride: number[] | null = null;
    bootAt = Date.now();
    reboots = 0;
    dfuEntered = false;
    /** every complete CLI line received (for assertions) */
    readonly cliLog: string[] = [];
    readonly mspLog: number[] = [];
    private mspIn: number[] = [];
    private listeners = new Set<(b: Uint8Array) => void>();
    private presence = new Set<(present: boolean) => void>();
    private outQueue: Promise<void> = Promise.resolve();
    /** the state the program was in when the computer took over: DONE / LOW_BATTERY stay (the firmware stops only a running program) */
    private heldState: { state: number; since: number } | null = null;
    /** TX wire: the ESC sends only once the motor has turned since the board (or the ESC: a battery plug-in) started */
    private sensorLive = false;
    private escAnswers = 0;
    /** the battery as the board last saw it (opts.batteryVolts may be changed directly: checked on every request) */
    private batteryOn: boolean;
    /** when the battery appeared (debug[6] counts from here; the boot when it was there from the start) */
    private batteryAt = this.bootAt;
    /** the battery was plugged in again since the last board restart: the ESC restarted (a locked one is free again) */
    private escRepowered = false;
    /** the last MSP 139 answer that carried the ESC's data, and the frame MSP keeps after the battery went away */
    private lastEscFrame: number[] | null = null;
    private frozenEsc: number[] | null = null;
    private bootTimer: ReturnType<typeof setTimeout> | null = null;
    /** Betaflight features (`feature` in the CLI) */
    readonly features: string[];

    constructor(opts: MockOptions = {}) {
        this.opts = {
            firmware: opts.firmware ?? '1.1',
            rebootMs: opts.rebootMs ?? 2500,
            speed: opts.speed ?? 1,
            batteryVolts: opts.batteryVolts ?? 24.4,
            invalidValueFor: opts.invalidValueFor ?? [],
            neverReturnAfterReboot: opts.neverReturnAfterReboot ?? false,
            saveIgnores: opts.saveIgnores ?? [],
            cliOpenAtStart: opts.cliOpenAtStart ?? false,
            busy: opts.busy ?? false,
            cancelPicker: opts.cancelPicker ?? false,
            escOutput: opts.escOutput ?? 0,
            latencyMs: opts.latencyMs ?? 1,
            esc: opts.esc ?? 'sensor',
            escStaleVolts: opts.escStaleVolts ?? 0,
            escSparse: Math.min(1, Math.max(0, opts.escSparse ?? 0)),
            escLocked: opts.escLocked ?? false,
            escFreeze: opts.escFreeze ?? false,
            noAnswer: opts.noAnswer ?? false,
            heldAtStart: opts.heldAtStart ?? false
        };
        this.batteryOn = this.opts.batteryVolts > 0;
        this.vars = this.opts.firmware === 'stock' || this.opts.firmware === 'inav' ? varsFor('1.0').filter(v => !v.name.startsWith('autostart_')) : varsFor(this.opts.firmware);
        for (const v of this.vars) this.flash[v.name] = v.def;
        // bidirectional DShot telemetry needs dshot_bidir ON on the board
        if (this.opts.esc === 'bidir' && 'dshot_bidir' in this.flash) this.flash.dshot_bidir = 'ON';
        // only what the CLI would store: a value out of its range is never stored as is
        const put = (target: Record<string, string>, src: Record<string, string | number> | undefined) => {
            for (const [k, raw] of Object.entries(src ?? {})) {
                const v = this.vars.find(x => x.name === k);
                const val = v ? cliValue(v, raw) : null;
                if (val !== null) target[k] = val;
            }
        };
        put(this.flash, opts.flash);
        this.ram = { ...this.flash };
        this.features = ['RX_SERIAL', 'TELEMETRY', 'OSD', 'ANTI_GRAVITY', 'DYNAMIC_FILTER', ...(this.opts.esc === 'sensor' ? ['ESC_SENSOR'] : [])];
        if (this.opts.cliOpenAtStart || opts.cliUnsaved) {
            this.cliMode = true;
            this.yielded = true;
            put(this.ram, opts.cliUnsaved);
        }
        if (this.opts.heldAtStart) this.yielded = true;
    }

    // ---------- wiring to a port ----------

    onOutput(cb: (b: Uint8Array) => void) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    onPresence(cb: (present: boolean) => void) {
        this.presence.add(cb);
        return () => this.presence.delete(cb);
    }

    private batch: Uint8Array[] | null = null;

    private out(s: string | Uint8Array) {
        const bytes = typeof s === 'string' ? enc.encode(s) : s;
        if (this.batch) {
            this.batch.push(bytes);
            return;
        }
        this.send(bytes);
    }

    private send(bytes: Uint8Array) {
        const gen = this.generation;
        // deliver in small chunks, like USB packets, after a little latency
        this.outQueue = this.outQueue.then(async () => {
            await new Promise(r => setTimeout(r, this.opts.latencyMs));
            for (let i = 0; i < bytes.length; i += 64) {
                if (!this.present || gen !== this.generation) return;
                const chunk = bytes.slice(i, i + 64);
                this.listeners.forEach(l => l(chunk));
            }
        });
    }

    /** bytes from the host (everything answered to one chunk goes out as one USB transfer) */
    input(bytes: Uint8Array) {
        if (!this.present || this.opts.noAnswer) return;
        this.batch = [];
        try {
            this.inputChunk(bytes);
        } finally {
            const parts = this.batch;
            this.batch = null;
            if (parts.length) {
                const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
                let o = 0;
                for (const p of parts) {
                    all.set(p, o);
                    o += p.length;
                }
                this.send(all);
            }
        }
    }

    private inputChunk(bytes: Uint8Array) {
        if (this.cliMode) {
            for (const b of bytes) this.cliChar(b);
            return;
        }
        // MSP idle: frames, plus Betaflight's non-MSP characters ('#' = CLI, 'R' = bootloader).
        // Each byte cancels the previous pending request; the pending one runs when the chunk is consumed.
        let pending: 'cli' | 'dfu' | null = null;
        let i = 0;
        for (; i < bytes.length; i++) {
            const b = bytes[i];
            if (this.mspIn.length > 0 || b === 0x24) {
                this.mspIn.push(b);
                this.mspByte();
                pending = null;
                continue;
            }
            pending = b === 0x23 ? 'cli' : b === 0x52 ? 'dfu' : null;
        }
        if (pending === 'cli') this.enterCli();
        else if (pending === 'dfu') this.enterDfu();
    }

    private mspByte() {
        const m = this.mspIn;
        if (m.length === 2 && m[1] !== 0x4d) this.mspIn = m[1] === 0x24 ? [0x24] : [];
        else if (m.length === 3 && m[2] !== 0x3c) this.mspIn = [];
        else if (m.length >= 6 && m.length === 6 + m[3]) {
            const len = m[3];
            const cmd = m[4];
            let c = len ^ cmd;
            for (let i = 0; i < len; i++) c ^= m[5 + i];
            const ok = c === m[5 + len];
            const payload = Uint8Array.from(m.slice(5, 5 + len));
            this.mspIn = [];
            if (ok) this.handleMsp(cmd, payload);
        }
    }

    private reply(cmd: number, payload: Uint8Array | number[], error = false) {
        const p = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
        const out = new Uint8Array(6 + p.length);
        out.set([0x24, 0x4d, error ? 0x21 : 0x3e, p.length, cmd]);
        let c = p.length ^ cmd;
        p.forEach((b, i) => {
            out[5 + i] = b;
            c ^= b;
        });
        out[5 + p.length] = c;
        this.out(out);
    }

    // ---------- program timeline ----------

    private num(name: string, fallback = 0) {
        const v = parseInt(this.ram[name] ?? '', 10);
        return Number.isFinite(v) ? v : fallback;
    }

    /** volts the board reports (scales with vbat_scale, sags a little under throttle) */
    shownVolts(pct = 0) {
        const real = this.opts.batteryVolts;
        if (real <= 0) return 0;
        return Math.max(0, (real * this.num('vbat_scale', 210)) / 210 - pct * 0.006);
    }

    private batteryPresent() {
        const v = this.shownVolts();
        const min = this.num('autostart_vbat_min', 60) / 10;
        return min === 0 ? true : v >= min;
    }

    /** Betaflight's cell count guess from the voltage it shows (0 without a battery) */
    private bfCells(v = this.shownVolts()) {
        return v > 0 ? Math.max(1, Math.ceil(v / 4.3)) : 0;
    }

    program(now = Date.now()): ProgramView {
        if (this.yielded || this.cliMode) {
            // held by the computer: a running program goes to IDLE, DONE / LOW_BATTERY stay as they are
            if (this.heldState) return { state: this.heldState.state, pct: 0, msInState: (now - this.heldState.since) * this.opts.speed, gust: false, source: 1 };
            return { state: 0, pct: 0, msInState: (now - this.bootAt) * this.opts.speed, gust: false, source: 0 };
        }
        return this.programFree(now);
    }

    /** the computer takes over (CLI, MSP_SET_MOTOR): firmware 1.1 holds the program until the next boot */
    private takeOver(now: number) {
        if (this.yielded || this.cliMode) return;
        const p = this.programFree(now);
        this.heldState = p.state === 4 || p.state === 5 ? { state: p.state, since: now - p.msInState / this.opts.speed } : null;
        this.yielded = true;
    }

    /** the program as it runs when nothing holds it */
    private programFree(now: number): ProgramView {
        const idle: ProgramView = { state: 0, pct: 0, msInState: (now - this.bootAt) * this.opts.speed, gust: false, source: 0 };
        if (!this.ram.autostart_mode) return idle;
        if (this.ram.autostart_mode !== 'POWER') return idle;
        if (this.ram.autostart_usb_inhibit === 'ON') return idle; // a USB host is always connected here
        if (!this.batteryPresent()) return idle;
        const t = (now - this.bootAt) * this.opts.speed;
        const delay = this.num('autostart_delay') * 1000;
        const ramp = this.num('autostart_ramp') * 100;
        const limit = this.ram.autostart_throttle_limit ? this.num('autostart_throttle_limit', 100) : 100;
        const thr = Math.min(limit, this.num('autostart_throttle'));
        // the battery is there from boot: the countdown counts from boot, the ramp waits for the ESC's 3 s of stop frames
        const start = Math.max(delay, 3000);
        const runTime = this.num('autostart_run_time') * 1000;
        const doneAt = runTime > 0 ? start + ramp + runTime : Infinity;
        // the battery cut-off counts in DELAY, RAMP and RUN, from 3 s after the battery appeared, and stays (latched)
        let lowAt = Infinity;
        const cutCv = this.num('autostart_cell_cutoff');
        const cut = cutCv > 0 ? Math.max(250, cutCv) : 0;
        const cells = this.num('autostart_cells') || this.bfCells();
        if (this.ram.autostart_cell_cutoff !== undefined && cut > 0 && cells > 0) {
            const stopV = (cells * cut) / 100;
            const hold = this.num('autostart_cutoff_time', 5) * 1000;
            if (this.shownVolts(0) < stopV) lowAt = 3000 + hold;
            else if (this.shownVolts(thr) < stopV) lowAt = start + ramp + hold; // the sag under the set power
        }
        if (t >= lowAt && lowAt < doneAt) return { state: 5, pct: 0, msInState: t - lowAt, gust: false, source: 1 };
        if (t >= doneAt) return { state: 4, pct: 0, msInState: t - doneAt, gust: false, source: 1 };
        if (t < start) return { state: 1, pct: 0, msInState: t, gust: false, source: 1 };
        if (t < start + ramp) return { state: 2, pct: (thr * (t - start)) / ramp, msInState: t - start, gust: false, source: 1 };
        const runFor = t - start - ramp;
        let pct = thr;
        let gust = false;
        if (this.ram.autostart_pattern === 'GUSTS') {
            const r = rng(7);
            const lo = (a: string, b: string) => Math.min(this.num(a), this.num(b));
            const hi = (a: string, b: string) => Math.max(this.num(a), this.num(b));
            let at = 0;
            for (let i = 0; i < 100000 && at <= runFor; i++) {
                const pause = (lo('autostart_gust_pause_min', 'autostart_gust_pause_max') + r() * (hi('autostart_gust_pause_min', 'autostart_gust_pause_max') - lo('autostart_gust_pause_min', 'autostart_gust_pause_max'))) * 100;
                const len = lo('autostart_gust_len_min', 'autostart_gust_len_max') + r() * (hi('autostart_gust_len_min', 'autostart_gust_len_max') - lo('autostart_gust_len_min', 'autostart_gust_len_max'));
                const peak = lo('autostart_gust_min', 'autostart_gust_max') + r() * (hi('autostart_gust_min', 'autostart_gust_max') - lo('autostart_gust_min', 'autostart_gust_max'));
                if (runFor >= at + pause && runFor < at + pause + len) {
                    pct = Math.min(limit, Math.max(thr, peak));
                    gust = true;
                    break;
                }
                at += pause + Math.max(1, len);
            }
        }
        return { state: 3, pct, msInState: runFor, gust, source: 1 };
    }

    motorOutputs(now = Date.now()): number[] {
        if (this.motorsOverride) return this.motorsOverride.slice(0, 8);
        const p = this.program(now);
        const mask = this.num('autostart_motors', 15);
        return Array.from({ length: 8 }, (_, i) => (i < 4 ? ((mask >> i) & 1 ? Math.round(1000 + p.pct * 10) : 1000) : 0));
    }

    // ---------- MSP ----------

    private handleMsp(cmd: number, p: Uint8Array) {
        this.mspLog.push(cmd);
        const u16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
        const i16 = (n: number) => u16(n < 0 ? 0x10000 + n : n);
        const pstr = (s: string) => [s.length, ...enc.encode(s)];
        const now = Date.now();
        this.syncBattery(now);
        switch (cmd) {
            case 1:
                return this.reply(cmd, [0, 1, 47]);
            case 2:
                return this.reply(cmd, enc.encode(this.opts.firmware === 'inav' ? 'INAV' : 'BTFL'));
            case 3:
                return this.reply(cmd, [25, 12, 1, ...pstr('2025.12.1')]);
            case 4:
                return this.reply(cmd, [...enc.encode('S405'), 0, 0, 0, 1, ...pstr('STM32F405'), ...pstr('HGLRC_F405_S8'), ...pstr('HGLR'), ...new Array(32).fill(0), 1, 2, ...u16(8000), 0, 0, 0, 0, 1, 0]);
            case 5: {
                const rev = this.opts.firmware === 'stock' || this.opts.firmware === 'inav' ? '90d1868' : 'as-90d1';
                return this.reply(cmd, enc.encode(`Oct 19 202619:59:53${rev}`));
            }
            case 68:
                this.reply(cmd, []);
                setTimeout(() => this.reboot(), 20);
                return;
            case 104:
                return this.reply(cmd, this.motorOutputs(now).flatMap(u16));
            case 130: {
                const pr = this.program(now);
                const v = this.shownVolts(pr.pct);
                const cells = v > 0 ? Math.max(1, Math.ceil(v / 4.3)) : 0;
                return this.reply(cmd, [cells, ...u16(1500), Math.round(v * 10) & 0xff, ...u16(12), ...i16(Math.round(pr.pct * 30)), 0, ...u16(Math.round(v * 100))]);
            }
            case 139: {
                const motors = this.motorOutputs(now);
                // a BLHeli_32 that stayed powered while the board restarted (the battery on a USB bench) only beeps,
                // until the battery is plugged in again (the ESC restarts)
                const locked = this.opts.escLocked && this.reboots > 0 && !this.escRepowered;
                // no battery: the ESC is off and sends nothing
                const powered = this.batteryOn;
                const bidir = this.ram.dshot_bidir === 'ON' && this.opts.esc !== 'none' && !locked && powered;
                const sensor = this.opts.esc === 'sensor';
                const escPct = Math.max(0, (motors[this.opts.escOutput] - 1000) / 10);
                // the TX wire: nothing is sent after a board (or ESC) start until the motor has turned once
                if (sensor && escPct > 0 && !locked && powered) this.sensorLive = true;
                // the battery went away: MSP keeps the ESC's last frame until the motor turns on the next battery
                if (this.frozenEsc) {
                    if (this.sensorLive) this.frozenEsc = null;
                    else return this.reply(cmd, this.frozenEsc);
                }
                this.escAnswers++;
                const s = this.opts.escSparse;
                const empty = sensor && s > 0 && Math.floor(this.escAnswers * s) > Math.floor((this.escAnswers - 1) * s);
                const dshot = this.ram.dshot_bidir === 'ON';
                const out: number[] = [4];
                for (let i = 0; i < 4; i++) {
                    const esc = i === this.opts.escOutput;
                    const pct = Math.max(0, (motors[i] - 1000) / 10);
                    const live = esc && (bidir || (this.sensorLive && !empty));
                    const rpm = live && !locked ? Math.round(pct * 380 + (pct > 0 ? (now % 7) * 3 : 0)) : 0;
                    // bad frames: only with DShot telemetry (100 % on an output nothing answers on); the TX wire has none
                    const inv = !dshot ? 0 : esc && bidir ? 40 : 10000;
                    // the ESC measures the real pack voltage, independent of the board's vbat_scale; MSP keeps the
                    // last TX-wire value (a stale one after a restart) until the ESC sends again
                    let ev = live && this.opts.batteryVolts > 0 ? Math.round((this.opts.batteryVolts - pct * 0.006) * 100) : 0;
                    if (esc && sensor && !this.sensorLive && this.opts.escStaleVolts > 0) ev = Math.round(this.opts.escStaleVolts * 100);
                    out.push(rpm & 0xff, (rpm >> 8) & 0xff, (rpm >> 16) & 0xff, 0, ...u16(inv), live ? 31 : 0, ...u16(ev), ...u16(0), ...u16(0));
                }
                // what Betaflight keeps when the ESC stops sending: its last frame with data
                const b = 1 + this.opts.escOutput * 13;
                if (sensor && this.sensorLive && out.slice(b, b + 13).some(x => x !== 0)) this.lastEscFrame = out.slice();
                return this.reply(cmd, out);
            }
            case 214: {
                const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
                const vals = Array.from({ length: 8 }, (_, i) => (i * 2 + 1 < p.length ? dv.getUint16(i * 2, true) : 1000));
                const stop = vals.every(v => v <= 1000);
                // firmware 1.0 has no hold: a STOP before the program wrote its outputs (the countdown) does nothing
                if (this.opts.firmware === '1.0' && stop && !this.yielded && this.programFree(now).state === 1) return this.reply(cmd, []);
                this.takeOver(now);
                this.motorsOverride = stop ? null : vals;
                return this.reply(cmd, []);
            }
            case 254: {
                if (this.ram.debug_mode !== 'AUTOSTART') return this.reply(cmd, new Array(16).fill(0));
                const pr = this.program(now);
                const up = Math.round(((now - this.bootAt) * this.opts.speed) / 100);
                const v = this.shownVolts();
                const cells = this.num('autostart_cells') || this.bfCells(v);
                // [6]: 0.1 s since the battery appeared (the boot when it was there from the start), -1 without one
                const since = v > 0 ? Math.round(((now - this.batteryAt) * this.opts.speed) / 100) : -1;
                // bit 32 is hidden for 3 s after the battery appeared, while the filtered voltage rises
                const implausible = since >= 30 && cells > 0 && (v / cells < 2.5 || v / cells > 4.45);
                const held = this.yielded && this.opts.firmware !== '1.0';
                const flags = 1 | (v > 0 && this.batteryPresent() ? 8 : 0) | (pr.gust ? 16 : 0) | (implausible ? 32 : 0) | (held ? 64 : 0);
                // like the firmware: [2] ms in state /10 as uint16 (1.0: int16), stopping at the top; [3] and [6] stop at 32767
                const ms10 = Math.min(Math.round(pr.msInState / 10), this.opts.firmware === '1.0' ? 0x7fff : 0xffff);
                const d = [pr.state, Math.round(pr.pct * 10), ms10 > 0x7fff ? ms10 - 0x10000 : ms10, Math.min(up, 0x7fff), flags, Math.round(this.shownVolts(pr.pct) * 10), since < 0 ? -1 : Math.min(since, 0x7fff), pr.source];
                return this.reply(cmd, d.flatMap(i16));
            }
            default:
                return this.reply(cmd, [], true);
        }
    }

    // ---------- CLI ----------

    private enterCli() {
        this.takeOver(Date.now()); // entering the CLI stops the program (by design)
        this.cliMode = true;
        this.cliBuf = '';
        this.out("\r\nEntering CLI Mode, type 'exit' to reboot, or 'help'\r\n\r\n# ");
    }

    private cliChar(b: number) {
        const c = String.fromCharCode(b);
        if (this.cliBuf.length && (c === '\r' || c === '\n')) {
            this.out('\r\n');
            let line = this.cliBuf;
            const hash = line.indexOf('#');
            if (hash >= 0) line = line.slice(0, hash);
            line = line.replace(/ +$/, '');
            this.cliBuf = '';
            if (line) {
                this.cliLog.push(line);
                this.cliCommand(line);
                if (!this.cliMode) return;
            }
            this.out('\r\n# ');
        } else if (b >= 32 && b <= 126) {
            if (!this.cliBuf.length && c === ' ') return;
            this.cliBuf += c;
            this.out(c); // echo
        }
    }

    private varLines(v: VarSpec, value: string) {
        let s = `${v.name} = ${value}\r\n`;
        s += v.kind === 'lookup' ? `Allowed values: ${v.values!.join(', ')}\r\n` : `Allowed range: ${v.min} - ${v.max}\r\n`;
        if (value !== v.def) s += `Default value: ${v.def}\r\n`;
        return s;
    }

    private cliCommand(line: string) {
        const [cmd, ...rest] = line.split(' ');
        const args = rest.join(' ').trim();
        switch (cmd.toLowerCase()) {
            case 'get': {
                const m = this.vars.filter(v => v.name.toLowerCase().includes(args.toLowerCase()));
                if (!m.length) return this.out(`###ERROR IN get: INVALID NAME: ${args}###\r\n`);
                return this.out(m.map(v => this.varLines(v, this.ram[v.name])).join('\r\n'));
            }
            case 'set': {
                const eq = args.indexOf('=');
                if (eq < 0) return this.out(`###ERROR IN set: INVALID NAME: ${args}###\r\n`);
                const name = args.slice(0, eq).trim();
                const val = args.slice(eq + 1).trim();
                const v = this.vars.find(x => x.name === name.toLowerCase());
                if (!v) return this.out(`###ERROR IN set: INVALID NAME: ${args}###\r\n`);
                let ok = false;
                let stored = '';
                if (v.kind === 'lookup') {
                    const hit = v.values!.find(x => x.toLowerCase() === val.toLowerCase());
                    if (hit) {
                        ok = true;
                        stored = hit;
                    }
                } else {
                    const n = parseInt(val, 10);
                    if (/^-?\d+$/.test(val) && n >= v.min! && n <= v.max!) {
                        ok = true;
                        stored = String(n);
                    }
                }
                if (this.opts.invalidValueFor.includes(v.name)) ok = false;
                if (!ok) {
                    const range = v.kind === 'lookup' ? `Allowed values: ${v.values!.join(', ')}\r\n` : `Allowed range: ${v.min} - ${v.max}\r\n`;
                    return this.out(`###ERROR IN set: INVALID VALUE###\r\n${range}`);
                }
                this.ram[v.name] = stored;
                return this.out(`${v.name} set to ${stored}`);
            }
            case 'save': {
                for (const [k, v] of Object.entries(this.ram)) if (!this.opts.saveIgnores.includes(k)) this.flash[k] = v;
                this.out('\r\n# saving\r\n');
                if (args.toLowerCase() === 'noreboot') return;
                this.out('\r\nRebooting');
                this.cliMode = false;
                setTimeout(() => this.reboot(), 30);
                return;
            }
            case 'exit': {
                this.motorsOverride = null;
                if (args.toLowerCase() === 'noreboot') {
                    this.out('\r\n# leaving CLI mode, no reboot\r\n');
                    this.cliMode = false;
                    return;
                }
                this.out('\r\n# leaving CLI mode, unsaved changes lost\r\n\r\nRebooting');
                this.cliMode = false;
                setTimeout(() => this.reboot(), 30);
                return;
            }
            case 'feature':
                // Betaflight prints the enabled features on one line
                return this.out(`Enabled: ${this.features.join(' ')} `);
            case 'version':
                return this.out('# Betaflight / STM32F405 (S405) 2025.12.1 Oct 19 2026 / 19:59:53 (as-90d1) MSP API: 1.47\r\n# board: manufacturer_id: HGLR, board_name: HGLRC_F405_S8');
            case 'status':
                return this.out('MCU F405 Clock=168MHz, Vref=3.31V, Core temp=41degC\r\nArming disable flags: CLI');
            default:
                return this.out("###ERROR IN input: UNKNOWN COMMAND, TRY 'HELP'###");
        }
    }

    // ---------- power / USB ----------

    reboot() {
        this.reboots++;
        this.setPresent(false);
        if (this.opts.neverReturnAfterReboot) return;
        this.scheduleBoot(this.opts.rebootMs);
    }

    private scheduleBoot(ms: number) {
        if (this.bootTimer) clearTimeout(this.bootTimer);
        this.bootTimer = setTimeout(() => {
            this.bootTimer = null;
            this.boot();
        }, ms);
    }

    /** the board starts (again): a new USB device; it was gone first, even when nobody saw it go */
    boot() {
        if (this.present) this.setPresent(false);
        this.ram = { ...this.flash };
        this.cliMode = false;
        this.cliBuf = '';
        this.yielded = false;
        this.heldState = null;
        this.sensorLive = false;
        this.motorsOverride = null;
        this.mspIn = [];
        this.bootAt = Date.now();
        // the board's RAM starts empty: no ESC frame kept; a battery that is there counts from the boot
        this.batteryOn = this.opts.batteryVolts > 0;
        this.batteryAt = this.bootAt;
        this.escRepowered = false;
        this.lastEscFrame = null;
        this.frozenEsc = null;
        this.generation++;
        this.setPresent(true);
    }

    /** plug the battery in (volts > 0), swap it, or unplug it (0) while USB stays connected */
    setBattery(volts: number) {
        this.opts.batteryVolts = Math.max(0, volts);
        this.syncBattery();
    }

    /** a battery plugged in or out (also when opts.batteryVolts was changed directly): the ESC goes off or restarts */
    private syncBattery(now = Date.now()) {
        const on = this.opts.batteryVolts > 0;
        if (on === this.batteryOn) return;
        this.batteryOn = on;
        // the ESC lost its power or starts again: over the TX wire it sends nothing until the motor turns
        this.sensorLive = false;
        if (on) {
            this.batteryAt = now;
            this.escRepowered = true;
        } else if (this.opts.escFreeze && this.opts.esc === 'sensor' && this.lastEscFrame && !this.frozenEsc) {
            // Betaflight keeps the last ESC frame; at a stop its rpm was 0, unplugged while turning it stays
            const f = this.lastEscFrame.slice();
            if (this.opts.escFreeze !== 'rpm') f.fill(0, 1 + this.opts.escOutput * 13, 1 + this.opts.escOutput * 13 + 4);
            this.frozenEsc = f;
        }
    }

    private enterDfu() {
        this.dfuEntered = true;
        this.setPresent(false);
    }

    /** simulate pulling the USB cable (and plugging it back after `ms`, if given) */
    unplug(ms?: number) {
        this.setPresent(false);
        // a pending reboot never lands on top of the plug-in (one boot, not two)
        if (this.bootTimer) clearTimeout(this.bootTimer);
        this.bootTimer = null;
        if (ms !== undefined) this.scheduleBoot(ms);
    }

    private setPresent(p: boolean) {
        this.present = p;
        this.presence.forEach(cb => cb(p));
    }
}

// ---------- a fake navigator.serial on top of the mock ----------

const domError = (name: string, message: string) => {
    try {
        return new DOMException(message, name);
    } catch {
        const e = new Error(message);
        e.name = name;
        return e;
    }
};

class MockPort implements SerialPortLike {
    readable: ReadableStream<Uint8Array> | null = null;
    writable: WritableStream<Uint8Array> | null = null;
    private ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    private off: (() => void)[] = [];
    private isOpen = false;

    constructor(private readonly mock: MockFc, readonly generation: number) {}

    get connected() {
        return this.mock.present && this.mock.generation === this.generation;
    }

    getInfo() {
        return { usbVendorId: 0x0483, usbProductId: 0x5740 };
    }

    async open(_o: { baudRate: number }) {
        if (this.isOpen) throw domError('InvalidStateError', 'The port is already open.');
        if (this.mock.opts.busy || !this.connected) throw domError('NetworkError', 'Failed to open serial port.');
        this.isOpen = true;
        this.readable = new ReadableStream<Uint8Array>({
            start: c => {
                this.ctrl = c;
            },
            cancel: () => {
                this.ctrl = null;
            }
        });
        this.writable = new WritableStream<Uint8Array>({
            write: chunk => {
                if (!this.connected) throw domError('NetworkError', 'The device has been lost.');
                const copy = chunk.slice();
                setTimeout(() => this.mock.input(copy), this.mock.opts.latencyMs);
            }
        });
        this.off.push(
            this.mock.onOutput(b => {
                try {
                    this.ctrl?.enqueue(b);
                } catch { /* closed */ }
            }) as () => void,
            this.mock.onPresence(p => {
                if (!p) this.lose();
            }) as () => void
        );
    }

    private lose() {
        const c = this.ctrl;
        this.ctrl = null;
        this.readable = null;
        this.writable = null;
        this.detach();
        try {
            c?.error(domError('NetworkError', 'The device has been lost.'));
        } catch { /* already closed */ }
    }

    private detach() {
        this.off.forEach(f => f());
        this.off = [];
    }

    async close() {
        if (!this.isOpen) throw domError('InvalidStateError', 'The port is already closed.');
        this.isOpen = false;
        try {
            this.ctrl?.close();
        } catch { /* ignore */ }
        this.ctrl = null;
        this.readable = null;
        this.writable = null;
        this.detach();
    }
}

export class MockSerial extends EventTarget implements SerialLike {
    private ports = new Map<number, MockPort>();

    constructor(readonly mock: MockFc) {
        super();
        mock.onPresence(p => {
            const port = this.portFor(p ? mock.generation : mock.generation);
            const e = new Event(p ? 'connect' : 'disconnect');
            (e as Event & { port?: MockPort }).port = port;
            this.dispatchEvent(e);
        });
    }

    private portFor(gen: number) {
        let p = this.ports.get(gen);
        if (!p) {
            p = new MockPort(this.mock, gen);
            this.ports.set(gen, p);
        }
        return p;
    }

    async requestPort(_options?: unknown): Promise<SerialPortLike> {
        if (this.mock.opts.cancelPicker || !this.mock.present) throw domError('NotFoundError', 'No port selected by the user.');
        return this.portFor(this.mock.generation);
    }

    async getPorts(): Promise<SerialPortLike[]> {
        return this.mock.present ? [this.portFor(this.mock.generation)] : [];
    }
}

/**
 * URL switches for demos and the browser tests (values are stored the way the CLI would store them):
 *   mockFw=1.1|1.0|stock|inav · mockReboot=<ms> · mockSpeed=<x> · mockVolts=<V> · mockScale=<vbat_scale>
 *   mockSet=autostart_delay:45,autostart_throttle:22 (flash values) · mockInvalid=<names> · mockSaveIgnores=<names>
 *   mockNoReturn=1 (never back after a reboot) · mockBusy=1 (port busy) · mockCancel=1 (picker cancelled)
 *   mockNoAnswer=1 (a port that never answers) · mockCliOpen=1 (CLI left open) · mockCliUnsaved=autostart_delay:45
 *   (CLI left open with unsaved values in RAM) · mockHeld=1 (starts held, bit 64) · mockLatency=<ms>
 *   mockEsc=sensor|bidir|none (telemetry over the TX wire — the default —, bidirectional DShot, or none)
 *   mockEscVolts=14.81 (TX wire: a stale voltage until the motor turns once) · mockEscSparse=0.5 (share of empty
 *   answers) · mockEscLocked=1 (after a restart the ESC only beeps) · mockEscOutput=<0-based output>
 *   mockEscFreeze=1|rpm (TX wire: a battery unplugged with USB connected leaves MSP with the ESC's last frame until
 *   the motor turns on the next battery; rpm = with the old rpm too)
 */
export const mockOptionsFromQuery = (q: URLSearchParams): MockOptions => {
    const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
    const pairs = (k: string) => {
        const out: Record<string, string> = {};
        for (const pair of (q.get(k) ?? '').split(',')) {
            const [a, v] = pair.split(':');
            if (a && v !== undefined) out[a.trim()] = v.trim();
        }
        return out;
    };
    const fw = q.get('mockFw');
    const flash = pairs('mockSet');
    if (q.has('mockScale')) flash.vbat_scale = String(Number(q.get('mockScale')));
    const unsaved = pairs('mockCliUnsaved');
    const esc = q.get('mockEsc');
    return {
        firmware: fw === '1.0' || fw === 'stock' || fw === 'inav' ? fw : '1.1',
        rebootMs: num('mockReboot'),
        speed: num('mockSpeed'),
        batteryVolts: num('mockVolts'),
        invalidValueFor: q.get('mockInvalid')?.split(',').filter(Boolean),
        neverReturnAfterReboot: q.get('mockNoReturn') === '1',
        saveIgnores: q.get('mockSaveIgnores')?.split(',').filter(Boolean),
        busy: q.get('mockBusy') === '1',
        cancelPicker: q.get('mockCancel') === '1',
        noAnswer: q.get('mockNoAnswer') === '1',
        cliOpenAtStart: q.get('mockCliOpen') === '1',
        cliUnsaved: Object.keys(unsaved).length ? unsaved : undefined,
        heldAtStart: q.get('mockHeld') === '1',
        latencyMs: num('mockLatency'),
        esc: esc === 'bidir' || esc === 'none' || esc === 'sensor' ? esc : undefined,
        escStaleVolts: num('mockEscVolts'),
        escSparse: num('mockEscSparse'),
        escLocked: q.get('mockEscLocked') === '1',
        escFreeze: q.get('mockEscFreeze') === 'rpm' ? 'rpm' : q.get('mockEscFreeze') === '1',
        escOutput: num('mockEscOutput'),
        flash: Object.keys(flash).length ? flash : undefined
    };
};
