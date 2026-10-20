// Betaflight CLI over the same port. Facts (Betaflight 2025.12.1, measured on the board):
// - enter: a single "#" (no newline) while MSP is idle; the board prints a banner and "\r\n# ".
// - if the CLI was already open, that "#" lands in the line buffer, so we always send "\r\n" once
//   before the first command (an empty line prints nothing, "#..." is a comment and prints a prompt).
// - the CLI echoes typed characters; a command's output ends with the prompt "\r\n# ".
// - "save" writes and reboots, "exit" reboots, "exit noreboot" leaves without a reboot.
// - while the CLI is open MSP does not answer, and the autostart program is stopped.
// - never send a capital "R" while MSP is idle: it is Betaflight's "reboot to bootloader" character.

import { FcError, sleep, type Transport } from './transport';

export interface CliVar {
    name: string;
    /** the value exactly as printed (enum names in capitals, numbers as digits) */
    value: string;
    allowed?: string[];
    min?: number;
    max?: number;
    /** printed only when the current value differs from the firmware default */
    default?: string;
    arrayLength?: number;
}

const PROMPT = '\r\n# ';

/** Parse the output of `get <pattern>` into variables (order kept). */
export const parseGetOutput = (text: string): Map<string, CliVar> => {
    const out = new Map<string, CliVar>();
    let cur: CliVar | null = null;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        let m = /^([a-z][a-z0-9_]*) = (.*)$/i.exec(line);
        if (m) {
            cur = { name: m[1], value: m[2].trim() };
            out.set(cur.name, cur);
            continue;
        }
        if (!cur) continue;
        if ((m = /^Allowed values: (.*)$/i.exec(line))) cur.allowed = m[1].split(',').map(s => s.trim()).filter(Boolean);
        else if ((m = /^Allowed range: (-?\d+) - (-?\d+)/i.exec(line))) {
            cur.min = parseInt(m[1], 10);
            cur.max = parseInt(m[2], 10);
        } else if ((m = /^Default value: (.*)$/i.exec(line))) cur.default = m[1].trim();
        else if ((m = /^Array length: (\d+)/i.exec(line))) cur.arrayLength = parseInt(m[1], 10);
    }
    return out;
};

export type SetOutcome =
    | { ok: true; name: string; value: string }
    | { ok: false; error: 'invalid-value' | 'invalid-name' | 'other'; text: string };

/** Parse the answer to `set name = value`. */
export const parseSetOutput = (text: string, name: string): SetOutcome => {
    const t = text.trim();
    if (/invalid name/i.test(t)) return { ok: false, error: 'invalid-name', text: t };
    if (/invalid value/i.test(t)) return { ok: false, error: 'invalid-value', text: t };
    const m = new RegExp(`^${name} set to (.*)$`, 'im').exec(t);
    if (m) return { ok: true, name, value: m[1].trim() };
    return { ok: false, error: 'other', text: t };
};

export interface CliOptions {
    log?: (line: string) => void;
    /** how long to wait for the banner after "#" (the lead measured ~1 s) */
    enterWaitMs?: number;
    /** quiet time that ends a command's output once the prompt is seen */
    quietMs?: number;
}

export class Cli {
    private buf = '';
    private gotData: (() => void) | null = null;
    private readonly unsubscribe: () => void;
    private readonly decoder = new TextDecoder();
    active = false;

    constructor(private readonly transport: Transport, private readonly opts: CliOptions = {}) {
        this.unsubscribe = transport.onData(b => {
            this.buf += this.decoder.decode(b, { stream: true });
            if (this.buf.length > 256 * 1024) this.buf = this.buf.slice(-128 * 1024);
            this.gotData?.();
        });
    }

    dispose() {
        this.unsubscribe();
    }

    private log(s: string) {
        this.opts.log?.(s);
    }

    private send(s: string) {
        return this.transport.write(new TextEncoder().encode(s));
    }

    /** Wait until `done(buf)` holds and nothing new arrived for `quietMs`, or until `timeoutMs`. */
    private async collect(done: (b: string) => boolean, timeoutMs: number, quietMs = this.opts.quietMs ?? 60): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        let last = Date.now();
        let seen = this.buf.length;
        for (;;) {
            if (this.buf.length !== seen) {
                seen = this.buf.length;
                last = Date.now();
            }
            if (done(this.buf) && Date.now() - last >= quietMs) return true;
            const left = deadline - Date.now();
            if (left <= 0) return done(this.buf);
            if (!this.transport.isOpen) return done(this.buf);
            await new Promise<void>(resolve => {
                const t = setTimeout(resolve, Math.min(quietMs, left, 25));
                this.gotData = () => {
                    clearTimeout(t);
                    resolve();
                };
            });
            this.gotData = null;
        }
    }

    /** Open the CLI (stops the autostart program until the board restarts). */
    async enter(): Promise<string> {
        if (this.active) return '';
        const wait = this.opts.enterWaitMs ?? 1200;
        for (let attempt = 0; attempt < 3; attempt++) {
            this.buf = '';
            await this.send('#');
            await this.collect(b => b.includes('Entering CLI') && b.endsWith(PROMPT), wait, 80);
            const banner = this.buf;
            // always one newline: flushes a "#" that landed in an already-open CLI's buffer
            this.buf = '';
            await this.send('\r\n');
            await this.collect(b => b.endsWith(PROMPT), banner.includes('Entering CLI') ? 150 : wait, 80);
            if (banner.includes('Entering CLI') || banner.endsWith('# ') || banner.endsWith('#') || this.buf.endsWith(PROMPT)) {
                this.active = true;
                this.buf = '';
                this.log('CLI open');
                return banner;
            }
            if (!this.transport.isOpen) throw new FcError('lost', 'the board disconnected while the CLI was being opened');
            await sleep(200);
        }
        if (!this.transport.isOpen) throw new FcError('lost', 'the board disconnected while the CLI was being opened');
        throw new FcError('cli', 'the CLI did not open (no prompt after "#")');
    }

    /** Run one command and return its output without the echo and the prompt. */
    async exec(cmd: string, timeoutMs = 4000): Promise<string> {
        if (!this.active) throw new FcError('cli', 'CLI is not open');
        if (/[\r\n]/.test(cmd)) throw new FcError('internal', 'one command per call');
        this.buf = '';
        await this.send(cmd + '\r\n');
        const ok = await this.collect(b => b.endsWith(PROMPT), timeoutMs);
        const raw = this.buf;
        this.buf = '';
        // the port went away (unplugged, reset): that is a lost board, not a command line that did not answer
        if (!ok && !this.transport.isOpen) throw new FcError('lost', `the board disconnected during "${cmd}"`);
        if (!ok) throw new FcError('cli', `no prompt after "${cmd}"`, { output: raw.slice(-400) });
        let body = raw.slice(0, raw.length - PROMPT.length);
        // strip the echoed command line
        const echo = body.indexOf(cmd);
        if (echo >= 0 && echo < 4) body = body.slice(echo + cmd.length);
        return body.replace(/^\r?\n/, '');
    }

    async get(pattern: string): Promise<Map<string, CliVar>> {
        return parseGetOutput(await this.exec(`get ${pattern}`));
    }

    async set(name: string, value: string | number): Promise<SetOutcome> {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new FcError('internal', `bad setting name ${name}`);
        const v = String(value);
        if (!/^[A-Za-z0-9_.-]+$/.test(v)) throw new FcError('internal', `bad value for ${name}`);
        return parseSetOutput(await this.exec(`set ${name} = ${v}`), name);
    }

    /**
     * Write to flash; the board reboots and the USB port disappears. Returns whether the board said it saves
     * ("saving" / "Rebooting"): false when the port dropped before any answer, i.e. the save may never have run.
     */
    async save(): Promise<boolean> {
        if (!this.active) throw new FcError('cli', 'CLI is not open');
        this.buf = '';
        await this.send('save\r\n');
        // judged inside the callback: the port drops right after "Rebooting" and that clears the buffer
        let answered = false;
        await this.collect(b => {
            if (/saving|Rebooting/i.test(b)) answered = true;
            return /Rebooting/i.test(b);
        }, 3000, 0);
        this.active = false;
        this.log(answered ? 'saved, board rebooting' : 'save sent, no answer before the port dropped');
        return answered;
    }

    /** Leave the CLI without a reboot (the program stays stopped, MSP answers again). */
    async exitNoReboot(): Promise<void> {
        if (!this.active) return;
        this.buf = '';
        await this.send('exit noreboot\r\n');
        await this.collect(b => /leaving CLI mode/i.test(b), 1500, 30);
        this.active = false;
        this.buf = '';
        this.log('CLI closed (no reboot)');
    }

    /** Leave the CLI with a reboot (discards unsaved changes). */
    async exitReboot(): Promise<void> {
        if (!this.active) return;
        this.buf = '';
        await this.send('exit\r\n');
        await this.collect(b => /Rebooting/i.test(b), 2000, 0);
        this.active = false;
    }

    /** The board went away (reboot/unplug): forget the session. */
    reset() {
        this.active = false;
        this.buf = '';
    }

    /**
     * A previous session may have left the CLI open; then MSP is silent. That session may also have left `set`
     * values in RAM that were never saved (a write cut short): "exit noreboot" would keep them, `get` would show
     * them as the board's program and the next `save` would write them. So leave with a plain "exit": the board
     * reboots and forgets them. Returns true when the board said it reboots (the caller waits for it).
     * Safe in MSP mode too: lower-case text with no "#" and no "R" is ignored by Betaflight there.
     */
    async leaveIfStuck(): Promise<boolean> {
        this.buf = '';
        await this.send('\r\n');
        await sleep(80);
        await this.send('exit\r\n');
        // judged inside the callback: the port drops right after "Rebooting" and that clears the buffer
        let rebooting = false;
        await this.collect(b => {
            if (/Rebooting/i.test(b)) rebooting = true;
            return /Rebooting|leaving CLI mode/i.test(b);
        }, 600, 30);
        this.active = false;
        this.buf = '';
        return rebooting;
    }
}
