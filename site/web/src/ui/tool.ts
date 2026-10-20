// TEMPORARY STUB from the site-shell lane, so the site builds on its own. The serial-core lane
// replaces this whole file (and adds tool.css + i18n/tool.<locale>.json). Keep the signature:
//   mountTool(root, t, locale)  root = <section id="tool">, t = translate(key, vars?), locale = page language
// The section holds an <h2>, a lead paragraph and a [data-tool-fallback] card (no-JS / unsupported
// browser text): the tool replaces the fallback card with its own UI.

export type Locale = 'en' | 'es' | 'pl' | 'ru';
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const mountTool = (root: HTMLElement, t: Translate, locale: Locale): void => {
    const card = document.createElement('div');
    card.className = 'card tool-stub';
    card.dataset.locale = locale;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('cfg.stub');
    card.append(p);
    const fallback = root.querySelector('[data-tool-fallback]');
    if (fallback) fallback.replaceWith(card);
    else root.append(card);
};
