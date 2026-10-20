// Error capture from the first line of the app, the friendly error banner, and the facts a report
// needs. Every error goes into a small ring for reports; only errors of OUR code show the banner
// (WEB-PLAYBOOK §18): a file under this site's /assets/ (or /src/ in dev), or no file at all.
// Browser noise (aborted transitions, refused play(), a closed port picker, ResizeObserver,
// extensions, cross-origin "Script error.") is kept for reports but never shown to the visitor.
//
// For the configurator (web/src/ui/tool.ts and web/src/fc/**):
//   logLine(text)            one line of the configurator log (kept: the last 300; sent only with consent)
//   setDiagnostic(key, val)  facts for a bug report, e.g. setDiagnostic('fc', { board, firmware })
//   showSiteError(err)       show the banner for an error the tool caught itself

import { t } from './i18n';

const ERRORS_KEPT = 20;
const LOG_KEPT = 300;
const errors: string[] = [];
const log: string[] = [];
const extra: Record<string, unknown> = {};

// cut by characters, not UTF-16 units: half an emoji (a lone surrogate) would make a report unreadable for the API
const clean = (s: string) => Array.from(s.replace(/(https?:\/\/[^\s?#'")]+)[?#][^\s'")]*/g, '$1')).slice(0, 400).join('');
const stamp = () => new Date().toISOString().substring(11, 19);

export const describe = (x: unknown): string => {
    if (x instanceof Error) {
        const at = (x.stack ?? '').split('\n').slice(1, 3).map(l => l.trim()).join(' ');
        return clean(`${x.name}: ${x.message}${at ? ` @ ${at}` : ''}`);
    }
    try {
        return clean(typeof x === 'string' ? x : JSON.stringify(x));
    } catch {
        return clean(String(x));
    }
};

export const keepError = (kind: string, text: string) => {
    errors.push(`${stamp()} ${kind}: ${clean(text)}`);
    if (errors.length > ERRORS_KEPT) errors.shift();
};
export const recentErrors = () => errors.slice();

export const logLine = (text: string) => {
    log.push(`${stamp()} ${clean(text)}`);
    if (log.length > LOG_KEPT) log.shift();
};
export const getLog = () => log.slice();

export const setDiagnostic = (key: string, value: unknown) => {
    extra[key] = value;
};
/** the configurator registers what it knows now (phase, board, firmware, verdict, last error, its log) */
let provider: (() => Record<string, unknown>) | null = null;
export const setDiagnosticsProvider = (fn: (() => Record<string, unknown>) | null) => {
    provider = fn;
};
export const toolDiagnostics = () => {
    let live: Record<string, unknown> = {};
    try {
        live = provider?.() ?? {};
    } catch { /* a report must never fail because of this */ }
    return { ...extra, ...live };
};

// ---------- which errors are ours
const NOISE = /ResizeObserver loop|Transition was aborted|Viewport size changed|play\(\) (request|failed)|The play\(\) request|AbortError|NotAllowedError|InvalidStateError|NotFoundError|No port selected|The user aborted|^Script error\.?$/i;
const FOREIGN = /(chrome|moz|safari)-extension:\/\/|webkit-masked-url:/i;

const ownFile = (file: string) => {
    if (!file) return true;
    if (FOREIGN.test(file)) return false;
    try {
        const u = new URL(file, location.href);
        return u.origin === location.origin && (u.pathname.startsWith('/assets/') || u.pathname.startsWith('/src/') || u.pathname.startsWith('/node_modules/'));
    } catch {
        return false;
    }
};

/** Pure classifier (exported for tests): should this error show the banner? */
export const isOwnError = (message: string, file: string, stack: string): boolean => {
    if (NOISE.test(message)) return false;
    if (FOREIGN.test(stack)) return false;
    if (file) return ownFile(file);
    // no file: decide by the first URL in the stack, if there is one
    const m = /(https?:\/\/[^\s)]+?):\d+:\d+/.exec(stack);
    return m ? ownFile(m[1]) : true;
};

// ---------- the banner (markup in web/template.html, texts static per language)
let bannerShown = 0;
let lastMessage = '';
let openReport: ((prefill: string) => void) | null = null;

/** feedback.ts registers how "Send a report" opens the dialog with the error text filled in. */
export const onReportRequest = (fn: (prefill: string) => void) => {
    openReport = fn;
};

export const showSiteError = (err: unknown) => {
    const box = document.getElementById('site-error');
    const msg = document.getElementById('site-error-msg');
    if (!box || !msg) return;
    lastMessage = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    bannerShown++;
    msg.textContent = clean(lastMessage).substring(0, 200) + (bannerShown > 1 ? ` (×${bannerShown})` : '');
    box.hidden = false;
};

const initBanner = () => {
    const box = document.getElementById('site-error');
    if (!box) return;
    document.getElementById('site-error-close')?.addEventListener('click', () => {
        box.hidden = true;
    });
    document.getElementById('site-error-reload')?.addEventListener('click', () => location.reload());
    const copy = document.getElementById('site-error-copy');
    // the label is kept once: a second click within 1.5 s must not make "Copied" the label for good
    if (copy) copy.dataset.label ??= copy.textContent ?? '';
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    copy?.addEventListener('click', () => {
        const text = [`release ${getRelease()}`, location.pathname, navigator.userAgent, ...recentErrors()].join('\n');
        navigator.clipboard?.writeText(text).then(() => {
            copy.textContent = t('ui.copied');
            if (copyTimer) clearTimeout(copyTimer);
            copyTimer = setTimeout(() => {
                copyTimer = null;
                copy.textContent = copy.dataset.label ?? '';
            }, 1500);
        }).catch(() => undefined);
    });
    document.getElementById('site-error-report')?.addEventListener('click', () => {
        box.hidden = true;
        openReport?.(lastMessage);
    });
};

export const installErrorCapture = () => {
    addEventListener('error', (e) => {
        // resource errors (a missing image) have no message and are not exceptions: not ours to show
        if (!(e instanceof ErrorEvent)) return;
        const text = e.error ? describe(e.error) : `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`;
        keepError('error', text);
        if (isOwnError(e.message || '', e.filename || '', (e.error as Error | undefined)?.stack ?? '')) showSiteError(e.error ?? e.message);
    });
    addEventListener('unhandledrejection', (e) => {
        const r = e.reason as { name?: string; message?: string; stack?: string } | undefined;
        keepError('rejection', describe(e.reason));
        const message = r && typeof r === 'object' ? `${r.name ?? ''}: ${r.message ?? ''}` : String(e.reason);
        if (isOwnError(message, '', (r && typeof r === 'object' && r.stack) || '')) showSiteError(e.reason);
    });
    const consoleError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        keepError('console', args.map(describe).join(' '));
        consoleError(...args);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initBanner, { once: true });
    else initBanner();
};

let release = 'dev';
export const loadRelease = async () => {
    try {
        const r = await fetch('/release.json', { cache: 'no-store' });
        if (r.ok) release = ((await r.json()) as { sha?: string }).sha ?? 'dev';
    } catch { /* offline or dev */ }
    return release;
};
export const getRelease = () => release;

/** Browser facts for reports (no identifiers). */
export const browserInfo = () => ({
    userAgent: navigator.userAgent,
    platform: (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
    languages: navigator.languages?.slice(0, 4),
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    webSerial: 'serial' in navigator,
    webUsb: 'usb' in navigator,
    online: navigator.onLine
});
