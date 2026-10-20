// Transport over a real serial port in Node (the `serialport` package), for the bench harness.
// The same AutostartDevice code that runs in the browser runs on top of it.

import { SerialPortStream } from '@serialport/stream';
import { SerialPort } from 'serialport';
import { Emitter, FcError, sleep, type CloseReason, type Transport } from '../../web/src/fc/transport.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBinding = any;

export interface NodeSerialOptions {
    baudRate?: number;
    /** serialport binding; defaults to the OS binding (tests pass an emulator binding) */
    binding?: AnyBinding;
    pollMs?: number;
}

const mapOpenError = (e: unknown): FcError => {
    const m = e instanceof Error ? e.message : String(e);
    if (/access denied|busy|resource busy|EBUSY|EACCES|locked/i.test(m)) return new FcError('busy', m);
    if (/not found|ENOENT|cannot find|no such file|does not exist/i.test(m)) return new FcError('not-open', m);
    return new FcError('internal', m);
};

export class NodeSerialTransport implements Transport {
    private port: SerialPortStream | null = null;
    private open_ = false;
    private closing = false;
    private readonly data = new Emitter<Uint8Array>();
    private readonly closed = new Emitter<CloseReason>();
    private readonly baudRate: number;
    private readonly binding: AnyBinding;
    private readonly pollMs: number;

    constructor(readonly path: string, opts: NodeSerialOptions = {}) {
        this.baudRate = opts.baudRate ?? 115200;
        this.binding = opts.binding ?? SerialPort.binding;
        this.pollMs = opts.pollMs ?? 300;
    }

    get isOpen() {
        return this.open_;
    }

    describe() {
        return `serial ${this.path}`;
    }

    onData(cb: (b: Uint8Array) => void) {
        return this.data.on(cb);
    }

    onClose(cb: (r: CloseReason) => void) {
        return this.closed.on(cb);
    }

    async open() {
        if (this.open_) return;
        const port = new SerialPortStream({ binding: this.binding, path: this.path, baudRate: this.baudRate, autoOpen: false });
        await new Promise<void>((resolve, reject) => port.open(err => (err ? reject(mapOpenError(err)) : resolve())));
        this.port = port;
        this.open_ = true;
        this.closing = false;
        port.on('data', (b: Buffer) => this.data.emit(new Uint8Array(b.buffer, b.byteOffset, b.length)));
        port.on('error', () => undefined); // a lost device also arrives as 'close'
        port.on('close', () => {
            if (this.port !== port) return;
            const was = this.open_;
            this.open_ = false;
            this.port = null;
            if (was) this.closed.emit(this.closing ? 'closed' : 'lost');
        });
    }

    async write(bytes: Uint8Array) {
        const port = this.port;
        if (!this.open_ || !port) throw new FcError('not-open', 'port is not open');
        await new Promise<void>((resolve, reject) => {
            port.write(Buffer.from(bytes), err => (err ? reject(new FcError('lost', err.message)) : resolve()));
        });
    }

    async close() {
        const port = this.port;
        if (!port || !this.open_) return;
        this.closing = true;
        await new Promise<void>(resolve => port.close(() => resolve()));
    }

    /** After a reboot Windows gives the board the same COM name: keep trying to open it. */
    async reconnect(timeoutMs: number, signal?: AbortSignal) {
        if (this.open_) return;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (signal?.aborted) throw new FcError('cancelled', 'aborted');
            try {
                await this.open();
                return;
            } catch { /* not back yet */ }
            const left = deadline - Date.now();
            if (left <= 0) throw new FcError('reconnect-timeout', `${this.path} did not come back in ${Math.round(timeoutMs / 1000)} s`);
            await sleep(Math.min(this.pollMs, left), signal);
        }
    }
}
