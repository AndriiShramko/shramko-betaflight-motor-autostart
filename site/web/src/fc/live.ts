// Live data the page can trust (pure logic, unit-tested in tests/live.test.ts):
// - EscTracker: ESC telemetry over the TX wire is sparse (some answers are all zeros) and, after a board restart,
//   MSP keeps the LAST value until the ESC sends again (it sends only once the motor has turned). So an answer is
//   held for a few seconds before "no answer" is said, the voltage is the median of recent readings, and a voltage
//   counts as fresh only when the ESC is really sending (the motor turns, the value moves, or live DShot frames).
//   A battery unplugged or swapped with USB connected restarts the ESC too: MSP keeps the old pack's last frame
//   (its rpm as well) until the motor turns on the new battery — only a turn counts as fresh then.
// - StateClock: debug[2] (ms in state / 10) stops at 655.35 s (1.1, uint16) or 327.67 s (1.0, int16), debug[3]
//   (uptime) at 3276.7 s: past the caps the time in a state is counted on from the last sample below them.
// - VoltSettle: Betaflight's filtered voltage rises for ~1.5 s after a battery plug-in; the firmware ignores it for
//   3 s (bit 32, the cut-off), and so does the page.

import type { EscTelemetry } from './msp';

/** how long an ESC answer is held before "no answer" (sparse TX-wire samples) */
export const ESC_HOLD_MS = 3000;
/** recent non-zero voltage readings the median is taken over */
const VOLTS_KEPT = 9;
/** a LiPo cell is plausible in 2.50–4.45 V (the firmware's bit-32 rule) */
export const CELL_PLAUSIBLE_MIN = 2.5;
export const CELL_PLAUSIBLE_MAX = 4.45;

export interface EscView {
    /** output with a (held) ESC answer, -1 = none */
    output: number;
    rpm: number;
    tempC: number;
    invalidPct: number;
    /** median of the recent non-zero voltage readings of that output (0 = none) */
    volts: number;
    /** the ESC is sending now: the motor turned since the restart, the voltage moved, or live DShot frames */
    fresh: boolean;
    /** DShot telemetry statistics are present (bad frames mean something) */
    dshot: boolean;
    /** an ESC answered at some time in this session */
    seen: boolean;
    /** the motor turned since the last restart (board or battery): rpm > 0 while driven, or an rpm that changes */
    turned: boolean;
}

/** what restarted: the board (Save, Run, unplugged USB) or only the battery (the ESC restarts, the board does not) */
export type RestartCause = 'board' | 'battery';

interface Answer {
    at: number;
    rpm: number;
    volts: number;
    tempC: number;
    inv: number;
}

const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export class EscTracker {
    private last: (Answer | undefined)[] = [];
    private volts: number[][] = [];
    private distinct: Set<number>[] = [];
    private best = -1;
    private seenAny = false;
    private turnedSinceRestart = false;
    /** restarted by a battery plug-in: only a turn makes the voltage fresh (a moving value is not enough) */
    private needTurn = false;
    private dshotSeen = false;

    constructor(private readonly holdMs = ESC_HOLD_MS) {}

    /** a new board session: nothing seen yet */
    reset() {
        this.restart();
        this.needTurn = false; // a new session on a board that did not restart: an ESC that sends at a stop is fresh
        this.seenAny = false;
        this.dshotSeen = false;
    }

    /**
     * The board restarted (Save, Run, unplugged) or the battery went away (unplugged, swapped: the ESC restarts):
     * what MSP shows now may be from before — the old pack's voltage. The median starts again.
     */
    restart(cause: RestartCause = 'board') {
        this.last = [];
        this.volts = [];
        this.distinct = [];
        this.best = -1;
        this.turnedSinceRestart = false;
        // after ANY restart only a real turn makes the voltage fresh (real board 20.10: after a board restart the
        // ESC's TX telemetry is silent until the motor turns once, MSP keeps the old frame; a 'battery' restart
        // followed by a 'board' one must not lose this — the final recheck saw an old 25.11 V counted as fresh)
        void cause;
        this.needTurn = true;
    }

    /** `motors`: the outputs of the same sample (1000 = stop); without them any rpm > 0 counts as a turn */
    push(at: number, esc: EscTelemetry[], mask = 0xff, motors?: number[]): EscView {
        // DShot telemetry: outputs without an ESC report 100 % bad frames; the TX wire reports 0 everywhere
        const dshot = esc.some(e => e.invalidPct > 0);
        if (dshot) this.dshotSeen = true;
        for (let i = 0; i < esc.length; i++) {
            if (!((mask >> i) & 1)) continue;
            const e = esc[i];
            const answers = e.rpm > 0 || e.volts > 0 || e.tempC > 0 || (dshot && e.invalidPct < 100);
            if (!answers) continue; // an empty sample: hold the last answer
            this.seenAny = true;
            const prev = this.last[i];
            // a real turn: rpm while the output drives the motor, or an rpm that changes (coasting down). A frozen
            // frame repeats the rpm the ESC last sent, also while the output is at 1000.
            const turns = e.rpm > 0 && (!motors || (motors[i] ?? 0) > 1000 || (!!prev && prev.rpm > 0 && prev.rpm !== e.rpm));
            this.last[i] = {
                at,
                rpm: e.rpm,
                volts: e.volts > 0 ? e.volts : prev?.volts ?? 0,
                tempC: e.tempC > 0 ? e.tempC : prev?.tempC ?? 0,
                inv: e.invalidPct
            };
            if (turns && !this.turnedSinceRestart) {
                // the first turn since the restart: the voltages held before it may be the old frame — not in the median
                this.turnedSinceRestart = true;
                this.needTurn = false;
                this.volts = [];
                this.distinct = [];
            }
            if (e.volts > 0) {
                (this.volts[i] ??= []).push(e.volts);
                if (this.volts[i].length > VOLTS_KEPT) this.volts[i].shift();
                const d = (this.distinct[i] ??= new Set());
                if (d.size < 4) d.add(Math.round(e.volts * 100));
            }
        }
        const alive = (i: number) => {
            const a = this.last[i];
            return !!a && at - a.at <= this.holdMs && ((mask >> i) & 1) === 1;
        };
        if (!alive(this.best)) {
            this.best = -1;
            for (let i = 0; i < this.last.length; i++) {
                if (!alive(i)) continue;
                const a = this.last[i]!;
                const b = this.best >= 0 ? this.last[this.best]! : null;
                if (!b || a.inv < b.inv || (a.inv === b.inv && a.rpm > b.rpm)) this.best = i;
            }
        }
        const o = this.best;
        const a = o >= 0 ? this.last[o]! : null;
        const liveFrames = !!a && dshot && a.inv < 100 && at - a.at <= 500;
        return {
            output: o,
            rpm: a?.rpm ?? 0,
            tempC: a?.tempC ?? 0,
            invalidPct: a?.inv ?? 0,
            volts: o >= 0 ? median(this.volts[o] ?? []) : 0,
            fresh: !!a && (this.turnedSinceRestart || liveFrames || (!this.needTurn && (this.distinct[o]?.size ?? 0) >= 2)),
            dshot: this.dshotSeen,
            seen: this.seenAny,
            turned: this.turnedSinceRestart
        };
    }
}

/** Is `volts` a LiPo of `cells` cells (2.50–4.45 V per cell)? With no known count: of any count 1–12. */
export const plausibleVolts = (volts: number, cells: number | null): boolean => {
    if (!(volts > 0)) return false;
    const ok = (n: number) => volts / n >= CELL_PLAUSIBLE_MIN && volts / n <= CELL_PLAUSIBLE_MAX;
    if (cells && cells > 0) return ok(cells);
    for (let n = 1; n <= 12; n++) if (ok(n)) return true;
    return false;
};

export interface StateTime {
    /** seconds in the current state */
    sec: number;
    /** false: only a lower bound is known (connected after the counter had stopped) */
    exact: boolean;
}

/** Time in the current state, also past the firmware's caps of debug[2] and debug[3]. */
export class StateClock {
    private state: number | null = null;
    private lastMs = -1;
    /** board uptime (s) when the state began, from a sample below the cap */
    private startUp: number | null = null;
    /** the last sample with a running uptime: page time (ms) and uptime (s); uptime per page second */
    private lastUp: { at: number; up: number } | null = null;
    private firstUp: { at: number; up: number } | null = null;
    private frozenSince: number | null = null;

    reset() {
        this.state = null;
        this.lastMs = -1;
        this.startUp = null;
        this.lastUp = null;
        this.firstUp = null;
        this.frozenSince = null;
    }

    /** the counter's top: 655.35 s on 1.1 (uint16), 327.67 s on 1.0 (int16) */
    static cap(level: '1.0' | '1.1' | null) {
        return level === '1.0' ? 327_670 : 655_350;
    }

    update(s: { at: number; state: number | null; msInState: number | null; uptimeS: number | null }, level: '1.0' | '1.1' | null): StateTime {
        const ms = s.msInState ?? 0;
        const up = s.uptimeS;
        const upRunning = up !== null && up < 3276.7;
        if (upRunning) {
            if (this.lastUp && up! < this.lastUp.up) this.firstUp = null; // the board restarted
            this.lastUp = { at: s.at, up: up! };
            this.firstUp ??= { at: s.at, up: up! };
        }
        // a new state (or the same state again from the start)
        if (s.state !== this.state || ms < this.lastMs - 50) {
            this.state = s.state;
            this.startUp = null;
            this.frozenSince = null;
        }
        // the counter stopped: at its top, or not moving while the board's clock (or the page's) moves on
        const atCap = ms >= StateClock.cap(level) || ms >= 655_350;
        if (ms === this.lastMs && ms >= 327_670) this.frozenSince ??= s.at;
        else if (ms !== this.lastMs) this.frozenSince = null;
        this.lastMs = ms;
        const frozen = atCap || this.frozenSince !== null;
        if (!frozen) {
            if (upRunning) this.startUp = up! - ms / 1000;
            return { sec: ms / 1000, exact: true };
        }
        if (this.startUp !== null && this.lastUp) {
            // uptime per page second (1 on a real board; faster in the demo)
            const rate = this.firstUp && this.lastUp.at > this.firstUp.at + 1000 ? (this.lastUp.up - this.firstUp.up) / ((this.lastUp.at - this.firstUp.at) / 1000) : 1;
            const past = upRunning ? 0 : ((s.at - this.lastUp.at) / 1000) * (rate > 0 ? rate : 1);
            return { sec: Math.max(ms / 1000, this.lastUp.up - this.startUp + past), exact: true };
        }
        return { sec: ms / 1000, exact: false };
    }
}

/** Has the battery reading settled after a plug-in? sinceBattery from debug[6]; without it: 3 calm samples. */
export class VoltSettle {
    private prev: number | null = null;
    private calm = 0;

    reset() {
        this.prev = null;
        this.calm = 0;
    }

    update(volts: number, sinceBatteryS: number | null): boolean {
        const near = this.prev !== null && Math.abs(volts - this.prev) <= 0.2;
        this.calm = near ? this.calm + 1 : 0;
        this.prev = volts;
        if (!(volts >= 1)) return false;
        if (sinceBatteryS !== null) return sinceBatteryS >= 3;
        return this.calm >= 2;
    }
}
