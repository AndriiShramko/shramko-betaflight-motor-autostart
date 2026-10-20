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
}

export type Phase = 'idle' | 'connecting' | 'ready' | 'reading' | 'writing' | 'rebooting' | 'reconnecting' | 'closed';

export interface LiveSample {
    at: number;
    /** debug[] decoded; null when debug_mode is not AUTOSTART */
    state: number | null;
    pct: number | null;
    msInState: number | null;
    uptimeS: number | null;
    flags: { usb: boolean; rx: boolean; button: boolean; battery: boolean; gust: boolean } | null;
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
const decodeFlags = (f: number) => ({ usb: !!(f & 1), rx: !!(f & 2), button: !!(f & 4), battery: !!(f & 8), gust: !!(f & 16) });

export const pickBestOutput = (esc: EscTelemetry[], mask = 0xff): number => {
    let best = -1;
    for (let i = 0; i < esc.length; i++) {
        if (!((mask >> i) & 1)) continue;
        const e = esc[i];
        if (e.invalidPct >= 100 && e.rpm === 0) continue;
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
    private readonly opts: Required<Omit<DeviceOptions, 'log'>> & { log?: (l: string) => void };
    private live = false;
    private liveLoop: Promise<void> | null = null;
    private misses = 0;
    private busy = false;
    /** set while we expect the port to drop (save, restart) */
    private expectDrop = false;
    private dropped: (() => void) | null = null;
    private stopAfterReconnect = false;
    private recovering: Promise<void> | null = null;
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
        if (this.expectDrop || this.phase === 'closed' || this.phase === 'idle') return;
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
            this.setPhase('ready');
            this.startLive();
        } catch (e) {
            if (!isFcError(e, 'cancelled')) this.log(`reconnect failed: ${String(e)}`);
            if (this.phase === 'reconnecting') this.setPhase('closed');
        }
    }

    /** exclusive operations (read/write/restart) never overlap */
    private async exclusive<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
        if (this.busy) throw new FcError('busy-op', 'another operation is still running');
        if (this.phase !== 'ready') throw new FcError('not-open', `board not ready (${this.phase})`);
        this.busy = true;
        await this.stopLive();
        this.setPhase(phase);
        try {
            return await fn();
        } finally {
            this.busy = false;
            const ph = this.phase as Phase; // changed inside fn()
            if (this.transport.isOpen && ph !== 'closed') {
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
    async connect(): Promise<Identity> {
        this.setPhase('connecting');
        try {
            await this.transport.open();
            this.log(`port open: ${this.transport.describe()}`);
            const id = await this.identifyWithRecovery();
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
            // MSP is silent: a previous session may have left the CLI open
            this.log('no MSP answer, trying to leave a CLI left open');
            await this.cli.leaveIfStuck();
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
            dshotBidir: raw.get('dshot_bidir')?.value ?? null
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
            for (let i = 0; i < plan.length; i++) {
                const [name, value] = plan[i];
                progress({ step: 'write', done: i, total: plan.length });
                const r = await this.cli.set(name, value);
                if (!r.ok) {
                    this.log(`set ${name} = ${value} refused: ${r.text}`);
                    // undo what was already set in RAM, leave without saving or rebooting
                    for (const [n] of applied.reverse()) {
                        const old = cur.raw.get(n)?.value;
                        if (old !== undefined) await this.cli.set(n, old).catch(() => undefined);
                    }
                    await this.cli.exitNoReboot();
                    throw new FcError(r.error === 'invalid-name' ? 'cli-invalid-name' : 'cli-invalid-value', `the board refused ${name} = ${value}`, {
                        name,
                        value,
                        answer: r.text.slice(0, 200)
                    });
                }
                applied.push([name, value]);
            }
            progress({ step: 'write', done: plan.length, total: plan.length });

            progress({ step: 'save' });
            await this.expectReboot(() => this.cli.save());
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
            const mismatches: { name: string; expected: string; got: string | null }[] = [];
            for (const [name, want] of Object.entries(expected)) {
                const got = after.raw.get(name)?.value ?? null;
                if (got === null || got.toUpperCase() !== want.toUpperCase()) mismatches.push({ name, expected: want, got });
            }
            this.settings = after;
            if (mismatches.length) throw new FcError('verify', 'the board did not keep every value', { mismatches });
            progress({ step: 'done' });
            this.log(`saved and verified: ${Object.keys(expected).join(', ')}`);
            return { verified: Object.keys(expected), settings: after };
        });
    }

    /** Run `trigger` (save / MSP reboot) and wait until the port drops. */
    private async expectReboot(trigger: () => Promise<void>) {
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
        try {
            await trigger();
        } catch (e) {
            if (!isFcError(e, 'lost') && !isFcError(e, 'not-open')) throw e;
        }
        const ok = await dropped;
        this.dropped = null;
        if (!ok) this.log('the port did not drop after the reboot command; continuing');
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
        if (this.stopAfterReconnect) {
            this.stopAfterReconnect = false;
            await this.sendStop();
        }
        await this.identifyWithRecovery();
    }

    // ---------- motor ----------

    private async sendStop() {
        await this.msp.ask(MSP.SET_MOTOR, encodeSetMotor(new Array(8).fill(1000)), { priority: true, retries: 3, timeoutMs: 300 });
        this.log('STOP sent (all outputs 1000)');
    }

    /**
     * STOP: all outputs to 1000 via MSP_SET_MOTOR, which makes the autostart program yield until the next boot.
     * In the CLI the program is already stopped; while rebooting the stop is sent as soon as the board is back.
     */
    async stopMotor(): Promise<'sent' | 'already-stopped' | 'queued'> {
        if (this.cli.active || this.phase === 'reading') {
            this.stopAfterReconnect = true; // in case a reboot follows
            return 'already-stopped';
        }
        if (!this.transport.isOpen || this.phase === 'rebooting' || this.phase === 'reconnecting') {
            this.stopAfterReconnect = true;
            return 'queued';
        }
        await this.sendStop();
        return 'sent';
    }

    /** Reboot the board: the program starts again from the beginning (countdown, ramp). */
    async restartProgram(): Promise<void> {
        await this.exclusive('rebooting', async () => {
            this.stopAfterReconnect = false;
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
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
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
        this.abort.abort();
        await this.stopLive();
        this.setPhase('closed');
        if (this.cli.active) await this.cli.exitNoReboot().catch(() => undefined);
        await this.transport.close().catch(() => undefined);
        this.offClose();
        this.msp.dispose();
        this.cli.dispose();
        await this.recovering?.catch(() => undefined);
    }
}
