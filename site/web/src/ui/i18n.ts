// Runtime strings. The page text itself is static HTML (web/scripts/gen-pages.mjs); JavaScript needs
// only the strings it shows later (form states, the configurator). Each page loads its own language
// (plus English as the fallback) as a separate chunk, merged from two files:
//   web/src/i18n/<lang>.json        the site's strings (this lane)
//   web/src/i18n/tool.<lang>.json   the configurator's strings, keys "tool.*" (optional file)

export const LANGS = ['en', 'es', 'pl', 'ru'] as const;
export type Lang = typeof LANGS[number];
type Dict = Record<string, string>;

const pageDicts = import.meta.glob<Dict>(['../i18n/en.json', '../i18n/es.json', '../i18n/pl.json', '../i18n/ru.json'], { import: 'default' });
const toolDicts = import.meta.glob<Dict>('../i18n/tool.*.json', { import: 'default' });

export const lang: Lang = (LANGS as readonly string[]).includes(document.documentElement.lang) ? document.documentElement.lang as Lang : 'en';

let current: Dict = {};
let fallback: Dict = {};

const load = async (l: Lang): Promise<Dict> => {
    const page = pageDicts[`../i18n/${l}.json`];
    const tool = toolDicts[`../i18n/tool.${l}.json`];
    const [a, b] = await Promise.all([page ? page() : {}, tool ? tool() : {}]);
    return { ...a, ...b };
};

/** Loads the page language and English. Call once before anything uses t(). Never throws. */
export const loadStrings = async (): Promise<void> => {
    try {
        const [en, own] = await Promise.all([load('en'), lang === 'en' ? Promise.resolve(null) : load(lang)]);
        fallback = en;
        current = own ?? en;
    } catch { /* t() then returns the keys; the static page still works */ }
};

/** Translate `key`, substituting {name} placeholders. Falls back to English, then to the key. */
export const t = (key: string, vars: Record<string, string | number> = {}): string => {
    const s = current[key] ?? fallback[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
};

export const locale = { en: 'en-US', es: 'es-ES', pl: 'pl-PL', ru: 'ru-RU' }[lang];

export const listFormat = (items: string[]) => {
    try {
        return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
    } catch {
        return items.join(', ');
    }
};

/** Remember an explicit language choice (nginx reads the cookie at "/"). */
export const rememberLang = (l: string) => {
    document.cookie = `sma_lang=${l}; path=/; max-age=31536000; samesite=lax${location.protocol === 'https:' ? '; secure' : ''}`;
    try {
        localStorage.setItem('sma_lang', l);
    } catch { /* private mode */ }
};
