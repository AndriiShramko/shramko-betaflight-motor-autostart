// Minimal page for the browser tests: mounts the tool the way web/src/main.ts does, plus a stand-in for the
// page's Feedback dialog that follows the event contract (a modal with its own STOP while a board is connected:
// it listens to 'sma:board' and dispatches 'sma:stop'). Every 'sma:board' detail is kept in window.__board.
import en from '../../web/src/i18n/tool.en.json';
import es from '../../web/src/i18n/tool.es.json';
import pl from '../../web/src/i18n/tool.pl.json';
import ru from '../../web/src/i18n/tool.ru.json';

type L = 'en' | 'es' | 'pl' | 'ru';
const all: Record<L, Record<string, string>> = { en, es, pl, ru };
const q = new URLSearchParams(location.search);
const locale = (['en', 'es', 'pl', 'ru'].includes(q.get('lang') ?? '') ? q.get('lang') : 'en') as L;
document.documentElement.lang = locale;
const t = (key: string, vars: Record<string, string | number> = {}) =>
    (all[locale][key] ?? all.en[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

const events: { connected: boolean; module: boolean; phase: string }[] = [];
(window as unknown as { __board: typeof events }).__board = events;
const fbStop = document.getElementById('fb-stop') as HTMLButtonElement;
window.addEventListener('sma:board', e => {
    const d = (e as CustomEvent<{ connected: boolean; module: boolean; phase: string }>).detail;
    events.push(d);
    fbStop.hidden = !d.connected;
});
fbStop.addEventListener('click', () => window.dispatchEvent(new CustomEvent('sma:stop')));
const fb = document.getElementById('fb') as HTMLDialogElement;
document.getElementById('fb-open')!.addEventListener('click', () => fb.showModal());
document.getElementById('fb-close')!.addEventListener('click', () => fb.close());

import('../../web/src/ui/tool').then(m => {
    const handle = m.mountTool(document.getElementById('tool') as HTMLElement, t, locale);
    (window as unknown as { __tool: unknown }).__tool = handle;
});
// what a bug report from the page's Feedback dialog would carry (feedback.ts reads the same two functions)
(window as unknown as { __diag: () => Promise<unknown> }).__diag = async () => {
    const d = await import('../../web/src/ui/diagnostics');
    return { tool: d.toolDiagnostics(), log: d.getLog() };
};
