// Same-origin calls to the site's tiny API (feedback, error reports, leads, cookieless counters).
// Event names and values must be in the API's allow-list (api/server.py EVENTS), or they are dropped.

export type ReportKind = 'bug' | 'idea' | 'error';
export type ReportPage = 'site' | 'tool';

export interface ReportBody {
    kind: ReportKind;
    message: string;
    contact?: string;
    locale: string;
    page: ReportPage;
    release: string;
    stage?: string;
    diagnosticsConsent: boolean;
    diagnostics?: Record<string, unknown>;
    website?: string; // honeypot
    t: number;        // ms since the form opened
}

const gzip = async (text: string): Promise<Uint8Array | null> => {
    if (typeof CompressionStream === 'undefined') return null;
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** A failed API call; `status` is the HTTP status (0 = no answer at all). */
export class ApiError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = 'ApiError';
    }
}

/** Lone UTF-16 surrogates (a string cut in the middle of an emoji) become U+FFFD: the API must be able to encode them. */
export const wellFormed = (s: string): string =>
    typeof (s as unknown as { toWellFormed?: () => string }).toWellFormed === 'function'
        ? (s as unknown as { toWellFormed: () => string }).toWellFormed()
        : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
const deepWellFormed = (v: unknown): unknown => {
    if (typeof v === 'string') return wellFormed(v);
    if (Array.isArray(v)) return v.map(deepWellFormed);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [wellFormed(k), deepWellFormed(x)]));
    return v;
};

/** POST JSON; bodies over 8 KB are gzipped. Returns the parsed JSON or throws an ApiError. */
const post = async (path: string, body: unknown): Promise<any> => {
    const text = JSON.stringify(deepWellFormed(body));
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let payload: BodyInit = text;
    if (text.length > 8192) {
        const z = await gzip(text);
        if (z) {
            payload = z as unknown as BodyInit;
            headers['Content-Encoding'] = 'gzip';
        }
    }
    let r: Response;
    try {
        r = await fetch(path, { method: 'POST', headers, body: payload, credentials: 'omit', keepalive: text.length < 60000 });
    } catch (e) {
        throw new ApiError(`no answer: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(`HTTP ${r.status}${json?.error ? `: ${json.error}` : ''}`, r.status);
    return json;
};

export const sendReport = (body: ReportBody): Promise<{ ok: boolean; id: string; delivered?: boolean }> => post('/api/report', body);

export const sendLead = (body: { role: string; email: string; message: string; consent: boolean; locale: string; page: string; website: string; t: number }) => post('/api/lead', body);

/**
 * Cookieless first-party counter (`{e, p}`: event name + one coarse value from the API's list).
 * `props` go only to Google Analytics, and only after consent. Never throws.
 */
export const track = (name: string, p?: string, props?: Record<string, string | number | boolean>) => {
    try {
        const body = JSON.stringify(p ? { e: name, p } : { e: name });
        if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/e', new Blob([body], { type: 'application/json' }));
        } else {
            fetch('/api/e', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => undefined);
        }
    } catch { /* counters must never break the page */ }
    gtagEvent(name, { ...(p ? { value: p } : {}), ...props });
};

// --- Google Analytics, loaded only after consent (Consent Mode basic: nothing before "Accept")
const GA_ID = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_GA_ID ?? '';
let gaLoaded = false;
type Gtag = (...args: unknown[]) => void;

// gtag.js only recognises commands pushed as an `arguments` object (an array is ignored),
// so this must be a classic function, not an arrow function with rest parameters.
const gtag: Gtag = function gtagShim() {
    const w = window as unknown as { dataLayer: unknown[] };
    w.dataLayer = w.dataLayer || [];
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
};

const gtagEvent = (name: string, props?: Record<string, unknown>) => {
    if (gaLoaded) gtag('event', name, props ?? {});
};

export const gaAvailable = () => GA_ID.length > 0;

export const loadGa = () => {
    if (!GA_ID || gaLoaded) return;
    gaLoaded = true;
    (window as unknown as { gtag: Gtag }).gtag = gtag;
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', GA_ID, { anonymize_ip: true });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(s);
};
