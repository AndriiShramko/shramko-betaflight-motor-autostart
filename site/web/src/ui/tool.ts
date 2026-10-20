// The configurator mounted into <section id="tool">, in task order:
//   Step 2 "Connect the board": the propeller warning, Connect, one connection line, the fixed STOP bar,
//     a closed "Board details" and the verdict banners;
//   "Motor status": the state in plain words, Power, Battery and every battery warning, Run the program,
//     a closed "More live data" (motor speed, chart, flags);
//   Step 3 "Choose what it does": the program in words (describeProgram), five simple questions, one
//     "More settings" drawer with everything else, save with verification, calibration.
// Foolproof: every input is clamped, nothing invalid can be saved, nothing safety-relevant is hidden.
// Page contract: window events 'sma:board' {connected, module, phase} (out) and 'sma:stop' (in);
// <html class="sma-connected" style="--sma-stop-h: …px"> while the fixed STOP bar is shown.

import './tool.css';
import enStrings from '../i18n/tool.en.json';
import { AutostartDevice, type BoardSettings, type Identity, type LiveSample, type Phase, type WriteStep } from '../fc/device';
import {
    CHIP_VALUES,
    DEF,
    MIN_START_S,
    MORE,
    MORE_IDS,
    SCHEMA,
    SIMPLE,
    SUGGESTED_GUST_POWER,
    attention,
    calibrateVbatScale,
    capOf,
    cellFit,
    clampValue,
    cutoffVolts,
    defaultValues,
    describeProgram,
    diff,
    displayStep,
    fromDisplay,
    gustMix,
    hiddenDiffs,
    isRelevant,
    joinMinSec,
    moreOf,
    normalize,
    splitMinSec,
    toDisplay,
    unitDecimals,
    type MoreId,
    type Note,
    type NumDef,
    type ProgramLine,
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
/** ESC and board voltages further apart than this: the cut-off may fire too late, calibrate */
const ESC_APART_PCT = 5;
/** "More settings" open or closed, per visitor (the page works without storage) */
const MORE_STORE = 'sma_more_open';
/** the factory program (docs/settings.md, this build), shown before the board's own is read */
const FACTORY: Record<string, Value> = Object.fromEntries(SCHEMA.map(d => [d.name, d.def]));

const store = {
    get(k: string): string | null {
        try {
            return localStorage.getItem(k);
        } catch {
            return null;
        }
    },
    set(k: string, v: string) {
        try {
            localStorage.setItem(k, v);
        } catch { /* private mode: not remembered */ }
    }
};

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

/** Rebuild `el` only when `sig` changed (keeps focus on buttons inside lines that refresh 5 times a second). */
const rebuild = (el: HTMLElement, sig: string, build: () => Kid[]) => {
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.replaceChildren(...(build().filter(k => k !== null && k !== undefined && k !== false) as (Node | string)[]));
};

const sameValue = (a: Value | undefined, b: Value | undefined) => String(a).toUpperCase() === String(b).toUpperCase();

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
    const fmtDuration = (total: number) => {
        const { min, sec } = splitMinSec(total);
        if (min && sec) return tr('tool.dur.minSec', { m: fmt(min), s: fmt(sec) });
        return min ? tr('tool.dur.min', { m: fmt(min) }) : tr('tool.dur.sec', { s: fmt(sec) });
    };

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
    let lastMain: string | undefined;
    let lastPhase: Phase | undefined;
    let closedNote = false;
    /** why the board holds the program (wording only; the live flag says whether it does) */
    let heldBy: 'settings' | 'stop' | null = null;
    /** a save just finished and nothing was edited since */
    let justSaved = false;
    /** reasons the drawer already opened for by itself (it never re-opens for the same reason, never closes) */
    const autoOpened = new Set<string>();
    /** "Other" chosen in a quick-pick question although the value equals a chip */
    const otherOn: Record<string, boolean> = {};
    let lastTimed = NONZERO_FALLBACK.autostart_run_time;
    const offs: (() => void)[] = [];

    const addLog = (l: string) => {
        log.push(`${new Date().toISOString().substring(11, 19)} ${l}`);
        if (log.length > 80) log.shift();
    };

    // ---------- skeleton ----------
    root.classList.add('st');
    root.replaceChildren();
    const uid = `st${Math.random().toString(36).slice(2, 7)}`;

    // the only two live regions of the tool
    const announce = h('p', { class: 'st-sr', role: 'status', 'aria-live': 'polite' });
    const alertEl = h('p', { class: 'st-sr', role: 'alert' });
    // texts that arrive within SAY_MS are joined into one announcement (a screen reader may read only the last
    // of several quick changes); a safety reason (the drawer opening itself, a battery check) comes last
    const SAY_MS = 400;
    let sayQueue: { text: string; safety: boolean }[] = [];
    let sayTimer: ReturnType<typeof setTimeout> | null = null;
    const sentence = (s: string) => (/[.!?…:]$/.test(s) ? s : `${s}.`);
    const say = (text: string, safety = false) => {
        if (!text) return;
        if (!sayQueue.some(q => q.text === text)) sayQueue.push({ text, safety });
        if (sayTimer) return;
        announce.textContent = ''; // the same text again is a change too
        sayTimer = setTimeout(() => {
            const all = [...sayQueue.filter(q => !q.safety), ...sayQueue.filter(q => q.safety)];
            sayQueue = [];
            sayTimer = null;
            announce.textContent = all.length > 1 ? all.map(q => sentence(q.text)).join(' ') : all[0]?.text ?? '';
        }, SAY_MS);
    };
    const alarm = (text: string) => {
        alertEl.textContent = '';
        setTimeout(() => (alertEl.textContent = text), 40);
    };

    // step 2: connect
    const supportEl = h('p', { class: 'st-note st-warn', hidden: true });
    const connectBtn = h('button', { type: 'button', class: 'st-btn st-primary st-big' }, tr('tool.connect'));
    // the picker lists flight-controller USB chips only; this one lists every port
    const allPortsBtn = h('button', { type: 'button', class: 'st-linkbtn' }, tr('tool.connect.all'));
    const intro = h('p', { class: 'st-muted', text: tr('tool.intro') });
    const connectRow = h('div', { class: 'st-row' }, connectBtn, allPortsBtn);
    const statusEl = h('p', { class: 'st-status' });
    const errorBox = h('div', { class: 'st-error', hidden: true });
    // focus lands here after Connect (tabindex -1): the next Tab is STOP
    const connLine = h('p', { class: 'st-conn', tabindex: -1 });
    const disconnectBtn = h('button', { type: 'button', class: 'st-btn st-ghost st-small' }, tr('tool.disconnect'));
    // the state words ellipsize, the Power % never does
    const stopText = h('span', { class: 'st-stoptext' });
    const stopPct = h('span', { class: 'st-stoppct' });
    const stopState = h('span', { class: 'st-stopstate' }, stopText, stopPct);
    const stopBtn = h('button', { type: 'button', class: 'st-btn st-stop' }, tr('tool.stop'));
    // fixed at the bottom of the window; in the DOM right after the connection line and before Disconnect,
    // so STOP is the first Tab stop after it (position: fixed takes it out of the row's layout)
    const stopBar = h('div', { class: 'st-stopbar', hidden: true }, stopState, stopBtn);
    const connRow = h('div', { class: 'st-row st-connrow', hidden: true }, connLine, stopBar, disconnectBtn);
    const facts = h('dl', { class: 'st-facts' });
    const factsDet = h('details', { class: 'st-det', hidden: true }, h('summary', { text: tr('tool.details') }), facts);
    const banner = h('div', { class: 'st-banners' });
    const checkBtn = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.check'));

    const connectCard = h(
        'div',
        { class: 'st-card st-connect', id: 'tool-connect' },
        h('h3', { text: tr('tool.title') }),
        h('p', { class: 'st-note st-warn st-callout' }, h('strong', { text: tr('tool.callout') })),
        intro,
        mock ? h('p', { class: 'st-note st-demo', text: tr('tool.mock') }) : null,
        supportEl,
        connectRow,
        statusEl,
        errorBox,
        connRow,
        factsDet,
        banner
    );

    // motor status
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
    const liveWarn = h('div', { class: 'st-warns' });
    const debugNote = h('div', { class: 'st-note st-warn', hidden: true });
    const restartBtn = h('button', { type: 'button', class: 'st-btn' }, tr('tool.restart'));
    const liveMsg = h('p', { class: 'st-msg' });

    const liveCard = h(
        'div',
        { class: 'st-card st-live', id: 'tool-status', hidden: true },
        h('h3', { text: tr('tool.live.title') }),
        stateEl,
        stateSub,
        h(
            'div',
            { class: 'st-meters' },
            h('div', { class: 'st-meter' }, h('span', { class: 'st-label', text: tr('tool.live.power') }), thrVal, h('div', { class: 'st-bar' }, thrFill, thrLimit), thrLimitText),
            h('div', { class: 'st-meter' }, h('span', { class: 'st-label', text: tr('tool.live.battery') }), batVal, batBar, batSub)
        ),
        liveWarn,
        debugNote,
        h('div', { class: 'st-row' }, restartBtn),
        liveMsg,
        h(
            'details',
            { class: 'st-det st-livemore' },
            h('summary', { text: tr('tool.live.more') }),
            h('div', { class: 'st-meters' }, h('div', { class: 'st-meter' }, h('span', { class: 'st-label', text: tr('tool.live.rpm') }), rpmVal, rpmSub)),
            h('figure', { class: 'st-chart' }, spark, h('figcaption', { class: 'st-muted st-small', text: tr('tool.live.chart') })),
            chips,
            h('p', { class: 'st-muted st-small', text: tr('tool.live.flagsHelp') })
        )
    );

    // step 3: choose what it does
    const levelNote = h('div', { class: 'st-note st-bad', hidden: true });
    const readBtn = h('button', { type: 'button', class: 'st-btn st-primary' }, tr('tool.read'));
    const preMsg = h('p', { class: 'st-msg' });
    const preRead = h(
        'div',
        { class: 'st-preread' },
        h('p', { text: tr('tool.prog.fresh') }),
        h('div', { class: 'st-program' }, null),
        h('p', { text: tr('tool.prog.done') }),
        // the level is known only after the read: firmware 1.0 (a public release) has no battery stop
        h('p', { class: 'st-note st-warn st-fw10', text: tr('tool.prog.fw10') }),
        h('div', { class: 'st-row' }, readBtn),
        h('p', { class: 'st-muted st-small', text: tr('tool.read.warn') }),
        preMsg
    );
    const formEl = h('form', { class: 'st-form', hidden: true, novalidate: true });
    const progTitle = h('h4', { text: tr('tool.prog.title') });
    const progBody = h('div');
    const programBox = h('div', { class: 'st-program', tabindex: -1 }, progTitle, progBody);
    const moreInfo = h('span', { class: 'st-more-info' });
    // stable ids for the page's deep links (#tool-more, #tool-more-battery, …): one tool per page
    const moreDet = h('details', { class: 'st-more', id: 'tool-more' });
    const moreSummary = h('summary', {}, h('span', { class: 'st-more-t', text: tr('tool.more') }), moreInfo);
    const resetBtn = h('button', { type: 'button', class: 'st-btn st-ghost st-small' }, tr('tool.defaults'));
    const changesEl = h('div', { class: 'st-changes' });
    const testBtn = h('button', { type: 'button', class: 'st-linkbtn st-inline' }, tr('tool.test'));
    const saveBtn = h('button', { type: 'button', class: 'st-btn st-primary', disabled: true }, tr('tool.save'));
    const undoBtn = h('button', { type: 'button', class: 'st-btn st-ghost', disabled: true }, tr('tool.undo'));
    const saveMsg = h('div', { class: 'st-msg', tabindex: -1 });
    const reloadBtn = h('button', { type: 'button', class: 'st-btn st-ghost st-small' }, tr('tool.reload'));
    const reloadHint = h('span', { class: 'st-muted st-small', text: tr('tool.reload.pending'), hidden: true });
    const actions = h(
        'div',
        { class: 'st-actions' },
        changesEl,
        h('div', { class: 'st-row' }, saveBtn, undoBtn),
        h('p', { class: 'st-muted st-small', text: tr('tool.save.hint') }),
        saveMsg,
        h('div', { class: 'st-row st-reload' }, reloadBtn, reloadHint)
    );
    const settingsCard = h('div', { class: 'st-card st-settings', id: 'tool-settings', hidden: true }, h('h3', { text: tr('tool.settings.title') }), levelNote, preRead, formEl);

    // dialogs: every one of them carries its own STOP while a board is connected (a modal makes the page inert)
    const stopButtons: HTMLButtonElement[] = [stopBtn];
    const dialogStop = () => {
        const b = h('button', { type: 'button', class: 'st-btn st-stop st-dlgstop', hidden: true }, tr('tool.stop'));
        b.addEventListener('click', () => void doStop());
        stopButtons.push(b);
        return b;
    };
    const dlgCheck = h('input', { type: 'checkbox', id: `${uid}-chk` });
    const dlgConfirm = h('button', { type: 'button', class: 'st-btn st-primary', disabled: true }, tr('tool.restart.confirm'));
    const dlgCancel = h('button', { type: 'button', class: 'st-btn st-ghost' }, tr('tool.cancel'));
    const dlgBody = h('div', { class: 'st-dlg-body' });
    const dialog = h(
        'dialog',
        { class: 'st-dialog st-run', 'aria-labelledby': `${uid}-dlg-t` },
        h('h3', { id: `${uid}-dlg-t`, text: tr('tool.restart.title') }),
        dlgBody,
        h('label', { class: 'st-check', for: `${uid}-chk` }, dlgCheck, h('span', { text: tr('tool.restart.check') })),
        h('div', { class: 'st-row' }, dlgConfirm, dlgCancel, dialogStop())
    );
    const cfTitle = h('h3', { id: `${uid}-cf-t` });
    const cfBody = h('p', { id: `${uid}-cf-b` });
    const cfList = h('ul', { class: 'st-cflist' });
    const cfOk = h('button', { type: 'button', class: 'st-btn' });
    const cfCancel = h('button', { type: 'button', class: 'st-btn st-ghost' }, tr('tool.cancel'));
    const confirmDlg = h('dialog', { class: 'st-dialog', 'aria-labelledby': `${uid}-cf-t`, 'aria-describedby': `${uid}-cf-b` }, cfTitle, cfBody, cfList, h('div', { class: 'st-row' }, cfOk, cfCancel, dialogStop()));

    root.append(connectCard, liveCard, settingsCard, dialog, confirmDlg, announce, alertEl);

    // ---------- helpers ----------
    const show = (el: HTMLElement, on: boolean) => {
        el.hidden = !on;
    };
    const setMsg = (el: HTMLElement, text: string, kind: 'ok' | 'warn' | 'err' | '' = '') => {
        el.textContent = text;
        el.className = `st-msg${kind ? ` st-${kind}` : ''}`;
        delete el.dataset.result;
    };
    const focusEl = (el: HTMLElement | null) => {
        if (el && !el.hidden) el.focus();
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

    const showError = (e: unknown, where: HTMLElement = errorBox, offerAllPorts = false) => {
        const text = errorText(e);
        lastError = e instanceof FcError ? `${e.code}: ${e.message}` : String(e);
        addLog(`error ${lastError}`);
        alarm(text);
        if (where === errorBox) {
            errorBox.replaceChildren(h('p', { text }));
            if (offerAllPorts && support !== 'none' && support !== 'insecure') {
                const b = h('button', { type: 'button', class: 'st-linkbtn' }, tr('tool.connect.all'));
                b.addEventListener('click', () => void connect(true));
                errorBox.append(b);
            }
            show(errorBox, true);
        } else setMsg(where, text, 'err');
    };
    const clearError = () => {
        show(errorBox, false);
        errorBox.replaceChildren();
    };

    // ---------- support ----------
    const renderSupport = () => {
        // the good news is not shown (it only took space next to "Connected"); every limitation is
        const key = support === 'webusb' ? 'tool.support.webusb' : support === 'insecure' ? 'tool.support.insecure' : support === 'none' ? 'tool.support.none' : '';
        supportEl.textContent = key ? tr(key) : '';
        supportEl.className = `st-note${support === 'webusb' ? '' : ' st-warn'}`;
        show(supportEl, !!key);
        connectBtn.disabled = support === 'none' || support === 'insecure';
        allPortsBtn.disabled = connectBtn.disabled;
    };

    // ---------- values in words ----------
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
    const unitName = (d: NumDef) =>
        d.unit === 'pct' ? tr('tool.unitName.pct') : d.unit === 'cells' ? tr('tool.unitName.cells') : d.unit === 'cV' || d.unit === 'dV' ? tr('tool.unitName.V') : d.unit === 'raw' ? '' : tr('tool.unitName.s');
    const labelOf = (name: string) => tr(`tool.f.${name}.label`);
    /** accessible name of a number box: the label and the unit ("Shortest gust, seconds") */
    const nameWithUnit = (name: string, d: NumDef) => (unitName(d) ? `${labelOf(name)}, ${unitName(d)}` : labelOf(name));

    /** label of an enum value; a value only newer firmware knows is shown as is */
    const optLabel = (name: string, v: Value) => {
        const k = `tool.opt.${name}.${v}`;
        const s = tr(k);
        return s === k ? String(v) : s;
    };

    const maskList = (v: Value) =>
        Array.from({ length: 8 }, (_, i) => ((Number(v) >> i) & 1 ? String(i + 1) : ''))
            .filter(Boolean)
            .join(', ');

    const showValue = (name: string, v: Value): string => {
        const d = DEF[name];
        if (!d) return String(v);
        if (d.kind === 'enum') return optLabel(name, v);
        if (d.kind === 'choice') return Number(v) === 255 ? tr('tool.opt.autostart_box.255') : `USER${Number(v) - 39}`;
        if (d.kind === 'mask') return maskList(v);
        if (d.zero && Number(v) === 0) return tr(`tool.zero.${name}`);
        if (name === 'autostart_run_time') return fmtDuration(Number(v));
        if (name === 'autostart_cells') return tr('tool.chip.cells', { n: fmt(Number(v)) });
        const u = unitLabel(d);
        return `${fmt(toDisplay(d, Number(v)), unitDecimals(d.unit))}${u ? ` ${u}` : ''}`;
    };
    const itemText = (name: string, v: Value = edited[name]) => tr('tool.item', { name: labelOf(name), value: showValue(name, v) });
    /** every item by name: the closed drawer must name each hidden value that differs (no "and N more") */
    const fullList = (names: string[]) => names.map(n => itemText(n)).join(', ');

    const noteText = (n: Note) => {
        const e = board!.eff[n.name];
        const d = e.def;
        if (n.kind === 'swapped') return tr('tool.note.swapped');
        if (n.kind === 'mask-empty') return tr('tool.note.mask');
        if (n.kind === 'invalid') return tr('tool.note.invalid', { to: showValue(n.name, n.to!) });
        if (d.kind === 'num') {
            const lo = d.minNonZero && e.min === 0 ? d.minNonZero : d.zero && e.min === 0 ? 1 : e.min;
            return tr('tool.note.clamped', { to: showValue(n.name, n.to!), min: fmt(toDisplay(d, lo), unitDecimals(d.unit)), max: fmt(toDisplay(d, e.max), unitDecimals(d.unit)) });
        }
        return tr('tool.note.invalid', { to: showValue(n.name, n.to!) });
    };

    /** numbers of a program line as text (volts, durations, …) */
    const progVars = (vars: Record<string, number>) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(vars)) out[k] = k === 'time' ? fmtDuration(v) : k === 'cut' ? fmtFixed(v, 2) : k === 'v' ? fmt(v, 2) : fmt(v, 1);
        return out;
    };
    const programList = (lines: ProgramLine[]) =>
        h(
            'dl',
            { class: 'st-prog' },
            ...lines.map(l => h('div', { class: l.tone ? `st-tone-${l.tone}` : undefined }, h('dt', { text: tr(`tool.prog.row.${l.row}`) }), h('dd', { text: tr(`tool.prog.${l.key}`, progVars(l.vars)) })))
        );
    preRead.querySelector('.st-program')!.append(programList(describeProgram(FACTORY, '1.1')));

    // ---------- connection ----------
    const phaseText: Record<Phase, string> = {
        idle: '',
        connecting: 'tool.status.connecting',
        ready: '',
        reading: 'tool.status.reading',
        writing: 'tool.status.writing',
        rebooting: 'tool.status.rebooting',
        reconnecting: 'tool.status.reconnecting',
        closed: 'tool.status.closed'
    };

    const connected = () => !!device && device.phase !== 'idle' && device.phase !== 'closed';
    /** the module is there (build says so or the settings showed it) */
    const hasModule = () => (board ? !!board.level : identity?.verdict === 'autostart');
    /** Motor status and Step 3 make sense only for a board with the module */
    const boardUsable = () => !!identity && identity.verdict === 'autostart' && !(board && !board.level);

    let lastBoardEvent = '';
    const emitBoard = () => {
        const detail = { connected: connected(), module: connected() && hasModule(), phase: device?.phase ?? 'idle' };
        const sig = JSON.stringify(detail);
        if (sig === lastBoardEvent) return;
        lastBoardEvent = sig;
        window.dispatchEvent(new CustomEvent('sma:board', { detail }));
    };

    // the fixed STOP bar never covers what the visitor works on: room for it at the bottom of the page
    const applyStopSpace = () => {
        const de = document.documentElement;
        if (stopBar.hidden) {
            de.classList.remove('sma-connected');
            de.style.removeProperty('--sma-stop-h');
            de.style.scrollPaddingBottom = '';
            document.body.style.paddingBottom = '';
            return;
        }
        const px = Math.ceil(stopBar.getBoundingClientRect().height);
        de.classList.add('sma-connected');
        de.style.setProperty('--sma-stop-h', `${px}px`);
        de.style.scrollPaddingBottom = `${px + 12}px`;
        document.body.style.paddingBottom = `${px + 12}px`;
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyStopSpace()) : null;
    ro?.observe(stopBar);

    const connText = () => {
        if (!identity) return '';
        const id = identity;
        const name = id.board.boardName || id.board.identifier || '?';
        if (id.verdict === 'not-betaflight') return tr('tool.conn.other', { board: name, variant: id.variant || '?' });
        if (board?.level) return tr('tool.conn.oursLevel', { board: name, level: board.level });
        if (id.verdict === 'autostart' && !board) return tr('tool.conn.ours', { board: name });
        return tr('tool.conn.bf', { board: name, fw: id.fcVersion });
    };

    let lastStatusKey = '';
    const renderPhase = () => {
        const p: Phase = device?.phase ?? 'idle';
        const on = connected();
        // a restart the page started (save, Run, reload) is not an unplugged board: "Waiting for the board…"
        const key = p === 'reconnecting' && opBusy ? 'tool.step.reconnect' : phaseText[p];
        statusEl.textContent = key ? tr(key) : p === 'idle' && closedNote ? tr('tool.status.closed') : '';
        statusEl.className = `st-status st-phase-${p}`;
        show(intro, !on);
        show(connectRow, !on);
        connectBtn.textContent = p === 'connecting' ? tr('tool.connecting') : tr('tool.connect');
        connectBtn.disabled = p === 'connecting' || support === 'none' || support === 'insecure';
        allPortsBtn.disabled = connectBtn.disabled;
        connLine.textContent = connText();
        // the row also holds the STOP bar (fixed): shown in every connected phase but connecting
        show(connRow, on && p !== 'connecting');
        show(connLine, !!identity);
        show(disconnectBtn, !!identity);
        show(stopBar, on && p !== 'connecting');
        for (const b of stopButtons) if (b !== stopBtn) show(b, on);
        show(factsDet, on && !!identity);
        const usable = on && boardUsable();
        show(liveCard, usable);
        show(settingsCard, usable);
        show(preRead, usable && !board);
        show(formEl, usable && !!board?.level);
        const ready = p === 'ready' && !opBusy;
        readBtn.disabled = !ready;
        checkBtn.disabled = !ready;
        restartBtn.disabled = !ready;
        resetBtn.disabled = !ready;
        testBtn.disabled = !ready;
        updateActions();
        updateStopState();
        applyStopSpace();
        emitBoard();
        root.dataset.phase = p;
        if (p !== lastPhase || key !== lastStatusKey) {
            lastPhase = p;
            lastStatusKey = key;
            if (key && p !== 'reading' && p !== 'writing') say(tr(key));
        }
    };

    const renderFacts = () => {
        banner.replaceChildren();
        if (!identity) {
            facts.replaceChildren();
            show(levelNote, false);
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
        const install = () => h('a', { href: '#install', text: tr('tool.install.link') });
        if (id.verdict === 'not-betaflight') banner.append(h('div', { class: 'st-note st-warn' }, tr('tool.verdict.notbf', { variant: id.variant || '?' }), ' ', install()));
        else if (board && !board.level) banner.append(h('div', { class: 'st-note st-warn' }, tr('tool.verdict.stock'), ' ', install()));
        else if (id.verdict === 'betaflight-other' && !board)
            // no automatic read: reading enters the CLI and would stop a self-built autostart that is running
            banner.append(h('div', { class: 'st-note st-warn' }, h('p', { text: tr('tool.verdict.other') }), h('div', { class: 'st-row' }, checkBtn, install()), h('p', { class: 'st-muted st-small', text: tr('tool.check.note') })));
        if (board?.level === '1.0') {
            levelNote.replaceChildren(tr('tool.level.old'), ' ', h('a', { href: RELEASES, target: '_blank', rel: 'noopener', text: tr('tool.level.link') }));
            show(levelNote, true);
        } else show(levelNote, false);
    };

    const onPhase = () => {
        if (device?.phase === 'ready') {
            identity = device.identity;
            renderFacts();
        }
        renderPhase();
    };

    const resetSession = () => {
        board = null;
        identity = null;
        edited = {};
        extra = {};
        last = null;
        history.length = 0;
        heldBy = null;
        justSaved = false;
        lastMain = undefined;
        autoOpened.clear();
        buildForm();
        setMsg(liveMsg, '');
        setMsg(preMsg, '');
        setMsg(saveMsg, '');
        liveWarn.replaceChildren();
        delete liveWarn.dataset.sig;
    };

    const connect = async (anyPort = false) => {
        clearError();
        closedNote = false;
        if (device) await device.disconnect().catch(() => undefined);
        offs.splice(0).forEach(f => f());
        let serial: SerialLike;
        try {
            if (mock) {
                const m = await import('../fc/mockfc');
                serial = new m.MockSerial(new m.MockFc(m.mockOptionsFromQuery(params)));
            } else serial = await (serialReady ?? browserSerial());
        } catch (e) {
            showError(e, errorBox, true);
            return;
        }
        const timeout = mock && params.has('mockReconnectTimeout') ? Number(params.get('mockReconnectTimeout')) : 20000;
        const dev = new AutostartDevice(new WebSerialTransport(serial), { reconnectTimeoutMs: Number.isFinite(timeout) ? timeout : 20000, log: addLog });
        device = dev;
        offs.push(dev.phaseEvents.on(onPhase), dev.liveEvents.on(onLive));
        resetSession();
        renderPhase();
        try {
            identity = await dev.connect({ anyPort });
            renderFacts();
            renderPhase();
            say(connText());
            // the Connect button is gone: focus the connection line (the next Tab is STOP), unless the
            // visitor already moved on to something else
            const a = document.activeElement;
            if (!a || a === document.body || connectCard.contains(a)) connLine.focus();
        } catch (e) {
            if (device === dev) device = null;
            showError(e, errorBox, true);
        }
        renderPhase();
    };

    const disconnect = async (refocus = false) => {
        const d = device;
        device = null;
        if (d) await d.disconnect().catch(() => undefined);
        offs.splice(0).forEach(f => f());
        resetSession();
        renderFacts();
        closedNote = !!d;
        renderPhase();
        // Disconnect disappeared with the connection line: back to Connect
        if (refocus) focusEl(connectBtn);
    };

    // ---------- motor status ----------
    const savedNum = (name: string): number | null => {
        const v = board?.values[name];
        return typeof v === 'number' ? v : null;
    };

    /** the state in plain words: [main line, sub-line] */
    const stateLine = (s: LiveSample): [string, string] => {
        if (s.misses >= 3) return [tr('tool.live.noAnswer'), ''];
        if (s.state === null) return [tr('tool.state.unknown'), ''];
        const sec = (s.msInState ?? 0) / 1000;
        const delay = savedNum('autostart_delay');
        const ramp = savedNum('autostart_ramp');
        const run = savedNum('autostart_run_time');
        switch (s.state) {
            case 0: {
                if (s.motors.slice(0, 8).some(m => m > 1000)) return [tr('tool.live.manual'), ''];
                if (s.flags?.held) return heldBy === 'settings' ? [tr('tool.live.paused'), tr('tool.live.pausedSub')] : [tr('tool.live.stopped'), tr('tool.live.stoppedSub')];
                const mode = board?.values.autostart_mode;
                if (mode === 'OFF') return [tr('tool.live.off'), tr('tool.live.offSub')];
                if (board?.values.autostart_usb_inhibit === 'ON' && s.flags?.usb) return [tr('tool.live.usbHeld'), tr('tool.live.usbHeldSub')];
                if (mode === 'BUTTON') return [tr('tool.live.waitButton'), ''];
                if (s.flags && !s.flags.battery && savedNum('autostart_vbat_min') !== 0)
                    return [tr('tool.live.waitBattery'), delay !== null ? tr('tool.live.waitBatterySub', { s: fmt(Math.max(delay, MIN_START_S)) }) : ''];
                return [tr('tool.state.0'), ''];
            }
            case 1:
                return [tr('tool.state.1'), delay !== null ? tr('tool.live.countdown', { s: fmt(Math.max(0, Math.ceil(delay - sec))) }) : tr('tool.live.elapsed', { s: fmt(Math.floor(sec)) })];
            case 2:
                return [tr('tool.state.2'), ramp !== null ? tr('tool.live.rampLeft', { s: fmt(Math.max(0, ramp / 10 - sec), 1) }) : tr('tool.live.elapsed', { s: fmt(Math.floor(sec)) })];
            case 3:
                return [tr('tool.state.3'), run ? tr('tool.live.runLeft', { s: fmt(Math.max(0, Math.ceil(run - sec))) }) : ''];
            case 4:
                return [tr('tool.state.4'), tr('tool.live.finishedSub')];
            case 5:
                return [tr('tool.state.5'), tr('tool.live.lowSub')];
            default:
                return [tr('tool.state.unknown'), ''];
        }
    };

    const samplePct = (s: LiveSample | null): number | null => {
        if (!s) return null;
        // the program's command, or the outputs when something else drives them
        if (s.pct === null || (s.state === 0 && s.motors.some(m => m > 1000))) {
            const m = Math.max(1000, ...s.motors.slice(0, 8));
            return s.motors.length ? (m - 1000) / 10 : null;
        }
        return s.pct;
    };

    function updateStopState() {
        const p = device?.phase ?? 'idle';
        let text = '';
        let pctText = '';
        if (p === 'rebooting' || p === 'reconnecting') text = tr(p === 'rebooting' ? 'tool.bar.rebooting' : 'tool.bar.reconnecting');
        else if (p === 'reading' || p === 'writing') text = tr(`tool.status.${p}`);
        else if (last) {
            const pct = samplePct(last);
            text = stateLine(last)[0];
            if (pct !== null) pctText = ` · ${fmt(pct)} %`;
        }
        if (stopText.textContent !== text) stopText.textContent = text;
        if (stopPct.textContent !== pctText) stopPct.textContent = pctText;
    }

    const escVolts = (): number => {
        const s0 = last;
        if (!s0 || s0.bestOutput < 0) return 0;
        const v = s0.esc[s0.bestOutput]?.volts ?? 0;
        return v > 1 ? v : 0;
    };
    /** battery-voltage trouble the live data shows: the board's reading implausible, or the ESC disagrees */
    const calTrouble = () => {
        const v = last?.battery?.volts ?? 0;
        const ev = escVolts();
        const apart = ev > 0 && v >= 1 ? (Math.abs(v - ev) / ev) * 100 : 0;
        return { implausible: !!last?.flags?.implausible && v >= 1, apart, mismatch: apart > ESC_APART_PCT, v, ev };
    };
    /** cell count the firmware uses: the saved one, else Betaflight's guess */
    const usedCells = () => {
        const c = savedNum('autostart_cells');
        return c && c > 0 ? c : last?.battery?.cells ?? 0;
    };

    /** the voltage warnings, with a Calibrate link (shared by Motor status and the Battery question) */
    const calWarnings = (): Kid[] => {
        const c = calTrouble();
        const out: Kid[] = [];
        const calBtn = () => {
            const b = h('button', { type: 'button', class: 'st-linkbtn st-inline' }, tr('tool.warn.calibrate'));
            b.addEventListener('click', () => void openCalibration());
            return b;
        };
        if (c.implausible) {
            // the firmware checks against autostart_cells (Betaflight's guess only when that is 0): unknown before reading
            const saved = savedNum('autostart_cells');
            const n = saved && saved > 0 ? saved : board?.level && saved === 0 ? last?.battery?.cells ?? 0 : 0;
            const text = n ? tr('tool.warn.implausible', { v: fmtFixed(c.v, 2), n, c: fmtFixed(c.v / n, 2) }) : tr('tool.warn.implausibleAny', { v: fmtFixed(c.v, 2) });
            out.push(h('p', { class: 'st-note st-warn' }, text, ' ', calBtn()));
        }
        if (c.mismatch) out.push(h('p', { class: 'st-note st-warn' }, tr('tool.warn.mismatch', { fc: fmtFixed(c.v, 2), esc: fmtFixed(c.ev, 2), d: fmtFixed(c.apart, 1) }), ' ', calBtn()));
        return out;
    };
    const calSig = () => {
        const c = calTrouble();
        return `${c.implausible}|${c.mismatch}|${c.implausible || c.mismatch ? `${c.v.toFixed(1)}|${c.ev.toFixed(1)}|${usedCells()}|${board?.level}` : ''}`;
    };

    const renderLiveWarnings = () => {
        const lvl = board?.level ?? null;
        const cut = savedNum('autostart_cell_cutoff');
        const cells = savedNum('autostart_cells');
        const sig = `${lvl}|${cut}|${cells}|${calSig()}`;
        rebuild(liveWarn, sig, () => {
            const out: Kid[] = [];
            if (lvl === '1.0') out.push(h('p', { class: 'st-note st-bad' }, tr('tool.warn.fw10'), ' ', h('a', { href: RELEASES, target: '_blank', rel: 'noopener', text: tr('tool.level.link') })));
            else if (lvl) {
                if (cut === 0) out.push(h('p', { class: 'st-note st-bad', text: tr('tool.warn.noCut') }));
                if (cells === 0) out.push(h('p', { class: 'st-note st-warn', text: tr('tool.warn.auto') }));
            }
            return [...out, ...calWarnings()];
        });
    };

    const onLive = (s: LiveSample) => {
        last = s;
        const [line, sub] = stateLine(s);
        stateEl.textContent = line;
        stateEl.dataset.state = String(s.state ?? 'x');
        stateSub.textContent = sub;
        if (line !== lastMain) {
            say(line);
            lastMain = line;
        }
        const pct = samplePct(s);
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
        // battery: before the settings are read only Betaflight's own guess of the cell count is known
        const b = s.battery;
        const cells = usedCells();
        if (!b || b.volts < 1) {
            batVal.textContent = '—';
            batSub.textContent = tr('tool.live.noBattery');
            batSub.classList.remove('st-bad-text');
            show(batBar, false);
        } else {
            batVal.textContent = `${fmtFixed(b.volts, 2)} ${tr('tool.unit.V')}`;
            const parts: string[] = [];
            if (cells > 0) parts.push(tr('tool.live.perCell', { v: fmtFixed(b.volts / cells, 2) }));
            const savedCells = savedNum('autostart_cells');
            const cutCv = savedNum('autostart_cell_cutoff');
            let noCut = false;
            let cut: number | null = null;
            if (!board?.level) {
                if (b.cells) parts.push(tr('tool.live.cellsGuess', { n: b.cells }));
                parts.push(tr('tool.live.cutUnknown'));
            } else if (board.level === '1.0' || cutCv === 0) {
                if (cells) parts.push(tr(savedCells ? 'tool.live.cellsN' : 'tool.live.cellsGuess', { n: cells }));
                parts.push(tr('tool.live.noCut'));
                noCut = true;
            } else {
                cut = cutoffVolts(cutCv ?? 0, cells);
                if (cut !== null) parts.push(tr(savedCells ? 'tool.live.cells' : 'tool.live.cellsAuto', { n: cells, v: fmt(cut, 2) }));
            }
            batSub.textContent = parts.join(' · ');
            batSub.classList.toggle('st-bad-text', noCut);
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
        renderLiveWarnings();
        // ESC
        if (s.bestOutput >= 0) {
            const e = s.esc[s.bestOutput];
            rpmVal.textContent = `${fmt(e.rpm)} ${tr('tool.unit.rpm')}`;
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
        const flagSig = s.flags ? (['usb', 'battery', 'rx', 'button', 'gust'] as const).map(k => (s.flags![k] ? 1 : 0)).join('') : '';
        rebuild(chips, flagSig, () => (s.flags ? (['usb', 'battery', 'rx', 'button', 'gust'] as const).map(k => h('li', { class: s.flags![k] ? 'st-on' : '', text: tr(`tool.live.flags.${k}`) })) : []));
        // sparkline
        history.push({ at: s.at, pct: pct ?? 0 });
        while (history.length && history[0].at < s.at - HISTORY_S * 1000) history.shift();
        sparkLine.setAttribute('points', history.map(p => `${(300 - ((s.at - p.at) / (HISTORY_S * 1000)) * 300).toFixed(1)},${(58 - (Math.min(100, p.pct) / 100) * 56).toFixed(1)}`).join(' '));
        // live status needs debug_mode = AUTOSTART
        if (board?.debugMode && board.debugMode !== 'AUTOSTART' && s.state === null) {
            rebuild(debugNote, `${extra.debug_mode ?? ''}`, () => {
                if (extra.debug_mode === 'AUTOSTART') return [tr('tool.live.debugOff'), ' ', h('span', { text: tr('tool.live.debugStaged') })];
                const fix = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.live.debugFix'));
                fix.addEventListener('click', () => {
                    extra.debug_mode = 'AUTOSTART';
                    justSaved = false;
                    refreshForm();
                    if (last) onLive(last);
                });
                return [tr('tool.live.debugOff'), ' ', fix];
            });
            show(debugNote, true);
        } else show(debugNote, false);
        updateStopState();
        calRender();
        renderBatteryQ();
        // calibration needed: the drawer opens itself at the Battery fieldset (once, focus not moved)
        const c = calTrouble();
        if (board?.level && moreFs.battery && (c.implausible || c.mismatch) && !autoOpened.has('cal')) {
            autoOpened.add('cal');
            openAuto(tr('tool.more.cal'));
        }
    };

    // ---------- settings form ----------
    type Syncer = (except?: string) => void;
    let syncers: Syncer[] = [];
    /** where each setting lives in the form (for the change-list links and openMore) */
    const wraps: Record<string, HTMLElement> = {};
    const moreFs: Partial<Record<MoreId, HTMLElement>> = {};
    let calBox: HTMLElement | null = null;
    let calRender: () => void = () => undefined;
    let renderBatteryQ: () => void = () => undefined;

    const clearNotes = () => {
        for (const k of Object.keys(notes)) delete notes[k];
    };
    /** a quick-pick question shows "Other" when its value matches no chip */
    const resetOther = () => {
        for (const [k, chipsOf] of Object.entries(CHIP_VALUES)) otherOn[k] = !chipsOf.includes(Number(edited[k]));
    };

    const setValue = (name: string, v: Value) => {
        edited[name] = v;
        justSaved = false;
        delete notes[name];
        refreshForm();
    };

    /** the parts every field shares: "was …" marker, the note line (text, referenced by aria-describedby), help */
    const fieldShell = (name: string, tag: 'div' | 'fieldset' = 'div') => {
        const id = `${uid}-${name}`;
        const wasEl = h('span', { class: 'st-was', id: `${id}-w` });
        const noteEl = h('p', { class: 'st-fnote', id: `${id}-n` });
        const help = h('p', { class: 'st-help', id: `${id}-h`, text: tr(`tool.f.${name}.help`) });
        const wrap = h(tag, { class: tag === 'fieldset' ? 'st-q' : 'st-field', 'data-name': name });
        wraps[name] = wrap;
        const mark = () => {
            const changed = board!.values[name] !== undefined && !sameValue(board!.values[name], edited[name]);
            wrap.classList.toggle('st-changed', changed);
            wasEl.textContent = changed ? tr('tool.changed.from', { v: showValue(name, board!.values[name]) }) : '';
            noteEl.textContent = notes[name] ?? '';
            wrap.dataset.value = String(edited[name]);
        };
        return { id, wasEl, noteEl, help, wrap, mark };
    };

    /** a number box: clamped on every change, arrow keys step, the special 0 is never typed (it has its own switch) */
    const numInput = (name: string, id: string, attrs: Record<string, string>) => {
        const e = board!.eff[name];
        const nd = e.def as NumDef;
        const dec = unitDecimals(nd.unit);
        const input = h('input', { type: 'text', id, inputmode: dec ? 'decimal' : 'numeric', autocomplete: 'off', class: 'st-num', ...attrs });
        const commit = (finalize: boolean) => {
            const raw = parseNum(input.value);
            const n: Note[] = [];
            let v = Number.isFinite(raw) ? clampValue(e, fromDisplay(nd, raw), n) : clampValue(e, input.value, n);
            if (nd.zero && Number(v) === 0) {
                if (!finalize) return;
                v = clampValue(e, nd.minNonZero ?? Math.max(1, e.min));
                n.splice(0, n.length, { name, kind: 'clamped', from: 0, to: v });
            }
            edited[name] = v;
            justSaved = false;
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
            let v = clampValue(e, fromDisplay(nd, next));
            if (nd.zero && Number(v) === 0) v = clampValue(e, nd.minNonZero ?? Math.max(1, e.min));
            setValue(name, v);
        });
        const sync: Syncer = except => {
            if (except === name && document.activeElement === input) return; // keep what the visitor is typing
            const v = Number(edited[name]);
            input.value = nd.zero && v === 0 ? '' : fmt(toDisplay(nd, v), dec);
        };
        return { input, sync };
    };

    /** the confirm before a dangerous zero (no cut-off, automatic cell count) */
    const confirmZero = async (name: string, opener: HTMLElement) => {
        const k = name === 'autostart_cell_cutoff' ? 'nocut' : 'auto';
        const ok = await ask({ title: tr(`tool.confirm.${k}.title`), body: tr(`tool.confirm.${k}.body`), ok: tr(`tool.confirm.${k}.ok`), opener });
        if (ok) setValue(name, 0);
    };

    /** one field of the drawer */
    const buildField = (d: SettingDef): HTMLElement => {
        const name = d.name;
        const e = board!.eff[name];
        const { id, wasEl, noteEl, help, wrap, mark } = fieldShell(name);
        const desc = `${id}-h ${id}-n`;
        let sync: Syncer = () => undefined;

        if (d.kind === 'enum') {
            const group = h('div', { class: 'st-seg', role: 'radiogroup', 'aria-labelledby': `${id}-l`, 'aria-describedby': desc });
            const radios: HTMLInputElement[] = [];
            for (const val of e.values) {
                const r = h('input', { type: 'radio', name: id, value: val, id: `${id}-${val}` });
                r.addEventListener('change', () => r.checked && setValue(name, val));
                radios.push(r);
                group.append(h('label', { for: `${id}-${val}`, class: 'st-seg-opt' }, r, h('span', { text: optLabel(name, val) })));
            }
            wrap.append(h('span', { class: 'st-flabel', id: `${id}-l` }, h('span', { text: labelOf(name) }), wasEl), group, help);
            sync = () => radios.forEach(r => (r.checked = sameValue(r.value, edited[name])));
        } else if (d.kind === 'choice') {
            const sel = h('select', { id, 'aria-describedby': desc });
            for (const c of d.choices) sel.append(h('option', { value: c, text: showValue(name, c) }));
            sel.addEventListener('change', () => setValue(name, Number(sel.value)));
            wrap.append(h('label', { for: id, class: 'st-flabel' }, h('span', { text: labelOf(name) }), wasEl), sel, help);
            sync = () => (sel.value = String(edited[name]));
        } else if (d.kind === 'mask') {
            const motorCount = Math.max(4, last?.esc.length ?? 0, Number(board!.values[name]) & 0xf0 ? 8 : 0);
            const boxes: HTMLInputElement[] = [];
            const row = h('div', { class: 'st-mask', role: 'group', 'aria-labelledby': `${id}-l`, 'aria-describedby': desc });
            for (let i = 0; i < Math.min(8, motorCount); i++) {
                const c = h('input', { type: 'checkbox', id: `${id}-${i}` });
                c.addEventListener('change', () => {
                    const m = boxes.reduce((acc, b, j) => (b.checked ? acc | (1 << j) : acc), Number(edited[name]) & ~((1 << boxes.length) - 1));
                    const n: Note[] = [];
                    edited[name] = clampValue(e, m, n);
                    justSaved = false;
                    if (n.length) notes[name] = noteText(n[0]);
                    else delete notes[name];
                    refreshForm();
                });
                boxes.push(c);
                row.append(h('label', { class: 'st-check st-check-inline', for: `${id}-${i}` }, c, h('span', { text: tr('tool.motor', { n: i + 1 }) })));
            }
            const m1 = h('p', { class: 'st-fnote st-warn', hidden: true, text: tr('tool.note.motor1') });
            wrap.append(h('span', { class: 'st-flabel', id: `${id}-l` }, h('span', { text: labelOf(name) }), wasEl), row, help, m1);
            sync = () => {
                boxes.forEach((b, i) => (b.checked = ((Number(edited[name]) >> i) & 1) === 1));
                show(m1, (Number(edited[name]) & 1) === 0);
            };
        } else {
            const nd = d;
            // the name carries the unit (the visible unit is a symbol); "was …" is part of the description
            const num = numInput(name, id, { 'aria-label': nameWithUnit(name, nd), 'aria-describedby': `${id}-w ${desc}` });
            let range: HTMLInputElement | null = null;
            if (nd.unit === 'pct') {
                range = h('input', { type: 'range', min: e.min, max: e.max, step: 1, 'aria-label': nameWithUnit(name, nd), class: 'st-range' });
                range.addEventListener('input', () => setValue(name, Number(range!.value)));
            }
            const inrow = h('div', { class: 'st-inrow' }, num.input, h('span', { class: 'st-unit', text: unitLabel(nd) }), range);
            wrap.append(h('label', { for: id, class: 'st-flabel' }, h('span', { text: labelOf(name) }), wasEl), inrow);
            let zeroBox: HTMLInputElement | null = null;
            const lastNonZero = { v: Number(board!.values[name]) || NONZERO_FALLBACK[name] || e.min };
            if (nd.zero) {
                zeroBox = h('input', { type: 'checkbox', id: `${id}-z` });
                const zb = zeroBox;
                zb.addEventListener('change', () => {
                    if (zb.checked) {
                        if (Number(edited[name]) !== 0) lastNonZero.v = Number(edited[name]);
                        if (name === 'autostart_cell_cutoff') {
                            zb.checked = false; // only the confirm turns the battery protection off
                            void confirmZero(name, zb);
                        } else setValue(name, 0);
                    } else setValue(name, clampValue(e, lastNonZero.v));
                });
                wrap.append(h('label', { class: 'st-check', for: `${id}-z` }, zb, h('span', { text: tr(`tool.box.${name}`) })));
            }
            const total = h('p', { class: 'st-help st-total' });
            wrap.append(help);
            if (name === 'autostart_cell_cutoff') wrap.append(total);
            sync = except => {
                num.sync(except);
                const v = Number(edited[name]);
                const isZero = !!zeroBox && v === 0;
                show(inrow, !isZero); // never an empty disabled box
                if (zeroBox) zeroBox.checked = isZero;
                if (range) range.value = String(v);
                if (name === 'autostart_cell_cutoff') {
                    const cells = Number(edited.autostart_cells) || last?.battery?.cells || 0;
                    const tv = cutoffVolts(v, cells);
                    total.textContent = tv !== null ? tr('tool.cutoff.total', { v: fmt(tv, 2), n: cells }) : '';
                }
            };
        }
        // a setting that does nothing with the current values says so in full contrast (not by fading the help)
        const dimKey = `tool.dim.${name}`;
        const dimNote = tr(dimKey) !== dimKey ? h('p', { class: 'st-fnote st-dimnote', hidden: true, text: tr(dimKey) }) : null;
        wrap.append(noteEl);
        if (dimNote) wrap.append(dimNote);
        syncers.push(except => {
            sync(except);
            mark();
            const dim = !isRelevant(name, edited);
            wrap.classList.toggle('st-dim', dim);
            if (dimNote) show(dimNote, dim);
        });
        return wrap;
    };

    /** Battery fieldset: "Count cells automatically" (the number itself is the Battery question) */
    const buildCellsAuto = (): HTMLElement => {
        const name = 'autostart_cells';
        const id = `${uid}-cells-auto`;
        const box = h('input', { type: 'checkbox', id, 'aria-describedby': `${id}-h` });
        const lastCells = { v: Number(board!.values[name]) || NONZERO_FALLBACK[name] };
        box.addEventListener('change', () => {
            if (box.checked) {
                box.checked = false;
                if (Number(edited[name]) > 0) lastCells.v = Number(edited[name]);
                void confirmZero(name, box);
            } else {
                otherOn[name] = !CHIP_VALUES[name].includes(lastCells.v);
                setValue(name, lastCells.v);
            }
        });
        const wrap = h(
            'div',
            { class: 'st-field st-field-auto' },
            h('label', { class: 'st-check', for: id }, box, h('span', { text: tr(`tool.box.${name}`) })),
            h('p', { class: 'st-help', id: `${id}-h`, text: tr('tool.cells.autoHelp') })
        );
        syncers.push(() => {
            box.checked = Number(edited[name]) === 0;
            wrap.classList.toggle('st-changed', board!.values[name] !== undefined && !sameValue(board!.values[name], edited[name]) && (Number(edited[name]) === 0 || Number(board!.values[name]) === 0));
        });
        return wrap;
    };

    /** per question: point aria-describedby at the lines under it that are shown now (protection, fit check, cap) */
    const describe: Record<string, () => void> = {};

    /** a quick-pick question: chips + "Other" with a same-row number box (real radios in a fieldset) */
    const chipQuestion = (name: string, chipText: (v: number) => string, after: HTMLElement[] = []): HTMLElement => {
        const e = board!.eff[name];
        const nd = e.def as NumDef;
        const { id, wasEl, noteEl, help, wrap, mark } = fieldShell(name, 'fieldset');
        const row = h('div', { class: 'st-chiprow' });
        const radios: HTMLInputElement[] = [];
        const chipVals = (CHIP_VALUES[name] ?? []).filter(c => c >= e.min && c <= e.max);
        for (const c of chipVals) {
            const r = h('input', { type: 'radio', name: id, value: String(c), id: `${id}-${c}`, 'aria-describedby': help.id });
            r.addEventListener('change', () => {
                if (!r.checked) return;
                otherOn[name] = false;
                setValue(name, c);
            });
            radios.push(r);
            row.append(h('label', { class: 'st-chip', for: r.id }, r, h('span', { text: chipText(c) })));
        }
        const otherR = h('input', { type: 'radio', name: id, value: 'other', id: `${id}-o`, 'aria-describedby': help.id });
        const otherLabel = h('label', { class: 'st-chip', for: otherR.id }, otherR, h('span', { text: tr('tool.other') }));
        const num = numInput(name, `${id}-in`, { 'aria-label': nameWithUnit(name, nd), 'aria-describedby': `${help.id} ${noteEl.id}` });
        const otherWrap = h('span', { class: 'st-other', hidden: true }, num.input, h('span', { class: 'st-unit', text: unitLabel(nd) }));
        row.append(otherLabel, otherWrap);
        // a click on "Other" puts the cursor in the box with the value selected: typing replaces it
        // (typing after it turned 15 + "22" into 1522 → 100 % Power); arrow keys keep moving between the chips
        let byPointer = false;
        otherLabel.addEventListener('pointerdown', () => (byPointer = true));
        otherR.addEventListener('change', () => {
            if (!otherR.checked) return;
            otherOn[name] = true;
            refreshForm();
            if (byPointer) {
                num.input.focus();
                num.input.select();
            }
            byPointer = false;
        });
        // a hidden element referenced by aria-describedby is still read: only the lines shown now are named
        after.forEach((el, i) => {
            if (!el.id) el.id = `${id}-a${i}`;
        });
        describe[name] = () => {
            const lines = after.filter(el => !el.hidden && (el.textContent ?? '').trim()).map(el => el.id);
            const forRadios = [help.id, ...lines].join(' ');
            const forBox = [help.id, noteEl.id, ...lines].join(' ');
            for (const r of [...radios, otherR]) if (r.getAttribute('aria-describedby') !== forRadios) r.setAttribute('aria-describedby', forRadios);
            if (num.input.getAttribute('aria-describedby') !== forBox) num.input.setAttribute('aria-describedby', forBox);
        };
        wrap.append(h('legend', { class: 'st-qlabel' }, h('span', { text: labelOf(name) }), wasEl), row, help, ...after, noteEl);
        syncers.push(except => {
            const v = Number(edited[name]);
            const auto = !!nd.zero && v === 0;
            const chipHit = !otherOn[name] && chipVals.includes(v);
            radios.forEach(r => (r.checked = chipHit && r.value === String(v)));
            otherR.checked = otherOn[name] || (!auto && !chipHit);
            show(otherWrap, otherR.checked);
            num.sync(except);
            mark();
            describe[name]();
        });
        return wrap;
    };

    /** How long: until the battery is low (0) or for a set time (minutes + seconds) */
    const runQuestion = (): HTMLElement => {
        const name = 'autostart_run_time';
        const e = board!.eff[name];
        const { id, wasEl, noteEl, help, wrap, mark } = fieldShell(name, 'fieldset');
        const lowR = h('input', { type: 'radio', name: id, value: '0', id: `${id}-low`, 'aria-describedby': help.id });
        const timedR = h('input', { type: 'radio', name: id, value: 'timed', id: `${id}-t`, 'aria-describedby': help.id });
        const lowText = h('span');
        const timedLabel = h('label', { class: 'st-chip', for: timedR.id }, timedR, h('span', { text: tr('tool.run.timed') }));
        const attrs = (unit: string) => ({ type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'st-num st-num-s', 'aria-label': `${labelOf(name)}, ${unit}`, 'aria-describedby': `${help.id} ${noteEl.id}` });
        const minIn = h('input', attrs(tr('tool.unitName.min')));
        const secIn = h('input', attrs(tr('tool.unitName.s')));
        const timedWrap = h('span', { class: 'st-other st-minsec', hidden: true }, minIn, h('span', { class: 'st-unit', text: tr('tool.unit.min') }), secIn, h('span', { class: 'st-unit', text: tr('tool.unit.s') }));
        if (Number(board!.values[name]) > 0) lastTimed = Number(board!.values[name]);
        lowR.addEventListener('change', () => {
            if (!lowR.checked) return;
            if (Number(edited[name]) > 0) lastTimed = Number(edited[name]);
            setValue(name, 0);
        });
        let byPointer = false;
        timedLabel.addEventListener('pointerdown', () => (byPointer = true));
        timedR.addEventListener('change', () => {
            if (!timedR.checked) return;
            setValue(name, clampValue(e, lastTimed));
            // selected: typing "2" means 2 min, not "1" + "2" = 12 min
            if (byPointer) {
                minIn.focus();
                minIn.select();
            }
            byPointer = false;
        });
        const commit = (finalize: boolean) => {
            const s = parseNum(secIn.value);
            const total = Number(clampValue(e, joinMinSec(parseNum(minIn.value), s)));
            edited[name] = total;
            lastTimed = total;
            justSaved = false;
            if (finalize && Number.isFinite(s) && (s > 59 || s < 0)) notes[name] = tr('tool.note.sec');
            else delete notes[name];
            refreshForm(finalize ? undefined : name);
        };
        for (const inp of [minIn, secIn]) {
            inp.addEventListener('input', () => commit(false));
            inp.addEventListener('change', () => commit(true));
            // arrows: ±1 min in the minutes box, ±1 s in the seconds box (carries over), Shift ×10
            inp.addEventListener('keydown', ev => {
                if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
                ev.preventDefault();
                const step = (inp === minIn ? 60 : 1) * (ev.shiftKey ? 10 : 1) * (ev.key === 'ArrowUp' ? 1 : -1);
                const cur = Number(edited[name]) > 0 ? Number(edited[name]) : lastTimed;
                const v = Math.min(65535, Math.max(1, cur + step));
                lastTimed = v;
                setValue(name, v);
            });
        }
        wrap.append(
            h('legend', { class: 'st-qlabel' }, h('span', { text: labelOf(name) }), wasEl),
            h('div', { class: 'st-chiprow' }, h('label', { class: 'st-chip', for: lowR.id }, lowR, lowText), timedLabel, timedWrap),
            help,
            noteEl
        );
        syncers.push(except => {
            const v = Number(edited[name]);
            lowR.checked = v === 0;
            timedR.checked = v > 0;
            show(timedWrap, v > 0);
            // with no cut-off "until the battery is low" is not true any more
            lowText.textContent = Number(edited.autostart_cell_cutoff) === 0 ? tr('tool.run.power') : tr('tool.run.low');
            const typing = except === name && (document.activeElement === minIn || document.activeElement === secIn);
            if (!typing) {
                const { min, sec } = splitMinSec(v);
                minIn.value = fmt(min);
                secIn.value = fmt(sec);
            }
            mark();
        });
        return wrap;
    };

    /** Random gusts: Off / On — changes autostart_pattern and nothing else */
    const gustsQuestion = (): HTMLElement => {
        const name = 'autostart_pattern';
        const e = board!.eff[name];
        const { id, wasEl, noteEl, help, wrap, mark } = fieldShell(name, 'fieldset');
        const radios: HTMLInputElement[] = [];
        const row = h('div', { class: 'st-chiprow' });
        for (const val of e.values) {
            const r = h('input', { type: 'radio', name: id, value: val, id: `${id}-${val}`, 'aria-describedby': help.id });
            r.addEventListener('change', () => r.checked && setValue(name, val));
            radios.push(r);
            row.append(h('label', { class: 'st-chip', for: r.id }, r, h('span', { text: optLabel(name, val) })));
        }
        const details = h('button', { type: 'button', class: 'st-linkbtn st-inline' }, tr('tool.gusts.link'));
        details.addEventListener('click', () => openMore('gusts'));
        const tip = h('p', { class: 'st-help', hidden: true }, tr('tool.gusts.tip'), ' ', details);
        wrap.append(h('legend', { class: 'st-qlabel' }, h('span', { text: labelOf(name) }), wasEl), row, help, tip, noteEl);
        syncers.push(() => {
            radios.forEach(r => (r.checked = sameValue(r.value, edited[name])));
            show(tip, sameValue(edited[name], 'GUSTS'));
            mark();
        });
        return wrap;
    };

    /** Battery: the cell count, then the protection line and the check against the live voltage */
    const cellsQuestion = (): HTMLElement => {
        const qAuto = h('p', { class: 'st-qline st-tone-warn', hidden: true, text: tr('tool.prot.auto') });
        const qProt = h('p', { class: 'st-qline' });
        const qFit = h('p', { class: 'st-qline' });
        const qCal = h('div', { class: 'st-qcal' });
        const fs = chipQuestion('autostart_cells', n => tr('tool.chip.cells', { n: fmt(n) }), [qAuto, qProt, qFit, qCal]);
        /** the cell count a "doesn't fit" was said for (once per count; a voltage near the edge does not repeat it) */
        let fitSaidFor: number | null = null;
        let fitCells: number | null = null;
        renderBatteryQ = () => {
            if (!board?.level || !board.eff.autostart_cells?.present) return;
            const cells = Number(edited.autostart_cells);
            const cutCv = Number(edited.autostart_cell_cutoff);
            const tm = Number(edited.autostart_cutoff_time);
            show(qAuto, cells === 0);
            let prot: string;
            let tone: string;
            if (cutCv === 0) [prot, tone] = [tr('tool.prot.off'), 'bad'];
            else if (cells > 0) [prot, tone] = [tr('tool.prot.on', { v: fmt((cells * cutCv) / 100, 2), n: cells, c: fmtFixed(cutCv / 100, 2), t: fmt(tm) }), 'ok'];
            else [prot, tone] = [tr('tool.prot.onAuto', { c: fmtFixed(cutCv / 100, 2), t: fmt(tm) }), 'warn'];
            if (qProt.textContent !== prot) qProt.textContent = prot;
            qProt.className = `st-qline st-tone-${tone}`;
            const v = last?.battery?.volts ?? 0;
            const f = cellFit(v, cells);
            rebuild(qFit, f ? `${f.fits}|${f.guess}|${v.toFixed(1)}|${cells}` : '', () => {
                if (!f) return [];
                if (f.fits) return [tr('tool.fit.ok', { v: fmtFixed(v, 1), n: cells })];
                const out: Kid[] = [tr('tool.fit.bad', { v: fmtFixed(v, 1), n: cells })];
                if (f.guess) {
                    const use = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.fit.use', { g: f.guess }));
                    const g = f.guess;
                    use.addEventListener('click', () => {
                        otherOn.autostart_cells = !CHIP_VALUES.autostart_cells.includes(g);
                        setValue('autostart_cells', g);
                    });
                    out.push(' ', tr('tool.fit.guess', { g }), ' ', use);
                }
                return out;
            });
            qFit.className = `st-qline${f && !f.fits ? ' st-tone-warn' : ''}`;
            show(qFit, !!f);
            rebuild(qCal, calSig(), calWarnings);
            // a wrong cell count picked by keyboard is not silent: "Doesn't fit 4S. Is it 6S?" once
            if (fitCells !== cells) {
                fitCells = cells;
                fitSaidFor = null;
            }
            if (f && !f.fits && fitSaidFor !== cells) {
                fitSaidFor = cells;
                say(`${tr('tool.fit.bad', { v: fmtFixed(v, 1), n: cells })}${f.guess ? ` ${tr('tool.fit.guess', { g: f.guess })}` : ''}`, true);
            }
            describe.autostart_cells?.();
        };
        return fs;
    };

    const buildCalibration = (): HTMLElement => {
        const id = `${uid}-cal`;
        const shown = h('p', { class: 'st-help' });
        const input = h('input', { type: 'text', id, inputmode: 'decimal', autocomplete: 'off', class: 'st-num', 'aria-label': `${tr('tool.cal.input')}, ${tr('tool.unitName.V')}` });
        const apply = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.cal.apply'));
        const msg = h('p', { class: 'st-fnote' });
        // the ESC measures the pack too: one click calibrates without a multimeter
        const escHint = h('p', { class: 'st-help' });
        const escApply = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.cal.escApply', { v: '—' }));
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
            const s = v >= 1 ? tr('tool.cal.shown', { v: fmtFixed(v, 2) }) : tr('tool.cal.noReading');
            if (shown.textContent !== s) shown.textContent = s;
            apply.disabled = v < 1 || device?.phase !== 'ready';
            const ev = escVolts();
            if (ev > 0 && v >= 1) {
                const apart = (Math.abs(v - ev) / ev) * 100;
                escHint.textContent = tr('tool.cal.escHint', { esc: fmtFixed(ev, 2), fc: fmtFixed(v, 2), d: fmtFixed(apart, 1) });
                escHint.className = apart > ESC_APART_PCT ? 'st-help st-warn' : 'st-help';
                escApply.textContent = tr('tool.cal.escApply', { v: fmtFixed(ev, 2) });
                escApply.disabled = device?.phase !== 'ready';
                show(escApply, true);
            } else {
                escHint.textContent = tr('tool.cal.escNone');
                escHint.className = 'st-help';
                show(escApply, false);
            }
        };
        const go = () => {
            const shownV = last?.battery?.volts ?? 0;
            const old = Number(board?.values.vbat_scale ?? 0);
            const r = calibrateVbatScale(old, parseNum(input.value), shownV);
            if (!r.ok) {
                msg.textContent = r.reason === 'no-reading' ? tr('tool.cal.noReading') : tr('tool.cal.badInput');
                msg.className = 'st-fnote st-warn';
                say(msg.textContent);
                return;
            }
            setValue('vbat_scale', r.scale);
            msg.textContent = tr('tool.cal.result', { new: r.scale, old }) + (r.clamped ? ` ${tr('tool.cal.clamped')}` : '');
            msg.className = 'st-fnote st-ok';
            say(msg.textContent);
        };
        escApply.addEventListener('click', () => {
            const ev = escVolts();
            if (ev > 0) {
                input.value = fmtFixed(ev, 2);
                go();
            }
        });
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

    /** a fieldset legend says what it holds in plain words, also when it is at the default */
    const legendValue = (id: MoreId): string => {
        const n = (k: string) => Number(edited[k]);
        const has = (k: string) => !!board?.eff[k]?.present;
        switch (id) {
            case 'start': {
                const vars = { mode: optLabel('autostart_mode', edited.autostart_mode), ramp: fmt(n('autostart_ramp') / 10, 1), limit: fmt(n('autostart_throttle_limit')) };
                return tr(has('autostart_throttle_limit') ? 'tool.legend.start' : 'tool.legend.start10', vars);
            }
            case 'gusts': {
                if (!sameValue(edited.autostart_pattern, 'GUSTS')) return tr('tool.legend.gustsOff');
                const range = (a: string, b: string, div: number, dec: number) => `${fmt(Math.min(n(a), n(b)) / div, dec)}–${fmt(Math.max(n(a), n(b)) / div, dec)}`;
                return tr('tool.legend.gusts', {
                    pct: range('autostart_gust_min', 'autostart_gust_max', 1, 0),
                    len: range('autostart_gust_len_min', 'autostart_gust_len_max', 1000, 2),
                    pause: range('autostart_gust_pause_min', 'autostart_gust_pause_max', 10, 1)
                });
            }
            case 'battery': {
                if (!has('autostart_cell_cutoff')) return tr('tool.legend.battery10'); // firmware 1.0: the calibration only
                const base = n('autostart_cell_cutoff') === 0 ? tr('tool.legend.batteryOff') : tr('tool.legend.battery', { cut: fmtFixed(n('autostart_cell_cutoff') / 100, 2), t: fmt(n('autostart_cutoff_time')) });
                return n('autostart_cells') === 0 ? `${base} · ${tr('tool.legend.cellsAuto')}` : base;
            }
            case 'outputs': {
                // the option label sits mid-sentence here: "… · with USB: motor may spin"
                const usb = optLabel('autostart_usb_inhibit', edited.autostart_usb_inhibit);
                return tr('tool.legend.outputs', { list: maskList(edited.autostart_motors), usb: usb.charAt(0).toLocaleLowerCase(tag) + usb.slice(1) });
            }
            case 'expert': {
                const vars = { v: fmt(n('autostart_vbat_min') / 10, 1), box: showValue('autostart_box', edited.autostart_box), scale: String(edited.vbat_scale ?? '—') };
                return tr(n('autostart_vbat_min') === 0 ? 'tool.legend.expertNoWait' : 'tool.legend.expert', vars);
            }
        }
    };

    const buildMore = () => {
        moreDet.replaceChildren(moreSummary);
        for (const id of MORE_IDS) {
            const keys = MORE[id].filter(k => board!.eff[k]?.present);
            const cellsAuto = id === 'battery' && !!board!.eff.autostart_cells?.present;
            // the calibration helper lives in Battery: on firmware 1.0 (no battery stop) the fieldset holds only it
            const cal = id === 'battery' && !!board!.eff.vbat_scale?.present;
            if (!keys.length && !cellsAuto && !cal) continue; // firmware 1.0: what it lacks is not drawn
            const legVal = h('span', { class: 'st-legval' });
            const fs = h('fieldset', { class: `st-group st-g-${id}`, 'data-more': id, id: `tool-more-${id}` }, h('legend', {}, h('span', { text: tr(`tool.fs.${id}`) }), legVal));
            moreFs[id] = fs;
            const grid = h('div', { class: 'st-grid' });
            for (const k of keys) {
                grid.append(buildField(DEF[k]));
                if (k === 'autostart_cell_cutoff' && cellsAuto) grid.append(buildCellsAuto());
            }
            if (cellsAuto && !keys.includes('autostart_cell_cutoff')) grid.append(buildCellsAuto());
            if (id === 'gusts') {
                const off = h('p', { class: 'st-help st-gusts-off', text: tr('tool.gusts.off') });
                const mix = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.mix.apply'));
                mix.addEventListener('click', () => {
                    // the 6 gust settings only: never Power, Maximum power or How long
                    const vals = gustMix(board!.eff);
                    if (!vals) return;
                    Object.assign(edited, vals);
                    for (const k of Object.keys(vals)) delete notes[k];
                    justSaved = false;
                    refreshForm();
                    say(tr('tool.mix.done'));
                });
                const power = h('button', { type: 'button', class: 'st-linkbtn st-inline' }, tr('tool.mix.power', { v: SUGGESTED_GUST_POWER }));
                power.addEventListener('click', () => {
                    otherOn.autostart_throttle = !CHIP_VALUES.autostart_throttle.includes(SUGGESTED_GUST_POWER);
                    setValue('autostart_throttle', SUGGESTED_GUST_POWER);
                    say(itemText('autostart_throttle'));
                });
                const mixRow = h('div', { class: 'st-mix' }, h('div', { class: 'st-row' }, mix), h('p', { class: 'st-help' }, tr('tool.mix.help'), ' ', power));
                fs.append(off, grid, mixRow);
                syncers.push(() => {
                    const on = sameValue(edited.autostart_pattern, 'GUSTS');
                    show(off, !on);
                    show(grid, on);
                    show(mixRow, on);
                });
            } else if (keys.length || cellsAuto) fs.append(grid);
            else if (id === 'battery') fs.append(h('p', { class: 'st-help st-fw10', text: tr('tool.battery.fw10') }));
            if (cal) fs.append((calBox = buildCalibration()));
            syncers.push(() => {
                const t = ` · ${legendValue(id)}`;
                if (legVal.textContent !== t) legVal.textContent = t;
            });
            moreDet.append(fs);
        }
        moreDet.append(h('div', { class: 'st-row' }, resetBtn));
    };

    let autoOpening = false;
    moreDet.addEventListener('toggle', () => {
        if (!autoOpening) store.set(MORE_STORE, moreDet.open ? '1' : '0');
        autoOpening = false;
    });
    /** opened by the tool itself: one polite announcement, focus stays where it is */
    const openAuto = (reason: string) => {
        if (moreDet.open) return;
        autoOpening = true;
        moreDet.open = true;
        say(tr('tool.more.opened', { list: reason }), true);
    };
    /** open the drawer at a fieldset (or a field), scroll it above the STOP bar and put the focus there */
    const openMore = (fs: MoreId | null, target?: HTMLElement | null) => {
        if (fs && !moreDet.open) moreDet.open = true;
        const el = target ?? (fs ? moreFs[fs] ?? null : null);
        if (!el) return;
        el.scrollIntoView({ block: 'start' });
        const ctl =
            el.querySelector<HTMLElement>('input[type=radio]:checked') ??
            Array.from(el.querySelectorAll<HTMLElement>('input, select, button')).find(x => x.getClientRects().length > 0 && !(x as HTMLButtonElement).disabled) ??
            null;
        ctl?.focus({ preventScroll: true });
    };
    /** where a setting is: a simple question, or its drawer fieldset */
    const openAt = (name: string) => {
        if (name === 'vbat_scale' && calBox) return openMore('battery', calBox);
        const fs = moreOf(name);
        openMore(fs, wraps[name] ?? null);
    };
    /** Calibrate links: open the settings first if needed (that is a read: the motor stops) */
    const openCalibration = async () => {
        if (!board) {
            await run(readNow, preMsg);
            if (!board) return;
        }
        calRender(); // the buttons were disabled while the settings were read
        if (calBox) openMore('battery', calBox);
        else openAt('vbat_scale'); // no helper drawn: at least the Voltage scale field
    };

    const refreshProgram = () => {
        if (!board?.level) return;
        const pending = Object.keys(pendingChanges()).length > 0;
        const title = tr(pending ? 'tool.prog.titleEdited' : 'tool.prog.title');
        if (progTitle.textContent !== title) progTitle.textContent = title;
        const lines = describeProgram(normalize(board.eff, edited).values, board.level);
        rebuild(progBody, lines.map(l => `${l.key}:${JSON.stringify(l.vars)}`).join('|'), () => [programList(lines)]);
    };

    const refreshMore = () => {
        if (!board?.level) return;
        const att = attention(edited, board.eff);
        const cap = capOf(edited, board.eff);
        const diffs = hiddenDiffs(edited, board.eff);
        const inside = Object.keys(pendingChanges()).filter(k => moreOf(k) !== null).length;
        const sig = `${att.map(k => `${k}=${edited[k]}`).join(',')}|${cap}|${diffs.map(k => `${k}=${edited[k]}`).join(',')}|${inside}`;
        rebuild(moreInfo, sig, () => [
            att.length ? h('span', { class: 'st-badge st-badge-warn', text: tr('tool.more.attention', { list: fullList(att) }) }) : null,
            cap !== null ? h('span', { class: 'st-badge', text: tr('tool.more.cap', { v: fmt(cap) }) }) : null,
            diffs.length ? h('span', { class: 'st-more-line', text: tr('tool.more.diff', { list: fullList(diffs) }) }) : null,
            inside ? h('span', { class: 'st-more-line', text: tr('tool.more.pending', { n: inside }) }) : null
        ]);
        // safety-relevant values open the drawer by themselves (never closed by the tool)
        const fresh = att.filter(k => !autoOpened.has(k));
        if (fresh.length) {
            fresh.forEach(k => autoOpened.add(k));
            openAuto(fullList(fresh));
        }
    };

    function refreshForm(except?: string) {
        if (!board?.level) return;
        for (const s of syncers) s(except);
        refreshProgram();
        renderBatteryQ();
        refreshMore();
        updateActions();
    }

    function buildForm() {
        syncers = [];
        for (const k of Object.keys(wraps)) delete wraps[k];
        for (const k of Object.keys(moreFs)) delete moreFs[k as MoreId];
        calBox = null;
        calRender = () => undefined;
        renderBatteryQ = () => undefined;
        formEl.replaceChildren();
        if (!board?.level) return;
        if (moreDet.dataset.init !== '1') {
            moreDet.dataset.init = '1';
            moreDet.open = store.get(MORE_STORE) === '1';
        }
        const qs = h('div', { class: 'st-qs' });
        const builders: Record<string, () => HTMLElement> = {
            autostart_delay: () => chipQuestion('autostart_delay', v => `${fmt(v)} ${tr('tool.unit.s')}`),
            autostart_throttle: () => {
                const capNote = h('p', { class: 'st-qline st-tone-warn', hidden: true });
                let first = true;
                syncers.push(() => {
                    const lim = Number(edited.autostart_throttle_limit);
                    const on = !!board!.eff.autostart_throttle_limit?.present && Number(edited.autostart_throttle) > lim;
                    const text = on ? tr('tool.note.capped', { v: fmt(lim) }) : '';
                    // said once when a change makes it appear (the program box names the cap after a read)
                    if (on && capNote.hidden && !first) say(text, true);
                    first = false;
                    show(capNote, on);
                    capNote.textContent = text;
                });
                return chipQuestion('autostart_throttle', v => `${fmt(v)} %`, [capNote]);
            },
            autostart_run_time: runQuestion,
            autostart_pattern: gustsQuestion,
            autostart_cells: cellsQuestion
        };
        for (const k of SIMPLE) if (board.eff[k]?.present) qs.append(builders[k]());
        buildMore();
        // "Capped at N %" also under Strongest gust
        const gMax = wraps.autostart_gust_max;
        if (gMax && board.eff.autostart_throttle_limit?.present) {
            const capNote = h('p', { class: 'st-fnote st-warn', hidden: true, id: `${uid}-gcap` });
            gMax.append(capNote);
            const box = gMax.querySelector<HTMLInputElement>('input.st-num');
            if (box) box.setAttribute('aria-describedby', `${box.getAttribute('aria-describedby') ?? ''} ${capNote.id}`.trim());
            let first = true;
            syncers.push(() => {
                const lim = Number(edited.autostart_throttle_limit);
                const on = Math.max(Number(edited.autostart_gust_max), Number(edited.autostart_gust_min)) > lim;
                const text = on ? tr('tool.note.capped', { v: fmt(lim) }) : '';
                if (on && capNote.hidden && !first) say(text, true);
                first = false;
                show(capNote, on);
                // empty while hidden: a hidden element named by aria-describedby is still read
                capNote.textContent = text;
            });
        }
        formEl.append(programBox, qs, moreDet, actions);
        refreshForm();
    }

    const pendingChanges = (): Record<string, Value> => {
        if (!board) return {};
        const { values } = normalize(board.eff, edited);
        const out = diff(board.values, values);
        for (const [k, v] of Object.entries(extra)) if (board.debugMode !== null && String(v) !== board.debugMode) out[k] = v;
        return out;
    };

    const changeItem = (k: string, v: Value): HTMLElement => {
        if (k === 'debug_mode') return h('span', { text: tr('tool.change.debug') });
        const b = h('button', { type: 'button', class: 'st-linkbtn st-inline', 'data-change': k }, tr('tool.change.item', { name: labelOf(k), from: showValue(k, board!.values[k]), to: showValue(k, v) }));
        b.addEventListener('click', () => openAt(k));
        return b;
    };

    function updateActions() {
        if (!board?.level) return;
        const ch = pendingChanges();
        const names = Object.keys(ch);
        const ready = device?.phase === 'ready' && !opBusy;
        saveBtn.disabled = !ready || names.length === 0;
        undoBtn.disabled = !ready || names.length === 0;
        reloadBtn.disabled = !ready || names.length > 0;
        show(reloadHint, names.length > 0);
        rebuild(changesEl, `${names.map(k => `${k}=${ch[k]}`).join('|')}|${justSaved}`, () => {
            if (names.length) {
                const items: Kid[] = [];
                names.slice(0, 3).forEach((k, i) => items.push(i ? ' · ' : '', changeItem(k, ch[k])));
                return [h('strong', { text: tr('tool.changes') }), ' ', ...items, names.length > 3 ? ` ${tr('tool.list.more', { n: names.length - 3 })}` : ''];
            }
            if (justSaved) return [];
            return [tr('tool.nochanges.ready'), ' ', testBtn];
        });
    }

    // ---------- dialogs ----------
    let cfDone: ((ok: boolean) => void) | null = null;
    let cfOpener: HTMLElement | null = null;
    /** a confirm: focus starts on Cancel, Esc cancels, focus goes back to the control that asked */
    const ask = (o: { title: string; body: string; items?: string[]; ok: string; opener: HTMLElement | null }): Promise<boolean> =>
        new Promise(resolve => {
            cfTitle.textContent = o.title;
            cfBody.textContent = o.body;
            cfList.replaceChildren(...(o.items ?? []).map(i => h('li', { text: i })));
            show(cfList, !!o.items?.length);
            cfOk.textContent = o.ok;
            if (typeof confirmDlg.showModal !== 'function') {
                resolve(window.confirm(`${o.title}\n\n${o.body}`));
                return;
            }
            cfDone = resolve;
            cfOpener = o.opener;
            confirmDlg.returnValue = '';
            confirmDlg.showModal();
            cfCancel.focus();
        });
    cfOk.addEventListener('click', () => confirmDlg.close('ok'));
    cfCancel.addEventListener('click', () => confirmDlg.close(''));
    confirmDlg.addEventListener('close', () => {
        const done = cfDone;
        cfDone = null;
        done?.(confirmDlg.returnValue === 'ok');
        if (cfOpener?.isConnected) cfOpener.focus();
        cfOpener = null;
    });

    let runOpener: HTMLElement | null = null;
    const openRun = (opener: HTMLElement) => {
        dlgBody.replaceChildren();
        if (board?.level) {
            // what WILL run: the values saved on the board, not the form
            dlgBody.append(h('p', { text: tr('tool.restart.body') }), h('div', { class: 'st-program' }, programList(describeProgram(board.values, board.level))));
            if (Object.keys(pendingChanges()).length) dlgBody.append(h('p', { class: 'st-note st-warn', text: tr('tool.restart.unsaved') }));
        } else dlgBody.append(h('p', { text: tr('tool.restart.bodyUnknown') }));
        dlgCheck.checked = false;
        dlgConfirm.disabled = true;
        runOpener = opener;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        dlgCheck.focus();
    };
    const closeDialog = () => {
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
    };
    dialog.addEventListener('close', () => {
        if (runOpener?.isConnected && !(runOpener as HTMLButtonElement).disabled) runOpener.focus();
        runOpener = null;
    });

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

    /** read the settings (enters the CLI: the board then holds the program until Run or a power cycle) */
    async function readNow() {
        if (!device) return;
        setMsg(saveMsg, '');
        setMsg(preMsg, '');
        setMsg(liveMsg, ''); // "program running from the start" is no longer true once the CLI holds it
        heldBy = 'settings';
        board = await device.readSettings();
        identity = device.identity;
        edited = { ...board.values };
        extra = {};
        clearNotes();
        autoOpened.clear();
        justSaved = false;
        resetOther();
        buildForm();
        renderFacts();
        say(board.level ? tr('tool.read.done') : tr('tool.verdict.stock'));
    }

    readBtn.addEventListener('click', async () => {
        await run(readNow, preMsg);
        if (board?.level) programBox.focus();
    });
    checkBtn.addEventListener('click', async () => {
        await run(readNow, errorBox);
        if (board?.level) programBox.focus();
        else focusEl(banner.querySelector<HTMLElement>('a'));
    });
    reloadBtn.addEventListener('click', async () => {
        if (Object.keys(pendingChanges()).length) return; // never throws edits away
        await run(readNow, saveMsg);
        if (board?.level) programBox.focus();
    });

    saveBtn.addEventListener('click', async () => {
        await run(async () => {
            if (!device || !board) return;
            setMsg(liveMsg, ''); // "the program runs from the start" is not true once the save holds it
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
            say(tr('tool.status.writing'));
            try {
                const r = await device.writeSettings(changes, s => setMsg(saveMsg, stepText(s)));
                heldBy = 'settings';
                board = r.settings;
                edited = { ...board.values };
                extra = {};
                clearNotes();
                autoOpened.clear();
                justSaved = true;
                resetOther();
                buildForm();
                renderFacts();
                const runNow = h('button', { type: 'button', class: 'st-btn st-small' }, tr('tool.saved.run'));
                runNow.addEventListener('click', () => openRun(runNow));
                const n1 = r.verified.length;
                saveMsg.replaceChildren(h('strong', { text: tr(n1 === 1 ? 'tool.saved.one' : 'tool.saved.other', { n: n1 }) }), ' ', tr('tool.saved.after'), ' ', runNow);
                saveMsg.className = 'st-msg st-ok';
                saveMsg.dataset.result = 'saved';
            } catch (e) {
                // a failed verify re-read the board: show what it really has, keep the visitor's edits
                if (device.settings && device.settings !== board) {
                    board = device.settings;
                    buildForm();
                }
                throw e;
            }
        }, saveMsg);
        if (saveMsg.dataset.result !== 'saved' && saveMsg.classList.contains('st-err')) saveMsg.dataset.result = 'error';
        focusEl(saveMsg);
    });

    undoBtn.addEventListener('click', () => {
        if (!board) return;
        edited = { ...board.values };
        extra = {};
        clearNotes();
        resetOther();
        refreshForm();
        setMsg(liveMsg, '');
        setMsg(saveMsg, tr('tool.undo.done'));
        focusEl(saveMsg);
    });

    resetBtn.addEventListener('click', async () => {
        if (!board) return;
        const target = { ...edited, ...defaultValues(board.eff) };
        const changes = diff(edited, target);
        if (!Object.keys(changes).length) {
            setMsg(saveMsg, tr('tool.defaults.none'));
            focusEl(saveMsg);
            return;
        }
        const items = Object.keys(changes).map(k => tr('tool.change.item', { name: labelOf(k), from: showValue(k, edited[k]), to: showValue(k, changes[k]) }));
        const ok = await ask({ title: tr('tool.defaults.title'), body: tr('tool.defaults.body'), items, ok: tr('tool.defaults.ok'), opener: resetBtn });
        if (!ok || !board) return;
        Object.assign(edited, changes);
        clearNotes();
        justSaved = false;
        resetOther();
        refreshForm();
        setMsg(liveMsg, '');
        setMsg(saveMsg, tr('tool.defaults.note'));
        focusEl(saveMsg);
    });

    /** STOPs pressed so far: a Run that was stopped while the board restarted must not claim the program runs */
    let stopSeq = 0;
    /** STOP: the button, the one in every dialog and 'sma:stop' from the page; never disabled by a busy step */
    async function doStop() {
        if (!device) return;
        stopSeq++;
        heldBy = 'stop';
        try {
            const r = await device.stopMotor();
            const text = tr(r === 'sent' ? 'tool.stop.sent' : r === 'queued' ? 'tool.stop.queued' : 'tool.stop.already');
            setMsg(liveMsg, text, 'ok');
            say(text);
        } catch (e) {
            showError(e, liveMsg);
        }
    }
    stopBtn.addEventListener('click', () => void doStop());
    const onStopEvent = () => void doStop();
    window.addEventListener('sma:stop', onStopEvent);

    restartBtn.addEventListener('click', () => openRun(restartBtn));
    testBtn.addEventListener('click', () => openRun(testBtn));
    dlgCheck.addEventListener('change', () => (dlgConfirm.disabled = !dlgCheck.checked));
    dlgCancel.addEventListener('click', closeDialog);
    dlgConfirm.addEventListener('click', () => {
        if (!dlgCheck.checked) return;
        // the motor is about to start: focus goes to STOP (the button that opened the dialog is disabled now)
        runOpener = stopBtn;
        closeDialog();
        stopBtn.focus();
        void run(async () => {
            if (!device) return;
            setMsg(liveMsg, tr('tool.status.rebooting'));
            const seq = stopSeq;
            await device.restartProgram();
            history.length = 0;
            if (stopSeq !== seq) {
                // STOP while the board restarted: it was sent once the board was back and holds the program
                heldBy = 'stop';
                setMsg(liveMsg, tr('tool.restart.stopped'), 'ok');
                say(tr('tool.restart.stopped'));
                return;
            }
            heldBy = null;
            setMsg(liveMsg, tr('tool.restart.done'), 'ok');
            say(tr('tool.restart.done'));
        }, liveMsg);
    });

    connectBtn.addEventListener('click', () => void connect());
    allPortsBtn.addEventListener('click', () => void connect(true));
    disconnectBtn.addEventListener('click', () => void disconnect(true));
    formEl.addEventListener('submit', ev => ev.preventDefault());

    renderSupport();
    renderPhase();

    const handle: ToolHandle = {
        async destroy() {
            await disconnect();
            if (sayTimer) clearTimeout(sayTimer);
            window.removeEventListener('sma:stop', onStopEvent);
            ro?.disconnect();
            stopBar.hidden = true;
            applyStopSpace();
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
