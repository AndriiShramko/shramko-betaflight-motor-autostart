// The board as the tool sees it: connect → identify (MSP) → read settings (CLI) → write only the
// changes → save (reboot) → reconnect → read back and verify every value; live view over MSP at 5 Hz;
// STOP (MSP_SET_MOTOR 1000s makes the program yield) and restart (MSP_REBOOT).

import { Cli, type CliVar } from './cli';
import {
    MSP,
    MspClient,
    encodeSetMotor,
    parseApiVersion,
    parseBattery,
    parseBoardInfo,
    parseBuildInfo,
    parseDebug,
    parseFcVariant,
    parseFcVersion,
    parseMotorTelemetry,
    parseMotors,
    type BatteryState,
    type BoardInfo,
    type BuildInfo,
    type EscTelemetry
} from './msp';
import { DEF, EXTRA_READS, SCHEMA, effective, fromCli, normalize, toCli, type Effective, type Value } from './settings';
import { Emitter, FcError, isFcError, sleep, type Transport } from './transport';

export type Verdict = 'autostart' | 'betaflight-other' | 'not-betaflight';

export interface Identity {
    variant: string;
    fcVersion: string;
    apiVersion: string;
    board: BoardInfo;
    build: BuildInfo;
    verdict: Verdict;
}

export interface BoardSettings {
    /** typed values of every schema setting present on the board */
    values: Record<string, Value>;
    eff: Record<string, Effective>;
    raw: Map<string, CliVar>;
    /** schema settings this firmware does not have (older release) */
    missing: string[];
    /** 1.1 when the gust/battery settings exist, 1.0 otherwise; null = no autostart module */
    level: '1.0' | '1.1' | null;
    debugMode: string | null;
    dshotBidir: string | null;
    /** feature ESC_SENSOR (the ESC's TX wire on the cable's yellow); null when `feature` could not be read */
    escSensor: boolean | null;
}

/** The result of checking a save once the board is back by itself (after a timeout or a lost port). */
export interface LateVerify {
    ok: boolean;
    verified: string[];
    mismatches: { name: string; expected: string; got: string | null }[];
    settings: BoardSettings;
}

export type Phase = 'idle' | 'connecting' | 'ready' | 'reading' | 'writing' | 'rebooting' | 'reconnecting' | 'closed';

export interface LiveSample {
    at: number;
    /** debug[] decoded; null when debug_mode is not AUTOSTART */
    state: number | null;
    pct: number | null;
    msInState: number | null;
    uptimeS: number | null;
    /** debug[4]; `implausible` = battery voltage outside 2.50–4.45 V/cell for the cell count (calibrate vbat_scale) */
    flags: { usb: boolean; rx: boolean; button: boolean; battery: boolean; gust: boolean; implausible: boolean; held: boolean } | null;
    sinceBatteryS: number | null;
    source: number | null;
    motors: number[];
    battery: BatteryState | null;
    esc: EscTelemetry[];
    /** output with the best ESC telemetry (fewest bad frames), or -1 */
    bestOutput: number;
    /** consecutive polls without an answer */
    misses: number;
}

export interface WriteStep {
    step: 'write' | 'save' | 'reboot' | 'reconnect' | 'verify' | 'done';
    done?: number;
    total?: number;
}

export interface DeviceOptions {
    reconnectTimeoutMs?: number;
    /** how long to wait for the port to drop after save/reboot */
    dropTimeoutMs?: number;
    pollHz?: number;
    log?: (line: string) => void;
}

/** debug[4] flags (docs/settings.md) */
// held (bit 6, firmware 1.1+): a CLI session, STOP or the Motors tab happened; nothing starts until a reboot
const decodeFlags = (f: number) => ({ usb: !!(f & 1), rx: !!(f & 2), button: !!(f & 4), battery: !!(f & 8), gust: !!(f & 16), implausible: !!(f & 32), held: !!(f & 64) });

/**
 * The output whose ESC really answers (bidirectional DShot: fewest bad frames; ESC sensor wire: any data).
 * Outputs with nothing on them report 100 % bad frames (DShot) or all zeros (ESC sensor).
 */
export const pickBestOutput = (esc: EscTelemetry[], mask = 0xff): number => {
    const dshot = esc.some(e => e.invalidPct > 0);
    const answers = (e: EscTelemetry) => e.rpm > 0 || e.volts > 0 || e.tempC > 0 || (dshot && e.invalidPct < 100);
    let best = -1;
    for (let i = 0; i < esc.length; i++) {
        if (!((mask >> i) & 1)) continue;
        const e = esc[i];
        if (!answers(e)) continue;
        if (best < 0 || e.invalidPct < esc[best].invalidPct || (e.invalidPct === esc[best].invalidPct && e.rpm > esc[best].rpm)) best = i;
    }
    return best;
};

export class AutostartDevice {
    readonly msp: MspClient;
    readonly cli: Cli;
    identity: Identity | null = null;
    settings: BoardSettings | null = null;
    phase: Phase = 'idle';
    readonly phaseEvents = new Emitter<Phase>();
    readonly liveEvents = new Emitter<LiveSample>();
    readonly logEvents = new Emitter<string>();
    /** a save that could not be checked (the board came back late or the port was lost) was checked once it was back */
    readonly lateVerifyEvents = new Emitter<LateVerify>();
    /** STOPs that were queued and are now sent (the board is back) */
    readonly stopFlushEvents = new Emitter<void>();
    /** a queued STOP that could not be sent once the board was back (no answer) */
    readonly stopFailEvents = new Emitter<unknown>();
    /** the page stopped waiting for a board that did not come back (10 min) */
    gaveUp = false;
    private readonly opts: Required<Omit<DeviceOptions, 'log'>> & { log?: (l: string) => void };
    private live = false;
    private liveLoop: Promise<void> | null = null;
    private wakeLoop: (() => void) | null = null;
    private misses = 0;
    private busy = false;
    /** the operation running now (disconnect waits for it to end cleanly) */
    private op: Promise<unknown> | null = null;
    /** Disconnect was pressed: operations stop at their next step */
    private closing = false;
    /** set while we expect the port to drop (save, restart) */
    private expectDrop = false;
    private dropped: (() => void) | null = null;
    private stopAfterReconnect = false;
    private recovering: Promise<void> | null = null;
    /** values a save wrote but could not check yet: checked when the board is back */
    private unverified: Record<string, string> | null = null;
    private abort = new AbortController();
    private offClose: () => void;

    constructor(readonly transport: Transport, opts: DeviceOptions = {}) {
        this.opts = {
            reconnectTimeoutMs: opts.reconnectTimeoutMs ?? 20000,
            dropTimeoutMs: opts.dropTimeoutMs ?? 6000,
            pollHz: opts.pollHz ?? 5,
            log: opts.log
        };
        this.msp = new MspClient(transport);
        this.cli = new Cli(transport, { log: l => this.log(l) });
        this.offClose = transport.onClose(r => this.onClosed(r));
    }

    private log(line: string) {
        this.opts.log?.(line);
        this.logEvents.emit(line);
    }

    private setPhase(p: Phase) {
        if (this.phase === p) return;
        this.phase = p;
        this.log(`phase: ${p}`);
        this.phaseEvents.emit(p);
    }

    private onClosed(reason: 'lost' | 'closed') {
        this.cli.reset();
        this.msp.failAll(new FcError('lost', 'the board disconnected'));
        if (reason === 'closed') return;
        this.dropped?.();
        // while connecting the caller gets the error and gives up this device: nothing waits for the board then
        if (this.expectDrop || this.closing || this.phase === 'closed' || this.phase === 'idle' || this.phase === 'connecting') return;
        // unplugged (or reset) while we were not expecting it: wait for it to come back
        this.log('board disconnected unexpectedly, waiting for it');
        this.setPhase('reconnecting');
        this.recovering = this.recover().finally(() => {
            this.recovering = null;
        });
    }

    private async recover() {
        try {
            await this.transport.reconnect(10 * 60_000, this.abort.signal);
            await this.afterReconnect();
            if (this.unverified && !this.closing) await this.verifyLate().catch(e => this.log(`late check of the save failed: ${String(e)}`));
            if (this.closing) return;
            this.setPhase('ready');
            this.startLive();
        } catch (e) {
            if (!isFcError(e, 'cancelled')) this.log(`reconnect failed: ${String(e)}`);
            if (this.phase === 'reconnecting' || this.phase === 'reading') {
                this.gaveUp = !this.closing && !isFcError(e, 'cancelled');
                this.setPhase('closed');
            }
        }
    }

    /** the board is back after a save that could not be checked: read it back now and tell the page */
    private async verifyLate() {
        const expected = this.unverified!;
        this.unverified = null;
        this.setPhase('reading');
        await this.cli.enter();
        let after: BoardSettings;
        try {
            after = await this.readInCli();
        } finally {
            await this.cli.exitNoReboot();
        }
        this.settings = after;
        const mismatches = this.compare(expected, after);
        this.log(`late check of the save: ${mismatches.length ? `${mismatches.length} differ` : 'all kept'}`);
        this.lateVerifyEvents.emit({ ok: !mismatches.length, verified: Object.keys(expected), mismatches, settings: after });
    }

    private compare(expected: Record<string, string>, after: BoardSettings) {
        const mismatches: { name: string; expected: string; got: string | null }[] = [];
        for (const [name, want] of Object.entries(expected)) {
            const got = after.raw.get(name)?.value ?? null;
            if (got === null || got.toUpperCase() !== want.toUpperCase()) mismatches.push({ name, expected: want, got });
        }
        return mismatches;
    }

    /** exclusive operations (read/write/restart) never overlap */
    private async exclusive<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
        if (this.busy) throw new FcError('busy-op', 'another operation is still running');
        if (this.phase !== 'ready') throw new FcError('not-open', `board not ready (${this.phase})`);
        this.busy = true;
        // the phase first (synchronously): a STOP pressed while the last live poll finishes is then queued for
        // after the reboot or answered by the CLI, never sent as MSP into a CLI that is being opened
        this.setPhase(phase);
        const run = (async () => {
            await this.stopLive();
            try {
                return await fn();
            } catch (e) {
                // unplugged in the first moments of the operation: the next write finds the port closed ("not
                // open") before the loss is reported. It is a lost board: the page reconnects by itself
                if (isFcError(e, 'not-open') && !this.closing) throw new FcError('lost', `the board disconnected (${e.message})`);
                throw e;
            }
        })();
        this.op = run;
        try {
            return await run;
        } finally {
            this.busy = false;
            this.op = null;
            const ph = this.phase as Phase; // changed inside fn()
            if (this.closing) {
                // Disconnect: nothing restarts here
            } else if (this.transport.isOpen && ph !== 'closed') {
                this.setPhase('ready');
                this.startLive();
            } else if (!this.transport.isOpen && ph !== 'closed' && !this.recovering) {
                // e.g. the board did not come back in time: keep waiting for it in the background
                this.expectDrop = false;
                this.setPhase('reconnecting');
                this.recovering = this.recover().finally(() => {
                    this.recovering = null;
                });
            }
        }
    }

    // ---------- connect / identify ----------

    /** Open the port (picker in a browser) and identify the board. Starts the live view. */
    async connect(opts: { anyPort?: boolean } = {}): Promise<Identity> {
        this.setPhase('connecting');
        try {
            await this.transport.open(opts);
            this.log(`port open: ${this.transport.describe()}`);
            const id = await this.identifyWithRecovery();
            // a STOP pressed while the board was being identified: it answers MSP now (a CLI left open was left).
            // The board is connected either way; a STOP that does not get through is told by stopFailEvents
            await this.flushStop().catch(e => this.log(`STOP after connecting: ${String(e)}`));
            this.setPhase('ready');
            this.startLive();
            return id;
        } catch (e) {
            if (this.transport.isOpen) await this.transport.close().catch(() => undefined);
            this.setPhase('idle');
            throw e;
        }
    }

    private async identifyWithRecovery(): Promise<Identity> {
        try {
            return await this.identify();
        } catch (e) {
            if (!isFcError(e, 'timeout')) throw e;
            // MSP is silent: a previous session may have left the CLI open, maybe with unsaved `set` values in RAM.
            // Leaving it with a reboot forgets them; the STOP right after the reboot keeps the program held, as
            // the open CLI held it (the reboot alone would run it from the start).
            this.log('no MSP answer, trying to leave a CLI left open');
            const wasExpecting = this.expectDrop;
            this.expectDrop = true;
            try {
                if (await this.cli.leaveIfStuck()) {
                    this.log('CLI left open: left with a reboot (unsaved values in RAM are discarded)');
                    const t0 = Date.now();
                    while (this.transport.isOpen && Date.now() - t0 < this.opts.dropTimeoutMs) await sleep(25, this.abort.signal);
                    if (!this.transport.isOpen) await this.transport.reconnect(this.opts.reconnectTimeoutMs, this.abort.signal);
                    this.cli.reset();
                    await sleep(150, this.abort.signal);
                    this.stopAfterReconnect = true;
                    // MSP answers again only after the boot: the STOP is retried by sendStop
                    await this.flushStop().catch(err => this.log(`STOP after leaving the CLI: ${String(err)}`));
                }
            } finally {
                this.expectDrop = wasExpecting;
            }
            try {
                return await this.identify();
            } catch (e2) {
                if (isFcError(e2, 'timeout')) throw new FcError('no-answer', 'the device does not answer like a Betaflight flight controller');
                throw e2;
            }
        }
    }

    async identify(): Promise<Identity> {
        const variant = parseFcVariant(await this.msp.ask(MSP.FC_VARIANT, undefined, { retries: 3, timeoutMs: 500 }));
        const apiVersion = parseApiVersion(await this.msp.ask(MSP.API_VERSION));
        const fcVersion = parseFcVersion(await this.msp.ask(MSP.FC_VERSION));
        let board: BoardInfo = { identifier: '', hardwareRevision: 0, targetName: '', boardName: '', manufacturerId: '' };
        let build: BuildInfo = { date: '', time: '', revision: '' };
        try {
            board = parseBoardInfo(await this.msp.ask(MSP.BOARD_INFO));
        } catch (e) {
            if (!isFcError(e, 'msp-error')) throw e;
        }
        try {
            build = parseBuildInfo(await this.msp.ask(MSP.BUILD_INFO));
        } catch (e) {
            if (!isFcError(e, 'msp-error')) throw e;
        }
        const verdict: Verdict = variant !== 'BTFL' ? 'not-betaflight' : build.revision.startsWith('as-') ? 'autostart' : 'betaflight-other';
        this.identity = { variant, fcVersion, apiVersion, board, build, verdict };
        this.log(`identified: ${variant} ${fcVersion} ${board.boardName || board.identifier} build ${build.revision} → ${verdict}`);
        return this.identity;
    }

    // ---------- settings ----------

    private async readInCli(): Promise<BoardSettings> {
        const raw = await this.cli.get('autostart');
        for (const name of ['vbat_scale', ...EXTRA_READS]) {
            const m = await this.cli.get(name);
            const v = m.get(name);
            if (v) raw.set(name, v);
        }
        // the ESC's TX wire is used when feature ESC_SENSOR is on ("Enabled: … ESC_SENSOR …"); read-only
        let escSensor: boolean | null = null;
        try {
            const m = /Enabled:([^\r\n]*)/i.exec(await this.cli.exec('feature'));
            if (m) escSensor = m[1].trim().split(/\s+/).includes('ESC_SENSOR');
        } catch (e) {
            if (isFcError(e, 'lost')) throw e;
        }
        const values: Record<string, Value> = {};
        const eff: Record<string, Effective> = {};
        const missing: string[] = [];
        for (const d of SCHEMA) {
            const v = raw.get(d.name);
            eff[d.name] = effective(d, v);
            if (!v) {
                missing.push(d.name);
                continue;
            }
            const typed = fromCli(d, v.value);
            if (typed !== undefined) values[d.name] = typed;
        }
        const level = raw.has('autostart_mode') ? (raw.has('autostart_pattern') ? '1.1' : '1.0') : null;
        const s: BoardSettings = {
            values,
            eff,
            raw,
            missing,
            level,
            debugMode: raw.get('debug_mode')?.value ?? null,
            dshotBidir: raw.get('dshot_bidir')?.value ?? null,
            escSensor
        };
        this.log(`settings read: ${Object.keys(values).length} values, firmware level ${level ?? 'none'}`);
        return s;
    }

    /** Read every autostart setting via the CLI. Stops the motor program until the board restarts. */
    async readSettings(): Promise<BoardSettings> {
        return this.exclusive('reading', async () => {
            await this.cli.enter();
            try {
                this.settings = await this.readInCli();
            } finally {
                await this.cli.exitNoReboot();
            }
            if (this.identity && this.identity.verdict === 'betaflight-other' && this.settings.level) this.identity.verdict = 'autostart';
            return this.settings;
        });
    }

    /**
     * Write only the given changes (typed values), save (the board reboots), reconnect, read back and
     * verify every value. Values are validated first; nothing invalid is ever sent.
     */
    async writeSettings(changes: Record<string, Value>, progress: (s: WriteStep) => void = () => undefined): Promise<{ verified: string[]; settings: BoardSettings }> {
        const cur = this.settings;
        if (!cur) throw new FcError('internal', 'read the settings first');
        const names = Object.keys(changes);
        if (!names.length) throw new FcError('internal', 'nothing to save');
        for (const n of names) {
            if (n === 'debug_mode') continue;
            if (!DEF[n] || !cur.eff[n]?.present) throw new FcError('cli-invalid-name', `the board has no setting ${n}`, { name: n });
        }
        // validate against the board's ranges; pairs are swapped if needed
        const merged = { ...cur.values, ...changes };
        const { values: norm } = normalize(cur.eff, merged);
        const plan: [string, string][] = names.map(n => [n, n === 'debug_mode' ? String(changes[n]).toUpperCase() : toCli(DEF[n], norm[n])]);
        // a swap may also change the partner of a pair
        for (const d of SCHEMA) {
            if (!(d.name in cur.values) || names.includes(d.name)) continue;
            if (String(norm[d.name]) !== String(cur.values[d.name])) plan.push([d.name, toCli(d, norm[d.name])]);
        }
        const expected = Object.fromEntries(plan);

        return this.exclusive('writing', async () => {
            await this.cli.enter();
            const applied: [string, string][] = [];
            /** undo what was already set in RAM, leave without saving or rebooting (RAM = flash again) */
            const undo = async () => {
                for (const [n] of applied.slice().reverse()) {
                    const old = cur.raw.get(n)?.value;
                    if (old !== undefined) await this.cli.set(n, old).catch(() => undefined);
                }
                await this.cli.exitNoReboot().catch(() => undefined);
            };
            for (let i = 0; i < plan.length; i++) {
                const [name, value] = plan[i];
                // Disconnect pressed: stop here and leave the board's RAM as its flash (never half a program)
                if (this.closing) {
                    await undo();
                    throw new FcError('cancelled', 'disconnected while writing; the values written so far were undone');
                }
                progress({ step: 'write', done: i, total: plan.length });
                const r = await this.cli.set(name, value);
                if (!r.ok) {
                    this.log(`set ${name} = ${value} refused: ${r.text}`);
                    await undo();
                    throw new FcError(r.error === 'invalid-name' ? 'cli-invalid-name' : 'cli-invalid-value', `the board refused ${name} = ${value}`, {
                        name,
                        value,
                        answer: r.text.slice(0, 200)
                    });
                }
                applied.push([name, value]);
            }
            if (this.closing) {
                await undo();
                throw new FcError('cancelled', 'disconnected before saving; the values written were undone');
            }
            progress({ step: 'write', done: plan.length, total: plan.length });

            progress({ step: 'save' });
            // from here the values may be in flash: if the board cannot be checked now, it is checked once it is back
            this.unverified = expected;
            const answered = await this.expectReboot(() => this.cli.save());
            progress({ step: 'reboot' });
            progress({ step: 'reconnect' });
            // the program starts its countdown after the reboot: stop it at once, before the CLI does
            this.stopAfterReconnect = true;
            await this.reconnectAfterReboot();

            progress({ step: 'verify' });
            await this.cli.enter();
            let after: BoardSettings;
            try {
                after = await this.readInCli();
            } finally {
                await this.cli.exitNoReboot();
            }
            this.unverified = null;
            const mismatches = this.compare(expected, after);
            this.settings = after;
            if (mismatches.length) {
                // the port dropped before the board said "saving": the save never ran (nothing at all was kept)
                if (!answered && mismatches.length === Object.keys(expected).length) throw new FcError('not-saved', 'the board disconnected before it could save', { mismatches });
                throw new FcError('verify', 'the board did not keep every value', { mismatches });
            }
            progress({ step: 'done' });
            this.log(`saved and verified: ${Object.keys(expected).join(', ')}`);
            return { verified: Object.keys(expected), settings: after };
        });
    }

    /** Run `trigger` (save / MSP reboot) and wait until the port drops. Returns false when the trigger never got
     *  through or got no answer (save: the board did not say "saving"). */
    private async expectReboot(trigger: () => Promise<void | boolean>): Promise<boolean> {
        this.expectDrop = true;
        const dropped = new Promise<boolean>(resolve => {
            if (!this.transport.isOpen) return resolve(true);
            const t = setTimeout(() => resolve(false), this.opts.dropTimeoutMs);
            this.dropped = () => {
                clearTimeout(t);
                resolve(true);
            };
        });
        this.setPhase('rebooting');
        let answered = true;
        try {
            answered = (await trigger()) !== false;
        } catch (e) {
            if (!isFcError(e, 'lost') && !isFcError(e, 'not-open')) throw e;
            answered = false;
        }
        const ok = await dropped;
        this.dropped = null;
        if (!ok) this.log('the port did not drop after the reboot command; continuing');
        return answered;
    }

    private async reconnectAfterReboot() {
        this.setPhase('reconnecting');
        try {
            if (!this.transport.isOpen) await this.transport.reconnect(this.opts.reconnectTimeoutMs, this.abort.signal);
        } finally {
            this.expectDrop = false;
        }
        await this.afterReconnect();
    }

    /** First thing after the board is back: make sure the motor is stopped if we were asked to, identify. */
    private async afterReconnect() {
        this.cli.reset();
        await sleep(150);
        await this.flushStop();
        await this.identifyWithRecovery();
        // a STOP pressed while the board was being identified (the phase still says reconnecting)
        await this.flushStop();
    }

    private async flushStop() {
        if (!this.stopAfterReconnect) return;
        this.stopAfterReconnect = false;
        try {
            await this.sendStop();
        } catch (e) {
            this.stopFailEvents.emit(e);
            throw e;
        }
        this.stopFlushEvents.emit();
    }

    // ---------- motor ----------

    private async sendStop() {
        await this.msp.ask(MSP.SET_MOTOR, encodeSetMotor(new Array(8).fill(1000)), { priority: true, retries: 3, timeoutMs: 300 });
        this.log('STOP sent (all outputs 1000)');
    }

    /**
     * STOP: all outputs to 1000 via MSP_SET_MOTOR, which makes the autostart program yield until the next boot.
     * In the CLI the program is already stopped; while connecting or rebooting the stop is sent as soon as the
     * board answers.
     */
    async stopMotor(): Promise<'sent' | 'already-stopped' | 'queued'> {
        // reading / writing: the CLI is open or about to be (it stops the program); MSP written now would land
        // in the CLI's line buffer and break the command being typed
        if (this.cli.active || this.phase === 'reading' || this.phase === 'writing') {
            this.stopAfterReconnect = true; // in case a reboot follows
            return 'already-stopped';
        }
        // connecting: the board may have a CLI left open (MSP would be typed into it) or not answer at all (STOPs
        // would crowd out the identification); sent the moment it is identified
        if (!this.transport.isOpen || this.phase === 'connecting' || this.phase === 'rebooting' || this.phase === 'reconnecting') {
            this.stopAfterReconnect = true;
            return 'queued';
        }
        await this.sendStop();
        return 'sent';
    }

    /**
     * STOP through the CLI (enter, then leave without a reboot): stops the program in every state, also on
     * firmware 1.0, which ignores MSP_SET_MOTOR during the countdown. Used when STOP did not stop it.
     */
    async stopByCli(): Promise<void> {
        await this.exclusive('reading', async () => {
            await this.cli.enter();
            await this.cli.exitNoReboot();
            this.log('STOP through the CLI (enter, exit noreboot)');
        });
    }

    /** a STOP waits for the board to be back (it dies with a Disconnect) */
    get stopQueued() {
        return this.stopAfterReconnect;
    }

    /** a save went to the board but could not be checked yet: it is checked when the board is back by itself */
    get awaitingCheck() {
        return this.unverified !== null;
    }

    /** Reboot the board: the program starts again from the beginning (countdown, ramp). */
    async restartProgram(): Promise<void> {
        if (this.busy) throw new FcError('busy-op', 'another operation is still running');
        // forget an older queued stop now, before the phase changes: a STOP pressed from here on is kept and sent
        // right after the reboot (the reboot itself would clear the hold and run the program)
        this.stopAfterReconnect = false;
        await this.exclusive('rebooting', async () => {
            await this.expectReboot(async () => {
                await this.msp.ask(MSP.REBOOT, Uint8Array.of(0), { retries: 1, timeoutMs: 500 }).catch(e => {
                    if (!isFcError(e, 'timeout') && !isFcError(e, 'lost')) throw e;
                });
            });
            await this.reconnectAfterReboot();
            this.log('board restarted, program running from the start');
        });
    }

    // ---------- live view ----------

    startLive() {
        if (this.live) return;
        this.live = true;
        this.misses = 0;
        this.liveLoop = this.pollLoop();
    }

    async stopLive() {
        this.live = false;
        this.wakeLoop?.();
        await this.liveLoop;
        this.liveLoop = null;
    }

    private async pollLoop() {
        const period = 1000 / this.opts.pollHz;
        while (this.live) {
            const t0 = Date.now();
            if (this.phase === 'ready' && this.transport.isOpen && !this.cli.active) {
                const s = await this.pollOnce();
                if (s && this.live) this.liveEvents.emit(s);
            }
            const wait = period - (Date.now() - t0);
            if (wait > 0 && this.live)
                await new Promise<void>(r => {
                    const t = setTimeout(r, wait);
                    this.wakeLoop = () => {
                        clearTimeout(t);
                        r();
                    };
                });
            this.wakeLoop = null;
        }
    }

    /** One live sample (also used by the Node harness). Never throws. */
    async pollOnce(): Promise<LiveSample | null> {
        const opt = { timeoutMs: 250, retries: 0 };
        const get = async (cmd: number) => {
            try {
                return await this.msp.ask(cmd, undefined, opt);
            } catch {
                return null;
            }
        };
        const dbg = await get(MSP.DEBUG);
        if (!this.live && this.liveLoop) return null;
        const mot = await get(MSP.MOTOR);
        const bat = await get(MSP.BATTERY_STATE);
        const tel = await get(MSP.MOTOR_TELEMETRY);
        if (!dbg && !mot && !bat) {
            this.misses++;
            return { ...this.emptySample(), misses: this.misses };
        }
        this.misses = 0;
        const d = dbg ? parseDebug(dbg) : [];
        const debugOk = d.length >= 8 && (this.settings?.debugMode ?? 'AUTOSTART') === 'AUTOSTART' && d[0] >= 0 && d[0] <= 5;
        const esc = tel ? parseMotorTelemetry(tel) : [];
        const mask = typeof this.settings?.values.autostart_motors === 'number' ? this.settings.values.autostart_motors : 0xff;
        return {
            at: Date.now(),
            state: debugOk ? d[0] : null,
            pct: debugOk ? d[1] / 10 : null,
            // ms in state /10 is an int16 on the wire; read it unsigned so 600 s still fits
            msInState: debugOk ? (d[2] & 0xffff) * 10 : null,
            uptimeS: debugOk ? d[3] / 10 : null,
            flags: debugOk ? decodeFlags(d[4]) : null,
            sinceBatteryS: debugOk ? (d[6] < 0 ? null : d[6] / 10) : null,
            source: debugOk ? d[7] : null,
            motors: mot ? parseMotors(mot) : [],
            battery: bat ? parseBattery(bat) : null,
            esc,
            bestOutput: pickBestOutput(esc, mask),
            misses: 0
        };
    }

    private emptySample(): LiveSample {
        return { at: Date.now(), state: null, pct: null, msInState: null, uptimeS: null, flags: null, sinceBatteryS: null, source: null, motors: [], battery: null, esc: [], bestOutput: -1, misses: 0 };
    }

    // ---------- teardown ----------

    async disconnect() {
        this.closing = true;
        this.abort.abort();
        await this.stopLive();
        // an operation in progress ends at its next step: a write undoes its sets and leaves the CLI first
        // (never "exit noreboot" with half a program in RAM), a reboot wait is cancelled by the abort
        if (this.op) await Promise.race([this.op.catch(() => undefined), sleep(8000)]);
        this.setPhase('closed');
        if (this.cli.active) await this.cli.exitNoReboot().catch(() => undefined);
        await this.transport.close().catch(() => undefined);
        this.offClose();
        this.msp.dispose();
        this.cli.dispose();
        await this.recovering?.catch(() => undefined);
    }
}
