// In-memory emulator of an HGLRC F405 8S running Shramko Motor Autostart on Betaflight 2025.12.1:
// MSP v1, the interactive CLI (echo, get/set/save/exit), flash vs RAM, reboot with the USB port
// disappearing and coming back as a new port object, and a simple program timeline
// (DELAY → RAMP → RUN, gusts, run time) so the live view moves. Used by the tests and by ?mock=1.
// Behaviour copied from betaflight-2025.12.1/src/main/cli/cli.c and msp/msp_serial.c.

import { SCHEMA, type SettingDef } from './settings';
import type { SerialLike, SerialPortLike } from './transport';

export type MockFirmware = '1.1' | '1.0' | 'stock' | 'inav';

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

/** project build defaults (HGLRC_F405_S8 config): what `get` reports as "Default value" */
const BUILD_DEFAULTS: Record<string, string> = { vbat_scale: '210', debug_mode: 'AUTOSTART', dshot_bidir: 'ON' };

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

export interface ProgramView {
    state: number;
    pct: number;
    msInState: number;
    gust: boolean;
    source: number;
}

export class MockFc {
    readonly opts: Required<Omit<MockOptions, 'flash'>>;
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
            latencyMs: opts.latencyMs ?? 1
        };
        this.vars = this.opts.firmware === 'stock' || this.opts.firmware === 'inav' ? varsFor('1.0').filter(v => !v.name.startsWith('autostart_')) : varsFor(this.opts.firmware);
        for (const v of this.vars) this.flash[v.name] = v.def;
        for (const [k, v] of Object.entries(opts.flash ?? {})) if (k in this.flash) this.flash[k] = String(v).toUpperCase();
        this.ram = { ...this.flash };
        if (this.opts.cliOpenAtStart) {
            this.cliMode = true;
            this.yielded = true;
        }
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

    private out(s: string | Uint8Array) {
        const bytes = typeof s === 'string' ? enc.encode(s) : s;
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

    /** bytes from the host */
    input(bytes: Uint8Array) {
        if (!this.present) return;
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

    program(now = Date.now()): ProgramView {
        const idle: ProgramView = { state: 0, pct: 0, msInState: (now - this.bootAt) * this.opts.speed, gust: false, source: 0 };
        if (this.yielded || this.cliMode || !this.ram.autostart_mode) return idle;
        if (this.ram.autostart_mode !== 'POWER') return idle;
        if (this.ram.autostart_usb_inhibit === 'ON') return idle; // a USB host is always connected here
        if (!this.batteryPresent()) return idle;
        const t = (now - this.bootAt) * this.opts.speed;
        const delay = this.num('autostart_delay') * 1000;
        const ramp = this.num('autostart_ramp') * 100;
        const limit = this.ram.autostart_throttle_limit ? this.num('autostart_throttle_limit', 100) : 100;
        const thr = Math.min(limit, this.num('autostart_throttle'));
        if (t < delay) return { state: 1, pct: 0, msInState: t, gust: false, source: 1 };
        if (t < delay + ramp) return { state: 2, pct: (thr * (t - delay)) / ramp, msInState: t - delay, gust: false, source: 1 };
        const runFor = t - delay - ramp;
        const runTime = this.num('autostart_run_time') * 1000;
        if (runTime > 0 && runFor >= runTime) return { state: 4, pct: 0, msInState: runFor - runTime, gust: false, source: 1 };
        const cells = this.num('autostart_cells');
        const cut = this.num('autostart_cell_cutoff');
        if (cut > 0 && cells > 0 && this.shownVolts(thr) < (cells * cut) / 100) {
            const hold = this.num('autostart_cutoff_time', 5) * 1000;
            if (runFor >= hold) return { state: 5, pct: 0, msInState: runFor - hold, gust: false, source: 1 };
        }
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
                const bidir = this.ram.dshot_bidir === 'ON';
                const motors = this.motorOutputs(now);
                const out: number[] = [4];
                for (let i = 0; i < 4; i++) {
                    const esc = i === this.opts.escOutput;
                    const pct = Math.max(0, (motors[i] - 1000) / 10);
                    const rpm = bidir && esc ? Math.round(pct * 380 + (pct > 0 ? (now % 7) * 3 : 0)) : 0;
                    const inv = !bidir ? 0 : esc ? 40 : 10000;
                    const ev = bidir && esc ? Math.round(this.shownVolts(pct) * 100) : 0;
                    out.push(rpm & 0xff, (rpm >> 8) & 0xff, (rpm >> 16) & 0xff, 0, ...u16(inv), bidir && esc ? 31 : 0, ...u16(ev), ...u16(0), ...u16(0));
                }
                return this.reply(cmd, out);
            }
            case 214: {
                const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
                const vals = Array.from({ length: 8 }, (_, i) => (i * 2 + 1 < p.length ? dv.getUint16(i * 2, true) : 1000));
                this.yielded = true;
                this.motorsOverride = vals.every(v => v <= 1000) ? null : vals;
                return this.reply(cmd, []);
            }
            case 254: {
                if (this.ram.debug_mode !== 'AUTOSTART') return this.reply(cmd, new Array(16).fill(0));
                const pr = this.program(now);
                const up = Math.round(((now - this.bootAt) * this.opts.speed) / 100);
                const flags = 1 | (this.shownVolts() > 0 && this.batteryPresent() ? 8 : 0) | (pr.gust ? 16 : 0);
                const since = this.shownVolts() > 0 ? up : -1;
                const ms10 = Math.round(pr.msInState / 10) & 0xffff;
                const d = [pr.state, Math.round(pr.pct * 10), ms10 > 0x7fff ? ms10 - 0x10000 : ms10, up & 0x7fff, flags, Math.round(this.shownVolts(pr.pct) * 10), since & 0x7fff, pr.source];
                return this.reply(cmd, d.flatMap(i16));
            }
            default:
                return this.reply(cmd, [], true);
        }
    }

    // ---------- CLI ----------

    private enterCli() {
        this.cliMode = true;
        this.cliBuf = '';
        this.yielded = true; // entering the CLI stops the program (by design)
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
        setTimeout(() => this.boot(), this.opts.rebootMs);
    }

    private boot() {
        this.ram = { ...this.flash };
        this.cliMode = false;
        this.cliBuf = '';
        this.yielded = false;
        this.motorsOverride = null;
        this.mspIn = [];
        this.bootAt = Date.now();
        this.generation++;
        this.setPresent(true);
    }

    private enterDfu() {
        this.dfuEntered = true;
        this.setPresent(false);
    }

    /** simulate pulling the USB cable (and plugging it back after `ms`, if given) */
    unplug(ms?: number) {
        this.setPresent(false);
        if (ms !== undefined) setTimeout(() => this.boot(), ms);
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

    async requestPort(): Promise<SerialPortLike> {
        if (this.mock.opts.cancelPicker || !this.mock.present) throw domError('NotFoundError', 'No port selected by the user.');
        return this.portFor(this.mock.generation);
    }

    async getPorts(): Promise<SerialPortLike[]> {
        return this.mock.present ? [this.portFor(this.mock.generation)] : [];
    }
}

/** URL switches for demos and the browser tests: ?mock=1&mockFw=1.0&mockInvalid=autostart_delay&mockNoReturn=1&mockReboot=300&mockSpeed=4 */
export const mockOptionsFromQuery = (q: URLSearchParams): MockOptions => {
    const num = (k: string) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
    const fw = q.get('mockFw');
    return {
        firmware: fw === '1.0' || fw === 'stock' || fw === 'inav' ? fw : '1.1',
        rebootMs: num('mockReboot'),
        speed: num('mockSpeed'),
        batteryVolts: num('mockVolts'),
        invalidValueFor: q.get('mockInvalid')?.split(',').filter(Boolean),
        neverReturnAfterReboot: q.get('mockNoReturn') === '1',
        saveIgnores: q.get('mockSaveIgnores')?.split(',').filter(Boolean),
        busy: q.get('mockBusy') === '1',
        flash: q.has('mockScale') ? { vbat_scale: Number(q.get('mockScale')) } : undefined
    };
};
