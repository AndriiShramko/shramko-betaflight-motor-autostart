// The configurator mounted into <section id="tool">: Connect, board info, live view with STOP,
// the settings form (presets, groups, one-line help, human units), save with verification,
// voltage calibration and restart. Foolproof: every input is clamped, nothing invalid can be saved.

import './tool.css';
import enStrings from '../i18n/tool.en.json';
import { AutostartDevice, type BoardSettings, type Identity, type LiveSample, type Phase, type WriteStep } from '../fc/device';
import {
    DEF,
    GROUPS,
    SCHEMA,
    calibrateVbatScale,
    clampValue,
    cutoffVolts,
    defaultValues,
    diff,
    displayStep,
    fromDisplay,
    isRelevant,
    matchPreset,
    normalize,
    presetValues,
    toDisplay,
    unitDecimals,
    type Note,
    type NumDef,
    type PresetId,
    type SettingDef,
    type Value
} from '../fc/settings';
import { FcError, WebSerialTransport, browserSerial, detectSerialSupport, type SerialLike } from '../fc/transport';

export type Locale = 'en' | 'es' | 'pl' | 'ru';
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface ToolDiagnostics {
    phase: Phase;
    mock: boolean;
    support: string;
    board: string;
    firmware: string;
    build: string;
    verdict: string;
    level: string;
    lastError: string;
    log: string[];
}

export interface ToolHandle {
    destroy(): Promise<void>;
    diagnostics(): ToolDiagnostics;
}

const RELEASES = 'https://github.com/AndriiShramko/shramko-betaflight-motor-autostart/releases/latest';
const LOCALE_TAG: Record<Locale, string> = { en: 'en-US', es: 'es-ES', pl: 'pl-PL', ru: 'ru-RU' };
const NONZERO_FALLBACK: Record<string, number> = { autostart_run_time: 60, autostart_cells: 6, autostart_cell_cutoff: 330, autostart_vbat_min: 60 };
const HISTORY_S = 60;

let current: ToolHandle | null = null;
const fallback = enStrings as Record<string, string>;

/** Last mounted tool's diagnostics, for the feedback form ("technical data"). */
export const toolDiagnostics = (): ToolDiagnostics | null => current?.diagnostics() ?? null;

type Kid = Node | string | null | undefined | false;
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | number | boolean | undefined> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === false) continue;
        if (k === 'class') el.className = String(v);
        else if (k === 'text') el.textContent = String(v);
        else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
};

export function mountTool(root: HTMLElement, t: Translate, locale: Locale): ToolHandle {
    // ---------- strings and numbers ----------
    const tr = (key: string, vars: Record<string, string | number> = {}) => {
        let s = '';
        try {
            s = t(key, vars);
        } catch { /* page loader without vars support */ }
        if (!s || s === key) s = fallback[key] ?? key;
        return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    };
    const tag = LOCALE_TAG[locale] ?? 'en-US';
    const fmt = (n: number, digits = 0) => new Intl.NumberFormat(tag, { maximumFractionDigits: digits, minimumFractionDigits: 0, useGrouping: false }).format(n);
    const fmtFixed = (n: number, digits: number) => new Intl.NumberFormat(tag, { maximumFractionDigits: digits, minimumFractionDigits: digits, useGrouping: false }).format(n);
    const parseNum = (s: string) => parseFloat(s.replace(/\s/g, '').replace(',', '.'));

    // ---------- state ----------
    const params = new URLSearchParams(location.search);
    const mock = params.get('mock') === '1';
    const support = mock ? 'web-serial' : detectSerialSupport();
    // Android: load the WebUSB polyfill now, so the port picker opens inside the click's user activation
    const serialReady: Promise<SerialLike> | null = !mock && support === 'webusb' ? browserSerial() : null;
    serialReady?.catch(() => undefined);
    let device: AutostartDevice | null = null;
    let identity: Identity | null = null;
    let board: BoardSettings | null = null;
    let edited: Record<string, Value> = {};
    let extra: Record<string, Value> = {};
    const notes: Record<string, string> = {};
    let last: LiveSample | null = null;
    const history: { at: number; pct: number }[] = [];
    let lastError = '';
    const log: string[] = [];
    let opBusy = false;
    let lastState: number | null | undefined;
    const offs: (() => void)[] = [];

    const addLog = (l: string) => {
        log.push(`${new Date().toISOString().substring(11, 19)} ${l}`);
        if (log.length > 80) log.shift();
    };

    // ---------- skeleton ----------
    root.classList.add('st');
    root.replaceChildren();
    const uid = `st${Math.random().toString(36).slice(2, 7)}`;

    const statusEl = h('p', { class: 'st-status', role: 'status', 'aria-live': 'polite' });
    const announce = h('p', { class: 'st-sr', 'aria-live': 'polite' });
    const supportEl = h('p', { class: 'st-note' });
    const connectBtn = h('button', { type: 'button', class: 'st-btn st-primary st-big' }, tr('tool.connect'));
    const disconnectBtn = h('button', { type: 'button', class: 'st-btn st-ghost', hidden: true }, tr('tool.disconnect'));
    const facts = h('dl', { class: 'st-facts', hidden: true });
    const banner = h('div', { class: 'st-banners' });
    const errorBox = h('div', { class: 'st-error', role: 'alert', hidden: true });

    const connectCard = h(
        'div',
        { class: 'st-card st-connect' },
        h('h3', { text: tr('tool.title') }),
        h('p', { class: 'st-muted', text: tr('tool.intro') }),
        mock ? h('p', { class: 'st-note st-demo', text: tr('tool.mock') }) : null,
        supportEl,
        h('div', { class: 'st-row' }, connectBtn, disconnectBtn),
        statusEl,
        errorBox,
        facts,
        banner
    );

    // live
    const stateEl = h('p', { class: 'st-state' });
    const stateSub = h('p', { class: 'st-muted st-state-sub' });
    const thrVal = h('span', { class: 'st-big-num' });
    const thrFill = h('span', { class: 'st-fill' });
    const thrLimit = h('span', { class: 'st-limit', hidden: true });
    const thrLimitText = h('span', { class: 'st-muted st-small' });
    const batVal = h('span', { class: 'st-big-num' });
    const batSub = h('span', { class: 'st-muted st-small' });
    const batFill = h('span', { class: 'st-fill st-fill-bat' });
    const batCut = h('span', { class: 'st-limit st-cut', hidden: true });
    const batBar = h('div', { class: 'st-bar', hidden: true }, batFill, batCut);
    const rpmVal = h('span', { class: 'st-big-num' });
    const rpmSub = h('span', { class: 'st-muted st-small' });
    const chips = h('ul', { class: 'st-chips' });
    const spark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    spark.setAttribute('viewBox', '0 0 300 60');
    spark.setAttribute('preserveAspectRatio', 'none');
    spark.setAttribute('class', 'st-spark');
    spark.setAttribute('role', 'img');
    spark.setAttribute('aria-label', tr('tool.live.chart'));
    const sparkLine = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    spark.append(sparkLine);
    const debugNote = h('div', { class: 'st-note st-warn', hidden: true });
    const restartBtn = h('button', { type: 'button', class: 'st-btn' }, tr('tool.restart'));
    const liveMsg = h('p', { class: 'st-msg', 'aria-live': 'polite' });

    const liveCard = h(
        'div',
        { class: 'st-card st-live', hidden: true },
        h('h3', { text: tr('tool.live.title') }),
        stateEl,
        stateSub,
        h(
            'div',
            { class: 'st-meters' },
            h('div', { class: 'st-meter' }, h('span', { class: 'st-label', text: tr('tool.live.throttle') }), thrVal, h('div', { class: 'st-bar' }, thrFill, thrLimit), thrLimitText),
            h('div', { class: 'st-meter' }, h('span', { class: 'st-label', text: tr('tool.live.battery') }), batVal, batBar, batSub),
            h('div', { class: 'st-meter' }, h('span', { class: 'st-label', text: tr('tool.live.rpm') }), rpmVal, rpmSub)
        ),
        h('figure', { class: 'st-chart' }, spark, h('figcaption', { class: 'st-muted st-small', text: tr('tool.live.chart') })),
        chips,
        debugNote,
        h('div', { class: 'st-row' }, restartBtn),
        liveMsg
    );

    // settings
    const readBtn = h('button', { type: 'button', class: 'st-btn st-primary' }, tr('tool.read'));
    const readWarn = h('p', { class: 'st-note st-warn', text: tr('tool.read.warn') });
    const levelNote = h('div', { class: 'st-note st-warn', hidden: true });
    const presetsEl = h('div', { class: 'st-presets', role: 'radiogroup', 'aria-label': tr('tool.presets') });
    const formEl = h('form', { class: 'st-form', hidden: true, novalidate: true });
    const saveBtn = h('button', { type: 'button', class: 'st-btn st-primary', disabled: true }, tr('tool.save'));
    const undoBtn = h('button', { type: 'button', class: 'st-btn st-ghost', disabled: true }, tr('tool.undo'));
    const defaultsBtn = h('button', { type: 'button', class: 'st-btn st-ghost' }, tr('tool.defaults'));
    const changesEl = h('span', { class: 'st-muted st-small' });
    const saveMsg = h('div', { class: 'st-msg', 'aria-live': 'polite' });
    const actions = h(
        'div',
        { class: 'st-actions', hidden: true },
        h('div', { class: 'st-row' }, saveBtn, undoBtn, defaultsBtn, changesEl),
        h('p', { class: 'st-muted st-small', text: tr('tool.save.hint') }),
        saveMsg
    );
    const settingsCard = h(
        'div',
        { class: 'st-card st-settings', hidden: true },
        h('h3', { text: tr('tool.settings.title') }),
        h('div', { class: 'st-row' }, readBtn),
        readWarn,
        levelNote,
        formEl,
        actions
    );

    // stop bar + restart dialog
    const stopBtn = h('button', { type: 'button', class: 'st-btn st-stop' }, tr('tool.stop'));
    const stopBar = h('div', { class: 'st-stopbar', hidden: true }, stopBtn);
    const dlgCheck = h('input', { type: 'checkbox', id: `${uid}-chk` });
    const dlgConfirm = h('button', { type: 'button', class: 'st-btn st-primary', disabled: true }, tr('tool.restart.confirm'));
    const dlgCancel = h('button', { type: 'button', class: 'st-btn st-ghost' }, tr('tool.cancel'));
    const dlgBody = h('p');
    const dialog = h(
        'dialog',
        { class: 'st-dialog', 'aria-labelledby': `${uid}-dlg-t` },
        h('h3', { id: `${uid}-dlg-t`, text: tr('tool.restart.title') }),
        dlgBody,
        h('label', { class: 'st-check', for: `${uid}-chk` }, dlgCheck, h('span', { text: tr('tool.restart.check') })),
        h('div', { class: 'st-row' }, dlgConfirm, dlgCancel)
    );

    root.append(connectCard, liveCard, settingsCard, stopBar, dialog, announce);

    // ---------- helpers ----------
    const show = (el: HTMLElement, on: boolean) => {
        el.hidden = !on;
    };
    const setMsg = (el: HTMLElement, text: string, kind: 'ok' | 'warn' | 'err' | '' = '') => {
        el.textContent = text;
        el.className = `st-msg${kind ? ` st-${kind}` : ''}`;
    };

    const errorText = (e: unknown): string => {
        if (e instanceof FcError) {
            const d = e.detail;
            if (e.code === 'verify') {
                const list = ((d.mismatches as { name: string; expected: string; got: string | null }[]) ?? []).map(m => `${m.name} (${m.expected} → ${m.got ?? '—'})`).join(', ');
                return tr('tool.err.verify', { list });
            }
            if (e.code === 'internal') return tr('tool.err.internal', { msg: e.message });
            return tr(`tool.err.${e.code}`, { name: String(d.name ?? ''), value: String(d.value ?? '') });
        }
        console.error(e); // ours, unexpected: lands in the page's error capture
        return tr('tool.err.internal', { msg: e instanceof Error ? e.message : String(e) });
    };

    const showError = (e: unknown, where: HTMLElement = errorBox) => {
        const text = errorText(e);
        lastError = e instanceof FcError ? `${e.code}: ${e.message}` : String(e);
        addLog(`error ${lastError}`);
        if (where === errorBox) {
            errorBox.replaceChildren(h('p', { text }));
            show(errorBox, true);
        } else setMsg(where, text, 'err');
    };
    const clearError = () => {
        show(errorBox, false);
        errorBox.replaceChildren();
    };

    // ---------- support ----------
    const renderSupport = () => {
        if (support === 'web-serial') supportEl.textContent = tr('tool.support.ok');
        else if (support === 'webusb') supportEl.textContent = tr('tool.support.webusb');
        else if (support === 'insecure') supportEl.textContent = tr('tool.support.insecure');
        else supportEl.textContent = tr('tool.support.none');
        supportEl.className = `st-note${support === 'web-serial' || support === 'webusb' ? '' : ' st-warn'}`;
        connectBtn.disabled = support === 'none' || support === 'insecure';
    };

    // ---------- connection ----------
    const phaseText: Record<Phase, string> = {
        idle: 'tool.status.idle',
        connecting: 'tool.status.connecting',
        ready: 'tool.status.ready',
        reading: 'tool.status.reading',
        writing: 'tool.status.writing',
        rebooting: 'tool.status.rebooting',
        reconnecting: 'tool.status.reconnecting',
        closed: 'tool.status.closed'
    };

    const connected = () => !!device && device.phase !== 'idle' && device.phase !== 'closed';

    const renderPhase = () => {
        const p: Phase = device?.phase ?? 'idle';
        statusEl.textContent = tr(phaseText[p]);
        statusEl.className = `st-status st-phase-${p}`;
        const on = connected();
        show(connectBtn, !on);
        show(disconnectBtn, on);
        connectBtn.textContent = p === 'connecting' ? tr('tool.connecting') : tr('tool.connect');
        connectBtn.disabled = p === 'connecting' || support === 'none' || support === 'insecure';
        show(stopBar, on);
        show(liveCard, on && !!identity && identity.verdict !== 'not-betaflight');
        show(settingsCard, on && !!identity && identity.verdict !== 'not-betaflight');
        const ready = p === 'ready' && !opBusy;
        readBtn.disabled = !ready;
        restartBtn.disabled = !ready;
        defaultsBtn.disabled = !ready;
        updateActions();
        root.dataset.phase = p;
    };

    const renderFacts = () => {
        if (!identity) {
            show(facts, false);
            return;
        }
        const id = identity;
        const module =
            board?.level ? tr('tool.module.yes', { level: board.level }) : board ? tr('tool.module.no') : id.verdict === 'autostart' ? tr('tool.module.likely') : tr('tool.module.unknown');
        const row = (k: string, v: string) => h('div', {}, h('dt', { text: tr(k) }), h('dd', { text: v || '—' }));
        facts.replaceChildren(
            row('tool.fact.board', [id.board.boardName, id.board.manufacturerId].filter(Boolean).join(' · ') || id.board.identifier),
            row('tool.fact.firmware', `${id.variant} ${id.fcVersion}`),
            row('tool.fact.build', [id.build.revision, id.build.date].filter(Boolean).join(' · ')),
            row('tool.fact.module', module)
        );
        show(facts, true);
        // banners
        banner.replaceChildren();
        const install = () => h('a', { href: '#install', text: tr('tool.install.link') });
        if (id.verdict === 'not-betaflight') banner.append(h('div', { class: 'st-note st-warn' }, tr('tool.verdict.notbf', { variant: id.variant || '?' }), ' ', install()));
        else if (board && !board.level) banner.append(h('div', { class: 'st-note st-warn' }, tr('tool.verdict.stock'), ' ', install()));
        else if (id.verdict === 'betaflight-other' && !board) banner.append(h('div', { class: 'st-note' }, tr('tool.verdict.other'), ' ', install()));
        if (board?.level === '1.0') {
            levelNote.replaceChildren(tr('tool.level.old'), ' ', h('a', { href: RELEASES, target: '_blank', rel: 'noopener', text: tr('tool.level.link') }));
            show(levelNote, true);
        } else show(levelNote, false);
    };

    const onPhase = () => {
        renderPhase();
        if (device?.phase === 'ready') {
            identity = device.identity;
            renderFacts();
        }
    };

    const connect = async () => {
        clearError();
        if (device) await device.disconnect().catch(() => undefined);
        let serial: SerialLike;
        try {
            if (mock) {
                const m = await import('../fc/mockfc');
                serial = new m.MockSerial(new m.MockFc(m.mockOptionsFromQuery(params)));
            } else serial = await (serialReady ?? browserSerial());
        } catch (e) {
            showError(e);
            return;
        }
        const timeout = mock && params.has('mockReconnectTimeout') ? Number(params.get('mockReconnectTimeout')) : 20000;
        const dev = new AutostartDevice(new WebSerialTransport(serial), { reconnectTimeoutMs: Number.isFinite(timeout) ? timeout : 20000, log: addLog });
        device = dev;
        offs.push(dev.phaseEvents.on(onPhase), dev.liveEvents.on(onLive));
        board = null;
        identity = null;
        edited = {};
        extra = {};
        history.length = 0;
        formEl.replaceChildren();
        show(formEl, false);
        show(actions, false);
        readBtn.textContent = tr('tool.read');
        renderPhase();
        try {
            identity = await dev.connect();
            renderFacts();
        } catch (e) {
            if (device === dev) device = null;
            showError(e);
        }
        renderPhase();
    };

    const disconnect = async () => {
        const d = device;
        device = null;
        identity = null;
        board = null;
        if (d) await d.disconnect().catch(() => undefined);
        offs.splice(0).forEach(f => f());
        renderFacts();
        banner.replaceChildren();
        renderPhase();
        statusEl.textContent = tr('tool.status.closed');
    };

    // ---------- live ----------
    const savedNum = (name: string): number | null => {
        const v = board?.values[name];
        return typeof v === 'number' ? v : null;
    };

    const stateLine = (s: LiveSample): [string, string] => {
        if (s.misses >= 3) return [tr('tool.live.noAnswer'), ''];
        if (s.state === null) return [tr('tool.state.unknown'), board?.debugMode && board.debugMode !== 'AUTOSTART' ? tr('tool.live.debugOff') : ''];
        const name = tr(`tool.state.${s.state}`);
        const sec = (s.msInState ?? 0) / 1000;
        const delay = savedNum('autostart_delay');
        const ramp = savedNum('autostart_ramp');
        const run = savedNum('autostart_run_time');
        switch (s.state) {
            case 1:
                return [name, delay !== null ? tr('tool.live.countdown', { s: fmt(Math.max(0, Math.ceil(delay - sec))) }) : tr('tool.live.elapsed', { s: fmt(Math.floor(sec)) })];
            case 2:
                return [name, ramp !== null ? tr('tool.live.rampLeft', { s: fmt(Math.max(0, ramp / 10 - sec), 1) }) : tr('tool.live.elapsed', { s: fmt(Math.floor(sec)) })];
            case 3:
                return [name, run ? tr('tool.live.runLeft', { s: fmt(Math.max(0, Math.ceil(run - sec))) }) : ''];
            case 0: {
                if (s.motors.slice(0, 8).some(m => m > 1000)) return [name, tr('tool.live.manual')];
                const mode = board?.values.autostart_mode;
                if (mode === 'BUTTON') return [name, tr('tool.live.waitButton')];
                if (s.flags && !s.flags.battery && savedNum('autostart_vbat_min') !== 0) return [name, tr('tool.live.waitBattery')];
                return [name, mode === 'OFF' ? '' : tr('tool.live.stopped')];
            }
            default:
                return [name, ''];
        }
    };

    const cellCount = (s: LiveSample | null) => {
        const c = savedNum('autostart_cells');
        if (c && c > 0) return c;
        return s?.battery?.cells ?? 0;
    };

    const onLive = (s: LiveSample) => {
        last = s;
        const [line, sub] = stateLine(s);
        stateEl.textContent = line;
        stateEl.dataset.state = String(s.state ?? 'x');
        stateSub.textContent = sub;
        if (s.state !== lastState) {
            announce.textContent = line;
            lastState = s.state;
        }
        // throttle: the program's command, or the outputs when something else drives them
        let pct = s.pct;
        if (pct === null || (s.state === 0 && s.motors.some(m => m > 1000))) {
            const m = Math.max(1000, ...s.motors.slice(0, 8));
            pct = s.motors.length ? (m - 1000) / 10 : null;
        }
        thrVal.textContent = pct === null ? '—' : `${fmt(pct, 1)} %`;
        thrFill.style.width = `${Math.min(100, Math.max(0, pct ?? 0))}%`;
        const limit = savedNum('autostart_throttle_limit');
        if (limit !== null && limit < 100) {
            thrLimit.style.left = `${limit}%`;
            show(thrLimit, true);
            thrLimitText.textContent = tr('tool.live.limit', { v: fmt(limit) });
        } else {
            show(thrLimit, false);
            thrLimitText.textContent = '';
        }
        // battery
        const b = s.battery;
        const cells = cellCount(s);
        if (!b || b.volts < 1) {
            batVal.textContent = '—';
            batSub.textContent = tr('tool.live.noBattery');
            show(batBar, false);
        } else {
            batVal.textContent = `${fmtFixed(b.volts, 2)} V`;
            const parts: string[] = [];
            if (cells > 0) parts.push(tr('tool.live.perCell', { v: fmtFixed(b.volts / cells, 2), n: cells }));
            const cut = cutoffVolts(savedNum('autostart_cell_cutoff') ?? 0, cells);
            if (cut !== null) parts.push(tr('tool.live.cutoff', { v: fmt(cut, 2) }));
            if (s.flags?.implausible) parts.push(tr('tool.live.implausible', { n: cells || '?' }));
            batSub.textContent = parts.join(' · ');
            batSub.classList.toggle('st-warn-text', !!s.flags?.implausible);
            if (cells > 0) {
                const lo = cells * 3.0;
                const hi = cells * 4.25;
                const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100))}%`;
                batFill.style.width = pos(b.volts);
                batFill.classList.toggle('st-low', cut !== null && b.volts < cut);
                if (cut !== null) batCut.style.left = pos(cut);
                show(batCut, cut !== null);
                show(batBar, true);
            } else show(batBar, false);
        }
        // ESC
        if (s.bestOutput >= 0) {
            const e = s.esc[s.bestOutput];
            rpmVal.textContent = `${fmt(e.rpm)} rpm`;
            const parts = [tr('tool.live.rpmValue', { n: s.bestOutput + 1, bad: fmt(e.invalidPct, 1) })];
            if (e.tempC > 0) parts.push(tr('tool.live.escTemp', { t: fmt(e.tempC) }));
            if (e.volts > 0) parts.push(tr('tool.live.escVolts', { v: fmtFixed(e.volts, 2) }));
            rpmSub.textContent = parts.join(' · ');
        } else {
            rpmVal.textContent = '—';
            // no ESC answers: without bidirectional DShot (and no ESC sensor wire) that is expected
            rpmSub.textContent = board?.dshotBidir === 'OFF' ? tr('tool.live.noTelemetry') : s.esc.length ? tr('tool.live.noEsc') : '';
        }
        // flags
        chips.replaceChildren();
        if (s.flags) {
            for (const k of ['usb', 'battery', 'rx', 'button', 'gust'] as const) chips.append(h('li', { class: s.flags[k] ? 'st-on' : '', text: tr(`tool.live.flags.${k}`) }));
        }
        // sparkline
        history.push({ at: s.at, pct: pct ?? 0 });
        while (history.length && history[0].at < s.at - HISTORY_S * 1000) history.shift();
        sparkLine.setAttribute('points', history.map(p => `${(300 - ((s.at - p.at) / (HISTORY_S * 1000)) * 300).toFixed(1)},${(58 - (Math.min(100, p.pct) / 100) * 56).toFixed(1)}`).join(' '));
        // debug_mode hint
        if (board?.debugMode && board.debugMode !== 'AUTOSTART' && s.state === null) {
            debugNote.replaceChildren(tr('tool.live.debugOff'), ' ');
            if (extra.debug_mode === 'AUTOSTART') debugNote.append(h('span', { text: tr('tool.live.debugStaged') }));
            else {
                const fix = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.live.debugFix'));
                fix.addEventListener('click', () => {
                    extra.debug_mode = 'AUTOSTART';
                    updateActions();
                    if (last) onLive(last);
                });
                debugNote.append(fix);
            }
            show(debugNote, true);
        } else show(debugNote, false);
        calRender();
    };

    // ---------- settings form ----------
    const fields: Record<string, { sync: () => void; wrap: HTMLElement }> = {};
    let calRender: () => void = () => undefined;

    const unitLabel = (d: NumDef) => {
        switch (d.unit) {
            case 's':
            case 'ds':
            case 'ms':
                return tr('tool.unit.s');
            case 'pct':
                return tr('tool.unit.pct');
            case 'cV':
            case 'dV':
                return tr('tool.unit.V');
            case 'cells':
                return tr('tool.unit.cells');
            default:
                return '';
        }
    };

    /** label of an enum value; a value only newer firmware knows is shown as is */
    const optLabel = (name: string, v: Value) => {
        const k = `tool.opt.${name}.${v}`;
        const s = tr(k);
        return s === k ? String(v) : s;
    };

    const showValue = (name: string, v: Value): string => {
        const d = DEF[name];
        if (!d) return String(v);
        if (d.kind === 'enum') return optLabel(name, v);
        if (d.kind === 'choice') return v === 255 ? tr('tool.opt.autostart_box.255') : `USER${Number(v) - 39}`;
        if (d.kind === 'mask') return Array.from({ length: 8 }, (_, i) => ((Number(v) >> i) & 1 ? String(i + 1) : '')).filter(Boolean).join(', ');
        if (d.zero && v === 0) return tr(`tool.zero.${name}`);
        const u = unitLabel(d);
        return `${fmt(toDisplay(d, Number(v)), unitDecimals(d.unit))}${u ? ` ${u}` : ''}`;
    };

    const noteText = (n: Note) => {
        const e = board!.eff[n.name];
        const d = e.def;
        if (n.kind === 'swapped') return tr('tool.note.swapped');
        if (n.kind === 'mask-empty') return tr('tool.note.mask');
        if (n.kind === 'invalid') return tr('tool.note.invalid', { to: showValue(n.name, n.to!) });
        if (d.kind === 'num') {
            const lo = d.minNonZero && e.min === 0 ? d.minNonZero : e.min;
            return tr('tool.note.clamped', { to: showValue(n.name, n.to!), min: fmt(toDisplay(d, lo), unitDecimals(d.unit)), max: fmt(toDisplay(d, e.max), unitDecimals(d.unit)) });
        }
        return tr('tool.note.invalid', { to: showValue(n.name, n.to!) });
    };

    const setValue = (name: string, v: Value, fromUser = true) => {
        edited[name] = v;
        if (fromUser) delete notes[name];
        refreshForm();
    };

    const buildField = (d: SettingDef): HTMLElement => {
        const name = d.name;
        const e = board!.eff[name];
        const id = `${uid}-${name}`;
        const helpId = `${id}-h`;
        const noteEl = h('p', { class: 'st-fnote', 'aria-live': 'polite' });
        const wasEl = h('span', { class: 'st-was' });
        const label = h('label', { for: id, class: 'st-flabel' }, h('span', { text: tr(`tool.f.${name}.label`) }), wasEl);
        const help = h('p', { class: 'st-help', id: helpId, text: tr(`tool.f.${name}.help`) });
        const wrap = h('div', { class: 'st-field', 'data-name': name });
        let sync: () => void = () => undefined;

        if (!e.present) {
            wrap.append(h('span', { class: 'st-flabel', text: tr(`tool.f.${name}.label`) }), h('p', { class: 'st-help', text: tr('tool.missing') }));
            wrap.classList.add('st-missing');
            fields[name] = { sync, wrap };
            return wrap;
        }

        if (d.kind === 'enum') {
            const group = h('div', { class: 'st-seg', role: 'radiogroup', 'aria-labelledby': `${id}-l`, 'aria-describedby': helpId });
            const radios: HTMLInputElement[] = [];
            for (const val of e.values) {
                const r = h('input', { type: 'radio', name: id, value: val, id: `${id}-${val}` });
                r.addEventListener('change', () => r.checked && setValue(name, val));
                radios.push(r);
                group.append(h('label', { for: `${id}-${val}`, class: 'st-seg-opt' }, r, h('span', { text: optLabel(name, val) })));
            }
            wrap.append(h('span', { class: 'st-flabel', id: `${id}-l` }, h('span', { text: tr(`tool.f.${name}.label`) }), wasEl), group, help);
            sync = () => radios.forEach(r => (r.checked = r.value === String(edited[name])));
        } else if (d.kind === 'choice') {
            const sel = h('select', { id, 'aria-describedby': helpId });
            for (const c of d.choices) sel.append(h('option', { value: c, text: showValue(name, c) }));
            sel.addEventListener('change', () => setValue(name, Number(sel.value)));
            wrap.append(label, sel, help);
            sync = () => (sel.value = String(edited[name]));
        } else if (d.kind === 'mask') {
            const motorCount = Math.max(4, last?.esc.length ?? 0, (Number(board!.values[name]) & 0xf0) ? 8 : 0);
            const boxes: HTMLInputElement[] = [];
            const row = h('div', { class: 'st-mask', role: 'group', 'aria-labelledby': `${id}-l`, 'aria-describedby': helpId });
            for (let i = 0; i < Math.min(8, motorCount); i++) {
                const c = h('input', { type: 'checkbox', id: `${id}-${i}` });
                c.addEventListener('change', () => {
                    const m = boxes.reduce((acc, b, j) => (b.checked ? acc | (1 << j) : acc), Number(edited[name]) & ~((1 << boxes.length) - 1));
                    const n: Note[] = [];
                    edited[name] = clampValue(e, m, n);
                    if (n.length) notes[name] = noteText(n[0]);
                    else delete notes[name];
                    refreshForm();
                });
                boxes.push(c);
                row.append(h('label', { class: 'st-check st-check-inline', for: `${id}-${i}` }, c, h('span', { text: tr('tool.motor', { n: i + 1 }) })));
            }
            wrap.append(h('span', { class: 'st-flabel', id: `${id}-l` }, h('span', { text: tr(`tool.f.${name}.label`) }), wasEl), row, help);
            sync = () => boxes.forEach((b, i) => (b.checked = ((Number(edited[name]) >> i) & 1) === 1));
        } else {
            const nd = d;
            const dec = unitDecimals(nd.unit);
            const lo = nd.minNonZero && e.min === 0 ? nd.minNonZero : e.min;
            const input = h('input', { type: 'text', id, inputmode: dec ? 'decimal' : 'numeric', autocomplete: 'off', 'aria-describedby': `${helpId} ${id}-n`, class: 'st-num' });
            const unit = h('span', { class: 'st-unit', text: unitLabel(nd) });
            let range: HTMLInputElement | null = null;
            if (nd.unit === 'pct') {
                range = h('input', { type: 'range', min: e.min, max: e.max, step: 1, 'aria-label': tr(`tool.f.${name}.label`), class: 'st-range' });
                range.addEventListener('input', () => setValue(name, Number(range!.value)));
            }
            let zeroBox: HTMLInputElement | null = null;
            const lastNonZero = { v: Number(board!.values[name]) || NONZERO_FALLBACK[name] || lo };
            if (nd.zero) {
                zeroBox = h('input', { type: 'checkbox', id: `${id}-z` });
                zeroBox.addEventListener('change', () => {
                    if (zeroBox!.checked) {
                        if (Number(edited[name]) !== 0) lastNonZero.v = Number(edited[name]);
                        setValue(name, 0);
                    } else setValue(name, clampValue(e, lastNonZero.v));
                });
            }
            const commit = (finalize: boolean) => {
                const raw = parseNum(input.value);
                const n: Note[] = [];
                const v = Number.isFinite(raw) ? clampValue(e, fromDisplay(nd, raw), n) : clampValue(e, input.value, n);
                if (zeroBox && v === 0 && !finalize) return;
                edited[name] = v;
                if (finalize) {
                    if (n.length && n[0].kind !== 'rounded') notes[name] = noteText(n[0]);
                    else delete notes[name];
                    refreshForm();
                } else {
                    delete notes[name];
                    refreshForm(name);
                }
            };
            input.addEventListener('input', () => commit(false));
            input.addEventListener('change', () => commit(true));
            input.addEventListener('keydown', ev => {
                if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
                ev.preventDefault();
                const step = displayStep(nd) * (ev.shiftKey ? 10 : 1);
                const cur = Number.isFinite(parseNum(input.value)) ? parseNum(input.value) : toDisplay(nd, Number(edited[name]));
                const next = cur + (ev.key === 'ArrowUp' ? step : -step);
                setValue(name, clampValue(e, fromDisplay(nd, next)));
            });
            const total = h('p', { class: 'st-help st-total' });
            wrap.append(label, h('div', { class: 'st-inrow' }, input, unit, range));
            if (zeroBox) wrap.append(h('label', { class: 'st-check', for: `${id}-z` }, zeroBox, h('span', { text: tr(`tool.zero.${name}`) })));
            wrap.append(help);
            if (name === 'autostart_cell_cutoff') wrap.append(total);
            sync = () => {
                const v = Number(edited[name]);
                const isZero = !!zeroBox && v === 0;
                input.value = isZero ? '' : fmt(toDisplay(nd, v), dec);
                input.disabled = isZero;
                if (zeroBox) zeroBox.checked = isZero;
                if (range) range.value = String(v);
                if (name === 'autostart_cell_cutoff') {
                    const cells = Number(edited.autostart_cells) || last?.battery?.cells || 0;
                    const tv = cutoffVolts(v, cells);
                    total.textContent = tv !== null ? tr('tool.cutoff.total', { v: fmt(tv, 2), n: cells }) : '';
                }
            };
        }
        noteEl.id = `${id}-n`;
        wrap.append(noteEl);
        const fullSync = sync;
        sync = () => {
            fullSync();
            const changed = board!.values[name] !== undefined && String(board!.values[name]) !== String(edited[name]);
            wrap.classList.toggle('st-changed', changed);
            wasEl.textContent = changed ? tr('tool.changed.from', { v: showValue(name, board!.values[name]) }) : '';
            noteEl.textContent = notes[name] ?? '';
            const relevant = isRelevant(name, edited);
            wrap.classList.toggle('st-dim', !relevant);
        };
        fields[name] = { sync, wrap };
        return wrap;
    };

    const buildCalibration = (): HTMLElement => {
        const id = `${uid}-cal`;
        const shown = h('p', { class: 'st-help' });
        const input = h('input', { type: 'text', id, inputmode: 'decimal', autocomplete: 'off', class: 'st-num' });
        const apply = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.cal.apply'));
        const msg = h('p', { class: 'st-fnote', 'aria-live': 'polite' });
        // the ESC measures the pack too: one click calibrates without a multimeter
        const escHint = h('p', { class: 'st-help' });
        const escApply = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.cal.escApply', { v: '—' }));
        const escVolts = (): number => {
            const s0 = last;
            if (!s0 || s0.bestOutput < 0) return 0;
            const v = s0.esc[s0.bestOutput]?.volts ?? 0;
            return v > 1 ? v : 0;
        };
        const box = h(
            'div',
            { class: 'st-cal' },
            h('h4', { text: tr('tool.cal.title') }),
            shown,
            escHint,
            h('div', { class: 'st-inrow' }, escApply),
            h('label', { for: id, class: 'st-flabel', text: tr('tool.cal.input') }),
            h('div', { class: 'st-inrow' }, input, h('span', { class: 'st-unit', text: tr('tool.unit.V') }), apply),
            msg
        );
        calRender = () => {
            const v = last?.battery?.volts ?? 0;
            shown.textContent = v >= 1 ? tr('tool.cal.shown', { v: fmtFixed(v, 2) }) : tr('tool.cal.noReading');
            apply.disabled = v < 1 || device?.phase !== 'ready';
            const ev = escVolts();
            if (ev > 0 && v >= 1) {
                const diff = Math.abs(v - ev) / ev * 100;
                escHint.textContent = tr('tool.cal.escHint', { esc: fmtFixed(ev, 2), fc: fmtFixed(v, 2), d: fmtFixed(diff, 1) });
                escHint.className = diff > 5 ? 'st-help st-warn' : 'st-help';
                escApply.textContent = tr('tool.cal.escApply', { v: fmtFixed(ev, 2) });
                escApply.disabled = device?.phase !== 'ready';
                show(escApply, true);
            } else {
                escHint.textContent = tr('tool.cal.escNone');
                escHint.className = 'st-help';
                show(escApply, false);
            }
        };
        escApply.addEventListener('click', () => {
            const ev = escVolts();
            if (ev > 0) {
                input.value = fmtFixed(ev, 2);
                go();
            }
        });
        const go = () => {
            const shownV = last?.battery?.volts ?? 0;
            const old = Number(board?.values.vbat_scale ?? 0);
            const r = calibrateVbatScale(old, parseNum(input.value), shownV);
            if (!r.ok) {
                msg.textContent = r.reason === 'no-reading' ? tr('tool.cal.noReading') : tr('tool.cal.badInput');
                msg.className = 'st-fnote st-warn';
                return;
            }
            setValue('vbat_scale', r.scale);
            msg.textContent = tr('tool.cal.result', { new: r.scale, old }) + (r.clamped ? ` ${tr('tool.cal.clamped')}` : '');
            msg.className = 'st-fnote st-ok';
        };
        apply.addEventListener('click', go);
        input.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') {
                ev.preventDefault();
                go();
            }
        });
        calRender();
        return box;
    };

    const presetButtons: Record<PresetId, HTMLInputElement> = {} as Record<PresetId, HTMLInputElement>;
    const customEl = h('p', { class: 'st-muted st-small', text: tr('tool.preset.custom') });

    const buildPresets = () => {
        presetsEl.replaceChildren();
        for (const id of ['steady', 'gusts'] as PresetId[]) {
            const vals = presetValues(id, board!.eff);
            const rid = `${uid}-p-${id}`;
            const r = h('input', { type: 'radio', name: `${uid}-preset`, id: rid, disabled: !vals });
            r.addEventListener('change', () => {
                if (!r.checked || !vals) return;
                Object.assign(edited, vals);
                for (const k of Object.keys(vals)) delete notes[k];
                refreshForm();
            });
            presetButtons[id] = r;
            presetsEl.append(
                h('label', { class: 'st-preset', for: rid }, r, h('span', {}, h('b', { text: tr(`tool.preset.${id}`) }), h('small', { text: vals ? tr(`tool.preset.${id}.help`) : tr('tool.preset.unavailable') })))
            );
        }
        presetsEl.append(customEl);
    };

    const buildForm = () => {
        for (const k of Object.keys(fields)) delete fields[k];
        formEl.replaceChildren();
        if (!board?.level) {
            show(formEl, false);
            show(actions, false);
            return;
        }
        buildPresets();
        formEl.append(h('h4', { class: 'st-sub', text: tr('tool.presets') }), presetsEl);
        for (const g of GROUPS) {
            const defs = SCHEMA.filter(d => d.group === g);
            const fs = h('fieldset', { class: `st-group st-g-${g}` }, h('legend', { text: tr(`tool.group.${g}`) }));
            if (g === 'gusts') fs.append(h('p', { class: 'st-help st-gusts-off', text: tr('tool.gusts.off') }));
            const grid = h('div', { class: 'st-grid' });
            for (const d of defs) grid.append(buildField(d));
            fs.append(grid);
            if (g === 'battery' && board.eff.vbat_scale?.present) fs.append(buildCalibration());
            if (g === 'advanced') {
                const det = h('details', { class: 'st-adv' }, h('summary', { text: tr(`tool.group.${g}`) }), grid);
                formEl.append(det);
            } else formEl.append(fs);
        }
        show(formEl, true);
        show(actions, true);
        refreshForm();
    };

    const refreshForm = (except?: string) => {
        if (!board) return;
        for (const [name, f] of Object.entries(fields)) {
            if (name === except) {
                // keep the text the visitor is typing, update the rest of the field
                const inp = f.wrap.querySelector<HTMLInputElement>('input.st-num');
                const keep = inp?.value;
                f.sync();
                if (inp && keep !== undefined) inp.value = keep;
            } else f.sync();
        }
        const gustsOff = edited.autostart_pattern !== 'GUSTS';
        formEl.querySelector('.st-g-gusts')?.classList.toggle('st-off', gustsOff);
        const p = matchPreset(edited, board.eff);
        for (const id of ['steady', 'gusts'] as PresetId[]) if (presetButtons[id]) presetButtons[id].checked = p === id;
        show(customEl, p === null);
        updateActions();
    };

    const pendingChanges = (): Record<string, Value> => {
        if (!board) return {};
        const { values } = normalize(board.eff, edited);
        const out = diff(board.values, values);
        for (const [k, v] of Object.entries(extra)) if (board.debugMode !== null && String(v) !== board.debugMode) out[k] = v;
        return out;
    };

    function updateActions() {
        const n = Object.keys(pendingChanges()).length;
        const ready = device?.phase === 'ready' && !opBusy;
        saveBtn.disabled = !ready || n === 0;
        undoBtn.disabled = !ready || n === 0;
        changesEl.textContent = n ? tr('tool.changes', { n }) : tr('tool.nochanges');
    }

    // ---------- operations ----------
    const run = async (fn: () => Promise<void>, msgEl: HTMLElement) => {
        if (opBusy) return;
        opBusy = true;
        clearError();
        renderPhase();
        try {
            await fn();
        } catch (e) {
            showError(e, msgEl);
        } finally {
            opBusy = false;
            renderPhase();
        }
    };

    readBtn.addEventListener('click', () =>
        run(async () => {
            if (!device) return;
            setMsg(saveMsg, '');
            board = await device.readSettings();
            identity = device.identity;
            edited = { ...board.values };
            extra = {};
            for (const k of Object.keys(notes)) delete notes[k];
            readBtn.textContent = tr('tool.read.again');
            buildForm();
            renderFacts();
            setMsg(saveMsg, board.level ? tr('tool.read.done') : '', 'ok');
        }, saveMsg)
    );

    saveBtn.addEventListener('click', () =>
        run(async () => {
            if (!device || !board) return;
            const { values, notes: n } = normalize(board.eff, edited);
            for (const note of n) if (note.kind === 'swapped') notes[note.name] = noteText(note);
            edited = values;
            const changes = pendingChanges();
            if (!Object.keys(changes).length) return;
            const stepText = (s: WriteStep) => {
                if (s.step === 'write') return tr('tool.step.write', { done: Math.min((s.done ?? 0) + 1, s.total ?? 1), total: s.total ?? 1 });
                if (s.step === 'done') return '';
                return tr(`tool.step.${s.step}`);
            };
            setMsg(saveMsg, tr('tool.step.write', { done: 1, total: Object.keys(changes).length }));
            try {
                const r = await device.writeSettings(changes, s => setMsg(saveMsg, stepText(s)));
                board = r.settings;
                edited = { ...board.values };
                extra = {};
                for (const k of Object.keys(notes)) delete notes[k];
                buildForm();
                renderFacts();
                saveMsg.replaceChildren(h('strong', { text: tr('tool.saved', { n: r.verified.length }) }), ' ', tr('tool.saved.after'));
                saveMsg.className = 'st-msg st-ok';
                saveMsg.dataset.result = 'saved';
            } catch (e) {
                // a failed verify re-read the board: show what it really has, keep the visitor's edits
                if (device.settings && device.settings !== board) {
                    board = device.settings;
                    buildForm();
                }
                saveMsg.dataset.result = 'error';
                throw e;
            }
        }, saveMsg)
    );

    undoBtn.addEventListener('click', () => {
        if (!board) return;
        edited = { ...board.values };
        extra = {};
        for (const k of Object.keys(notes)) delete notes[k];
        refreshForm();
        setMsg(saveMsg, '');
    });

    defaultsBtn.addEventListener('click', () => {
        if (!board) return;
        Object.assign(edited, defaultValues(board.eff));
        for (const k of Object.keys(notes)) delete notes[k];
        refreshForm();
        setMsg(saveMsg, tr('tool.defaults.note'));
    });

    stopBtn.addEventListener('click', async () => {
        if (!device) return;
        try {
            const r = await device.stopMotor();
            setMsg(liveMsg, tr(r === 'sent' ? 'tool.stop.sent' : r === 'queued' ? 'tool.stop.queued' : 'tool.stop.already'), 'ok');
        } catch (e) {
            showError(e, liveMsg);
        }
    });

    restartBtn.addEventListener('click', () => {
        const d = savedNum('autostart_delay');
        const thr = savedNum('autostart_throttle');
        dlgBody.textContent = d !== null && thr !== null ? tr('tool.restart.body', { delay: fmt(d), thr: fmt(thr) }) : tr('tool.restart.bodyUnknown');
        dlgCheck.checked = false;
        dlgConfirm.disabled = true;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        dlgCheck.focus();
    });
    dlgCheck.addEventListener('change', () => (dlgConfirm.disabled = !dlgCheck.checked));
    const closeDialog = () => {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
    };
    dlgCancel.addEventListener('click', closeDialog);
    dlgConfirm.addEventListener('click', () => {
        if (!dlgCheck.checked) return;
        closeDialog();
        void run(async () => {
            if (!device) return;
            setMsg(liveMsg, tr('tool.status.rebooting'));
            await device.restartProgram();
            history.length = 0;
            setMsg(liveMsg, tr('tool.restart.done'), 'ok');
        }, liveMsg);
    });

    connectBtn.addEventListener('click', () => void connect());
    disconnectBtn.addEventListener('click', () => void disconnect());
    formEl.addEventListener('submit', ev => ev.preventDefault());

    renderSupport();
    renderPhase();

    const handle: ToolHandle = {
        async destroy() {
            await disconnect();
            root.replaceChildren();
            root.classList.remove('st');
            if (current === handle) current = null;
        },
        diagnostics: () => ({
            phase: device?.phase ?? 'idle',
            mock,
            support,
            board: identity ? `${identity.board.boardName || identity.board.identifier}` : '',
            firmware: identity ? `${identity.variant} ${identity.fcVersion}` : '',
            build: identity?.build.revision ?? '',
            verdict: identity?.verdict ?? '',
            level: board?.level ?? '',
            lastError,
            log: log.slice(-40)
        })
    };
    current = handle;
    return handle;
}

