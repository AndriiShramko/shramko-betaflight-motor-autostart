// Minimal page for the browser tests: mounts the tool the way web/src/main.ts does.
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

import('../../web/src/ui/tool').then(m => {
    const handle = m.mountTool(document.getElementById('tool') as HTMLElement, t, locale);
    (window as unknown as { __tool: unknown }).__tool = handle;
});
