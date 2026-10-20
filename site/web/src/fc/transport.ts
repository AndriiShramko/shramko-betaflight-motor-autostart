// Byte transport to the flight controller: Web Serial in the browser (or Google's WebUSB
// polyfill on Android), the `serialport` package in Node (tools/fc-node), or the in-memory
// emulator (mockfc.ts). Everything above this file only sees the Transport interface.

export type FcErrorCode =
    | 'no-api' // this browser has neither Web Serial nor WebUSB
    | 'insecure' // page not served over https (Web Serial needs a secure context)
    | 'cancelled' // the visitor closed the port picker
    | 'permission' // the browser or OS refused access
    | 'busy' // the port is open in another program (Betaflight Configurator, a terminal)
    | 'not-usb' // the picked port is not a USB one (a Bluetooth headset or phone link), so not the board
    | 'not-open'
    | 'lost' // the board disappeared (unplugged, rebooting)
    | 'timeout' // no answer in time
    | 'reconnect-timeout' // the board did not come back after a restart
    | 'no-answer' // something answers, but not like a Betaflight board
    | 'msp-error'
    | 'cli' // the CLI did not open or did not answer
    | 'cli-invalid-value'
    | 'cli-invalid-name'
    | 'verify' // values read back after saving differ from what was written
    | 'not-ours' // Betaflight without the autostart module
    | 'busy-op' // another operation is still running
    | 'internal';

export class FcError extends Error {
    constructor(public readonly code: FcErrorCode, message: string, public readonly detail: Record<string, unknown> = {}) {
        super(message);
        this.name = 'FcError';
    }
}

export const isFcError = (e: unknown, code?: FcErrorCode): e is FcError =>
    e instanceof FcError && (code === undefined || e.code === code);

export type CloseReason = 'lost' | 'closed';

export interface Transport {
    readonly isOpen: boolean;
    /** Pick (first time) and open the port. In a browser call it from a click handler.
     *  anyPort: list every port, not only the USB chips flight controllers use. */
    open(opts?: { anyPort?: boolean }): Promise<void>;
    close(): Promise<void>;
    write(bytes: Uint8Array): Promise<void>;
    /** Subscribe to incoming bytes; returns an unsubscribe function. */
    onData(cb: (bytes: Uint8Array) => void): () => void;
    /** 'lost' = the device went away (reboot, unplug); 'closed' = we closed it. */
    onClose(cb: (reason: CloseReason) => void): () => void;
    /** After a reboot/unplug: wait until the same board is back and open it again, without a new picker. */
    reconnect(timeoutMs: number, signal?: AbortSignal): Promise<void>;
    /** Short text for logs and reports ("USB 0483:5740"). */
    describe(): string;
}

/** A tiny event helper shared by the transports. */
export class Emitter<T> {
    private subs = new Set<(v: T) => void>();
    on(cb: (v: T) => void) {
        this.subs.add(cb);
        return () => {
            this.subs.delete(cb);
        };
    }
    emit(v: T) {
        for (const cb of Array.from(this.subs)) {
            try {
                cb(v);
            } catch (e) {
                console.error(e);
            }
        }
    }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new FcError('cancelled', 'aborted'));
        const t = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(t);
            reject(new FcError('cancelled', 'aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });

// ---------- Web Serial ----------

/** The parts of the Web Serial API we use (navigator.serial, the polyfill and the mock all fit). */
export interface SerialPortLike {
    open(options: { baudRate: number }): Promise<void>;
    close(): Promise<void>;
    readonly readable: ReadableStream<Uint8Array> | null;
    readonly writable: WritableStream<Uint8Array> | null;
    getInfo?(): { usbVendorId?: number; usbProductId?: number };
    /** Chrome 124+: false once the device is gone */
    readonly connected?: boolean;
}

export interface SerialLike {
    requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPortLike>;
    getPorts(): Promise<SerialPortLike[]>;
    addEventListener?(type: 'connect' | 'disconnect', cb: (e: Event) => void): void;
    removeEventListener?(type: 'connect' | 'disconnect', cb: (e: Event) => void): void;
}

const errName = (e: unknown) => (e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Turn a browser exception from requestPort()/open() into an FcError with a plain-word code. */
export const mapSerialError = (e: unknown, stage: 'request' | 'open'): FcError => {
    if (e instanceof FcError) return e;
    const n = errName(e);
    const m = errMsg(e);
    if (stage === 'request' && (n === 'NotFoundError' || n === 'AbortError')) return new FcError('cancelled', m);
    if (n === 'SecurityError' || n === 'NotAllowedError') return new FcError('permission', m);
    if (stage === 'open' && (n === 'NetworkError' || n === 'InvalidStateError' || /access denied|busy|in use|failed to open/i.test(m)))
        return new FcError('busy', m);
    return new FcError('internal', `${n || 'Error'}: ${m}`);
};

/** USB vendors of flight-controller ports: the picker lists only these, so a Bluetooth headset or a
 *  phone link is not offered as "the board". STM32 (0483) and Artery AT32 (2e3c) native USB, plus the
 *  usual USB-serial chips on boards and adapters: Silicon Labs CP210x (10c4), FTDI (0403), CH340 (1a86).
 *  Anything else is one click away ("show all ports"). */
export const BOARD_USB_FILTERS = [0x0483, 0x2e3c, 0x10c4, 0x0403, 0x1a86].map(usbVendorId => ({ usbVendorId }));

export interface WebSerialOptions {
    baudRate?: number;
    /** poll interval while waiting for the board to come back */
    pollMs?: number;
}

export class WebSerialTransport implements Transport {
    private port: SerialPortLike | null = null;
    private info: { usbVendorId?: number; usbProductId?: number } = {};
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private pumping: Promise<void> | null = null;
    private closing = false;
    private open_ = false;
    private writeChain: Promise<void> = Promise.resolve();
    private readonly data = new Emitter<Uint8Array>();
    private readonly closed = new Emitter<CloseReason>();
    private readonly baudRate: number;
    private readonly pollMs: number;

    constructor(private readonly serial: SerialLike, opts: WebSerialOptions = {}) {
        this.baudRate = opts.baudRate ?? 115200;
        this.pollMs = opts.pollMs ?? 250;
        serial.addEventListener?.('disconnect', e => {
            const t = (e as Event & { port?: SerialPortLike }).port ?? e.target;
            if (this.open_ && t === this.port) void this.lost();
        });
    }

    get isOpen() {
        return this.open_;
    }

    describe() {
        const h = (n?: number) => (n === undefined ? '????' : n.toString(16).padStart(4, '0'));
        return `USB ${h(this.info.usbVendorId)}:${h(this.info.usbProductId)}`;
    }

    onData(cb: (b: Uint8Array) => void) {
        return this.data.on(cb);
    }

    onClose(cb: (r: CloseReason) => void) {
        return this.closed.on(cb);
    }

    async open(opts: { anyPort?: boolean } = {}) {
        if (this.open_) return;
        let port: SerialPortLike;
        try {
            port = await this.serial.requestPort(opts.anyPort ? {} : { filters: BOARD_USB_FILTERS });
        } catch (e) {
            throw mapSerialError(e, 'request');
        }
        try {
            await this.openPort(port);
        } catch (e) {
            // a Bluetooth port that will not open is a wrong pick, not a board held by another program
            const info = port.getInfo?.();
            if (isFcError(e, 'busy') && info && info.usbVendorId === undefined) throw new FcError('not-usb', e.message);
            throw e;
        }
    }

    private async openPort(port: SerialPortLike) {
        try {
            await port.open({ baudRate: this.baudRate });
        } catch (e) {
            throw mapSerialError(e, 'open');
        }
        this.port = port;
        this.info = port.getInfo?.() ?? {};
        this.open_ = true;
        this.closing = false;
        this.pumping = this.pump(port);
    }

    private async pump(port: SerialPortLike) {
        while (port.readable && !this.closing) {
            const reader = port.readable.getReader();
            this.reader = reader;
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value && value.length) this.data.emit(value);
                }
            } catch (e) {
                // non-fatal errors (framing, break) recreate port.readable; a lost device leaves it null
                if (errName(e) === 'NetworkError' || !port.readable) break;
            } finally {
                try {
                    reader.releaseLock();
                } catch { /* already released */ }
                this.reader = null;
            }
        }
        if (!this.closing && this.port === port) await this.lost();
    }

    private async lost() {
        if (!this.open_) return;
        this.open_ = false;
        const port = this.port;
        try {
            await this.reader?.cancel();
        } catch { /* gone */ }
        try {
            await port?.close();
        } catch { /* gone */ }
        this.closed.emit('lost');
    }

    async write(bytes: Uint8Array) {
        const run = async () => {
            const port = this.port;
            if (!this.open_ || !port?.writable) throw new FcError('not-open', 'port is not open');
            const w = port.writable.getWriter();
            try {
                await w.write(bytes);
            } catch (e) {
                throw new FcError('lost', errMsg(e));
            } finally {
                try {
                    w.releaseLock();
                } catch { /* ignore */ }
            }
        };
        const p = this.writeChain.then(run, run);
        this.writeChain = p.catch(() => undefined);
        return p;
    }

    async close() {
        this.closing = true;
        const wasOpen = this.open_;
        this.open_ = false;
        try {
            await this.reader?.cancel();
        } catch { /* ignore */ }
        try {
            await this.pumping;
        } catch { /* ignore */ }
        try {
            await this.writeChain;
            await this.port?.close();
        } catch { /* ignore */ }
        if (wasOpen) this.closed.emit('closed');
    }

    /** Find the same board again (same USB ids) among the already-granted ports and open it. */
    async reconnect(timeoutMs: number, signal?: AbortSignal) {
        if (this.open_) return;
        const deadline = Date.now() + timeoutMs;
        const old = this.port;
        let wake: (() => void) | null = null;
        const onConnect = () => wake?.();
        this.serial.addEventListener?.('connect', onConnect);
        try {
            for (;;) {
                if (signal?.aborted) throw new FcError('cancelled', 'aborted');
                let ports: SerialPortLike[] = [];
                try {
                    ports = await this.serial.getPorts();
                } catch { /* ignore, retry */ }
                const same = (p: SerialPortLike) => {
                    const i = p.getInfo?.() ?? {};
                    return i.usbVendorId === this.info.usbVendorId && i.usbProductId === this.info.usbProductId;
                };
                // a re-enumerated device is a new SerialPort object; the old one stays "disconnected"
                const candidates = ports.filter(p => same(p) && p.connected !== false).sort((a, b) => (a === old ? 1 : 0) - (b === old ? 1 : 0));
                for (const p of candidates) {
                    try {
                        await this.openPort(p);
                        return;
                    } catch { /* not ready yet */ }
                }
                const left = deadline - Date.now();
                if (left <= 0) throw new FcError('reconnect-timeout', `the board did not come back in ${Math.round(timeoutMs / 1000)} s`);
                await new Promise<void>(resolve => {
                    const t = setTimeout(resolve, Math.min(this.pollMs, left));
                    wake = () => {
                        clearTimeout(t);
                        resolve();
                    };
                });
                wake = null;
            }
        } finally {
            this.serial.removeEventListener?.('connect', onConnect);
        }
    }
}

// ---------- browser support ----------

export type SerialSupport = 'web-serial' | 'webusb' | 'insecure' | 'none';

export const detectSerialSupport = (nav: Navigator = navigator, secure = globalThis.isSecureContext !== false): SerialSupport => {
    if (!secure) return 'insecure';
    if ('serial' in nav && (nav as unknown as { serial?: unknown }).serial) return 'web-serial';
    if ('usb' in nav && (nav as unknown as { usb?: unknown }).usb) return 'webusb';
    return 'none';
};

/** navigator.serial, or Google's WebUSB polyfill (Android Chrome), or an FcError('no-api'). */
export const browserSerial = async (): Promise<SerialLike> => {
    const s = detectSerialSupport();
    if (s === 'web-serial') return (navigator as unknown as { serial: SerialLike }).serial;
    if (s === 'webusb') {
        const mod = (await import('web-serial-polyfill')) as unknown as { serial: SerialLike };
        return mod.serial;
    }
    if (s === 'insecure') throw new FcError('insecure', 'Web Serial needs https');
    throw new FcError('no-api', 'no Web Serial / WebUSB in this browser');
};
