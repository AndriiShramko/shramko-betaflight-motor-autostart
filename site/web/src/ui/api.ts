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
 * Cookieless first-party counter: `{e, p}` (event name + one coarse value from the API's list,
 * api/server.py EVENTS). Counted with or without the analytics consent; no cookie, no IP kept. Never throws.
 */
export const count = (name: string, p?: string) => {
    try {
        const body = JSON.stringify(p ? { e: name, p } : { e: name });
        if (navigator.sendBeacon) {
            navigator.sendBeacon('/api/e', new Blob([body], { type: 'application/json' }));
        } else {
            fetch('/api/e', { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true }).catch(() => undefined);
        }
    } catch { /* counters must never break the page */ }
};

export type GaParams = Record<string, string | number | boolean>;

/**
 * One event: the counter gets `p`, Google Analytics gets `ga` (its own named parameters, never GA's
 * reserved `value`, which is a money metric) — and only after the visitor accepted analytics.
 * `beacon`: the page navigates away at once (a language link), so GA sends it with sendBeacon.
 */
export const track = (name: string, p?: string, ga?: GaParams, opts?: { beacon?: boolean }) => {
    count(name, p);
    gaEvent(name, ga, opts);
};

// --- Google Analytics 4, loaded only after consent (Consent Mode basic: no request to Google before "Accept").
// The id is public and committed in web/.env.production; web/scripts/post-build.mjs and deploy/deploy.sh refuse
// a build whose bundle lacks it (an empty variable once shipped a site with no analytics and no error at all).
const GA_ID = (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_GA_ID ?? '';
// GA cookies (_ga, _ga_<id>) live at most 14 months after the last visit, as long as GA keeps the data
const COOKIE_EXPIRES_S = 426 * 24 * 3600;
let gaLoaded = false;
let gaOn = false;
type Gtag = (...args: unknown[]) => void;

// gtag.js only recognises commands pushed as an `arguments` object (an array is ignored),
// so this must be a classic function, not an arrow function with rest parameters.
const gtag: Gtag = function gtagShim() {
    const w = window as unknown as { dataLayer: unknown[] };
    w.dataLayer = w.dataLayer || [];
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer.push(arguments);
};

const siteLang = () => (document.documentElement.lang || 'und').slice(0, 5).toLowerCase();

/** A GA4 event (after consent only; before it, or after a withdrawal, nothing is sent). Every event carries site_lang. */
export const gaEvent = (name: string, params?: GaParams, opts?: { beacon?: boolean }) => {
    if (!gaOn) return;
    try {
        gtag('event', name, { site_lang: siteLang(), ...params, ...(opts?.beacon ? { transport_type: 'beacon' } : {}) });
    } catch { /* analytics must never break the page */ }
};

export const gaAvailable = () => GA_ID.length > 0;

const gaConfig = () => {
    // config sends this page's page_view (granted): the page itself never sends one to GA
    gtag('config', GA_ID, { cookie_domain: location.hostname, cookie_expires: COOKIE_EXPIRES_S, site_lang: siteLang() });
};

/** The visitor accepted: load gtag.js (first time) or switch it back on (accepted again after a withdrawal). */
export const loadGa = () => {
    if (!GA_ID || gaOn) return;
    gaOn = true;
    (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`] = false;
    if (gaLoaded) {
        gtag('consent', 'update', { analytics_storage: 'granted' });
        gaConfig();
        return;
    }
    gaLoaded = true;
    (window as unknown as { gtag: Gtag }).gtag = gtag;
    gtag('consent', 'default', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('set', { allow_google_signals: false, allow_ad_personalization_signals: false });
    gaConfig();
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    document.head.appendChild(s);
};

/**
 * The visitor withdrew (or declined after having accepted): GA stops at once on this page
 * (consent denied + ga-disable-<id>), and its cookies go, on this host and on the parent domain.
 */
export const stopGa = (dropCookies: boolean) => {
    if (!GA_ID) return;
    gaOn = false;
    (window as unknown as Record<string, unknown>)[`ga-disable-${GA_ID}`] = true;
    if (gaLoaded) gtag('consent', 'update', { analytics_storage: 'denied' });
    if (!dropCookies) return;
    const host = location.hostname;
    const parts = host.split('.');
    // autostart.flyreelstudio.eu and flyreelstudio.eu (never a bare top-level domain), plus a host-only cookie
    const domains = parts.length > 1 ? parts.slice(0, -1).map((_, i) => parts.slice(i).join('.')) : [host];
    for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim();
        if (!name.startsWith('_ga')) continue;
        document.cookie = `${name}=; max-age=0; path=/`;
        for (const d of domains) document.cookie = `${name}=; max-age=0; path=/; domain=${d}`;
    }
};
