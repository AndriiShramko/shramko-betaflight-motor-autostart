// A serialport "binding" backed by the emulated board, so the Node harness can be tested
// end to end (open, read, write, reboot = port gone + back) without touching hardware.

import { MockFc } from '../../web/src/fc/mockfc.ts';

class Canceled extends Error {
    canceled = true as const;
}

class MockFcPort {
    isOpen = true;
    private queue: Buffer[] = [];
    private waiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
    private offs: (() => void)[] = [];
    private gone = false;

    constructor(private readonly mock: MockFc, readonly openOptions: { path: string; baudRate: number }) {
        this.offs.push(
            mock.onOutput(b => {
                this.queue.push(Buffer.from(b));
                this.waiter?.resolve();
            }) as () => void,
            mock.onPresence(p => {
                if (p) return;
                this.gone = true;
                this.waiter?.reject(new Error('device disconnected'));
            }) as () => void
        );
    }

    async read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }> {
        while (!this.queue.length) {
            if (!this.isOpen) throw new Canceled('closed');
            if (this.gone) throw new Error('device disconnected');
            await new Promise<void>((resolve, reject) => (this.waiter = { resolve, reject }));
            this.waiter = null;
        }
        const head = this.queue[0];
        const n = Math.min(length, head.length);
        head.copy(buffer, offset, 0, n);
        if (n < head.length) this.queue[0] = head.subarray(n);
        else this.queue.shift();
        return { buffer, bytesRead: n };
    }

    async write(buffer: Buffer) {
        if (this.gone) throw new Error('device disconnected');
        const copy = Uint8Array.from(buffer);
        setTimeout(() => this.mock.input(copy), 1);
    }

    async close() {
        this.isOpen = false;
        this.offs.forEach(f => f());
        this.waiter?.reject(new Canceled('closed'));
    }

    async update() {}
    async set() {}
    async get() {
        return { cts: false, dsr: false, dcd: false };
    }
    async getBaudRate() {
        return { baudRate: this.openOptions.baudRate };
    }
    async flush() {
        this.queue = [];
    }
    async drain() {}
}

export const mockFcBinding = (mock: MockFc, path = 'MOCK') => ({
    async list() {
        return mock.present ? [{ path, manufacturer: 'Emulated HGLRC', vendorId: '0483', productId: '5740' }] : [];
    },
    async open(options: { path: string; baudRate: number }) {
        if (options.path !== path || !mock.present) throw new Error(`Opening ${options.path}: File not found`);
        if (mock.opts.busy) throw new Error(`Opening ${options.path}: Access denied`);
        return new MockFcPort(mock, options);
    }
});
