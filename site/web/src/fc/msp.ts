// MSP v1 (MultiWii Serial Protocol) as Betaflight 2025.12.1 speaks it over USB VCP.
// Request "$M<" len cmd payload xor, reply "$M>", error "$M!". Little-endian payloads.

import { FcError, type Transport } from './transport';

export const MSP = {
    API_VERSION: 1,
    FC_VARIANT: 2,
    FC_VERSION: 3,
    BOARD_INFO: 4,
    BUILD_INFO: 5,
    REBOOT: 68,
    MOTOR: 104,
    BATTERY_STATE: 130,
    MOTOR_TELEMETRY: 139,
    SET_MOTOR: 214,
    DEBUG: 254
} as const;

export interface MspFrame {
    cmd: number;
    payload: Uint8Array;
    /** true for "$M!" (the board does not know the command or refused it) */
    error: boolean;
}

/** Encode one MSP v1 request frame. */
export const encodeMsp = (cmd: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array => {
    if (cmd < 0 || cmd > 255) throw new RangeError(`MSP v1 command out of range: ${cmd}`);
    if (payload.length > 254) throw new RangeError('MSP v1 payload too long');
    const out = new Uint8Array(6 + payload.length);
    out[0] = 0x24; // $
    out[1] = 0x4d; // M
    out[2] = 0x3c; // <
    out[3] = payload.length;
    out[4] = cmd;
    let c = payload.length ^ cmd;
    for (let i = 0; i < payload.length; i++) {
        out[5 + i] = payload[i];
        c ^= payload[i];
    }
    out[5 + payload.length] = c;
    return out;
};

/** Streaming parser: feed any chunks (also CLI text), get complete, checksum-valid frames. */
export class MspParser {
    private state = 0;
    private dir = 0;
    private len = 0;
    private cmd = 0;
    private buf: number[] = [];
    private sum = 0;
    /** frames dropped because the checksum did not match */
    badFrames = 0;

    constructor(private readonly onFrame: (f: MspFrame) => void) {}

    push(chunk: Uint8Array) {
        for (let i = 0; i < chunk.length; i++) this.byte(chunk[i]);
    }

    private byte(b: number) {
        switch (this.state) {
            case 0:
                if (b === 0x24) this.state = 1;
                return;
            case 1:
                this.state = b === 0x4d ? 2 : b === 0x24 ? 1 : 0;
                return;
            case 2:
                if (b === 0x3e || b === 0x21) {
                    this.dir = b;
                    this.state = 3;
                } else {
                    this.state = b === 0x24 ? 1 : 0;
                }
                return;
            case 3:
                this.len = b;
                this.sum = b;
                this.buf = [];
                this.state = 4;
                return;
            case 4:
                this.cmd = b;
                this.sum ^= b;
                this.state = this.len > 0 ? 5 : 6;
                return;
            case 5:
                this.buf.push(b);
                this.sum ^= b;
                if (this.buf.length >= this.len) this.state = 6;
                return;
            case 6:
                this.state = 0;
                if (b !== this.sum) {
                    this.badFrames++;
                    return;
                }
                this.onFrame({ cmd: this.cmd, payload: Uint8Array.from(this.buf), error: this.dir === 0x21 });
                return;
        }
    }
}

interface Pending {
    cmd: number;
    payload: Uint8Array;
    timeoutMs: number;
    resolve: (p: Uint8Array) => void;
    reject: (e: unknown) => void;
}

/** One request at a time; a priority request (STOP) jumps the queue. */
export class MspClient {
    private readonly parser: MspParser;
    private queue: Pending[] = [];
    private current: (Pending & { timer: ReturnType<typeof setTimeout> }) | null = null;
    private unsubscribe: () => void;

    constructor(private readonly transport: Transport) {
        this.parser = new MspParser(f => this.onFrame(f));
        this.unsubscribe = transport.onData(b => this.parser.push(b));
    }

    dispose() {
        this.unsubscribe();
        this.failAll(new FcError('not-open', 'MSP client disposed'));
    }

    /** Fail everything in flight (used when the port is lost). */
    failAll(e: unknown) {
        const q = this.queue;
        this.queue = [];
        if (this.current) {
            clearTimeout(this.current.timer);
            this.current.reject(e);
            this.current = null;
        }
        q.forEach(p => p.reject(e));
    }

    request(cmd: number, payload: Uint8Array = new Uint8Array(0), opts: { timeoutMs?: number; priority?: boolean } = {}): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const p: Pending = { cmd, payload, timeoutMs: opts.timeoutMs ?? 400, resolve, reject };
            if (opts.priority) this.queue.unshift(p);
            else this.queue.push(p);
            this.next();
        });
    }

    /** request() with retries on timeout (not on "$M!" errors). */
    async ask(cmd: number, payload?: Uint8Array, opts: { timeoutMs?: number; retries?: number; priority?: boolean } = {}): Promise<Uint8Array> {
        const retries = opts.retries ?? 2;
        let last: unknown;
        for (let i = 0; i <= retries; i++) {
            try {
                return await this.request(cmd, payload, opts);
            } catch (e) {
                last = e;
                if (e instanceof FcError && e.code !== 'timeout') throw e;
            }
        }
        throw last;
    }

    private next() {
        if (this.current || this.queue.length === 0) return;
        const p = this.queue.shift()!;
        const timer = setTimeout(() => {
            if (this.current?.timer !== timer) return;
            this.current = null;
            p.reject(new FcError('timeout', `MSP ${p.cmd}: no answer in ${p.timeoutMs} ms`));
            this.next();
        }, p.timeoutMs);
        this.current = { ...p, timer };
        this.transport.write(encodeMsp(p.cmd, p.payload)).catch(e => {
            if (this.current?.timer !== timer) return;
            clearTimeout(timer);
            this.current = null;
            p.reject(e);
            this.next();
        });
    }

    private onFrame(f: MspFrame) {
        const c = this.current;
        if (!c || f.cmd !== c.cmd) return; // late answer to a timed-out request, or noise
        clearTimeout(c.timer);
        this.current = null;
        if (f.error) c.reject(new FcError('msp-error', `MSP ${f.cmd}: the board answered with an error`));
        else c.resolve(f.payload);
        this.next();
    }
}

// ---------- decoders (all defensive: short payloads give undefined fields, never throw) ----------

const view = (p: Uint8Array) => new DataView(p.buffer, p.byteOffset, p.byteLength);
const ascii = (p: Uint8Array, start: number, len: number) => {
    let s = '';
    for (let i = start; i < Math.min(p.length, start + len); i++) {
        const c = p[i];
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
};

export const parseApiVersion = (p: Uint8Array) => (p.length >= 3 ? `${p[1]}.${p[2]}` : '');

export const parseFcVariant = (p: Uint8Array) => ascii(p, 0, 4);

export const parseFcVersion = (p: Uint8Array): string => {
    if (p.length < 3) return '';
    if (p.length > 4 && p[3] > 0 && p.length >= 4 + p[3]) return ascii(p, 4, p[3]);
    // older firmware: plain major.minor.patch; 2025+ calendar versions send year - 2000
    return p[0] < 20 ? `${p[0]}.${p[1]}.${p[2]}` : `${2000 + p[0]}.${p[1]}.${p[2]}`;
};

export interface BoardInfo {
    identifier: string;
    hardwareRevision: number;
    targetName: string;
    boardName: string;
    manufacturerId: string;
}

export const parseBoardInfo = (p: Uint8Array): BoardInfo => {
    const out: BoardInfo = { identifier: ascii(p, 0, 4), hardwareRevision: 0, targetName: '', boardName: '', manufacturerId: '' };
    if (p.length >= 6) out.hardwareRevision = view(p).getUint16(4, true);
    let o = 8; // 4 id + 2 hw rev + 1 board type + 1 capabilities
    const pstr = () => {
        if (o >= p.length) return '';
        const n = p[o];
        const s = ascii(p, o + 1, n);
        o += 1 + n;
        return s;
    };
    out.targetName = pstr();
    out.boardName = pstr();
    out.manufacturerId = pstr();
    return out;
};

export interface BuildInfo {
    date: string;
    time: string;
    revision: string;
}

/** "Oct 19 2026" + "19:59:53" + 7-char revision ("as-90d1" for this project's builds). */
export const parseBuildInfo = (p: Uint8Array): BuildInfo => ({
    date: ascii(p, 0, 11),
    time: ascii(p, 11, 8),
    revision: ascii(p, 19, 7)
});

export const parseMotors = (p: Uint8Array): number[] => {
    const v = view(p);
    const out: number[] = [];
    for (let i = 0; i + 1 < p.length && out.length < 8; i += 2) out.push(v.getUint16(i, true));
    return out;
};

export const encodeSetMotor = (values: number[]): Uint8Array => {
    const out = new Uint8Array(16);
    const v = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) v.setUint16(i * 2, Math.max(0, Math.min(2000, Math.round(values[i] ?? 1000))), true);
    return out;
};

export interface BatteryState {
    cells: number;
    capacityMah: number;
    volts: number;
    mahDrawn: number;
    amps: number;
    alert: number;
}

export const parseBattery = (p: Uint8Array): BatteryState | null => {
    if (p.length < 9) return null;
    const v = view(p);
    return {
        cells: p[0],
        capacityMah: v.getUint16(1, true),
        // the precise 0.01 V value (API 1.41+); legacy 0.1 V byte as a fallback
        volts: p.length >= 11 ? v.getUint16(9, true) / 100 : p[3] / 10,
        mahDrawn: v.getUint16(4, true),
        amps: v.getInt16(6, true) / 100,
        alert: p[8]
    };
};

export interface EscTelemetry {
    rpm: number;
    invalidPct: number;
    tempC: number;
    volts: number;
    amps: number;
    mah: number;
}

export const parseMotorTelemetry = (p: Uint8Array): EscTelemetry[] => {
    if (p.length < 1) return [];
    const v = view(p);
    const out: EscTelemetry[] = [];
    for (let i = 0; i < p[0]; i++) {
        const o = 1 + 13 * i;
        if (o + 13 > p.length) break;
        out.push({
            rpm: v.getUint32(o, true),
            invalidPct: v.getUint16(o + 4, true) / 100,
            tempC: p[o + 6],
            volts: v.getUint16(o + 7, true) / 100,
            amps: v.getUint16(o + 9, true) / 100,
            mah: v.getUint16(o + 11, true)
        });
    }
    return out;
};

export const parseDebug = (p: Uint8Array): number[] => {
    const v = view(p);
    const out: number[] = [];
    for (let i = 0; i + 1 < p.length && out.length < 8; i += 2) out.push(v.getInt16(i, true));
    return out;
};
