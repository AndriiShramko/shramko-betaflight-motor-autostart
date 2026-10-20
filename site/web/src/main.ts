import { installErrorCapture, keepError, describe, loadRelease, showSiteError } from './ui/diagnostics';
// capture errors before anything else runs
installErrorCapture();

import './styles.css';
import { gaAvailable, loadGa, track } from './ui/api';
import { initFeedback } from './ui/feedback';
import { lang, loadStrings, rememberLang, t } from './ui/i18n';

const CONSENT_KEY = 'sma_consent';

const initLangSwitch = () => {
    document.querySelectorAll<HTMLAnchorElement>('a[data-lang]').forEach((a) => {
        if (a.dataset.lang === document.documentElement.lang) a.setAttribute('aria-current', 'true');
        a.addEventListener('click', () => {
            rememberLang(a.dataset.lang!);
            track('lang_switch', a.dataset.lang!);
        });
    });
};

const initCopyButtons = () => {
    document.querySelectorAll<HTMLButtonElement>('button[data-copy]').forEach((b) => {
        b.addEventListener('click', () => {
            const text = document.getElementById(b.dataset.copy!)?.textContent ?? '';
            navigator.clipboard.writeText(text).then(() => {
                const old = b.textContent;
                b.textContent = t('ui.copied');
                track('copy_prompt', b.dataset.copy);
                setTimeout(() => {
                    b.textContent = old;
                }, 1500);
            }).catch(() => undefined);
        });
    });
};

const readConsent = () => {
    try {
        return localStorage.getItem(CONSENT_KEY);
    } catch {
        return null;
    }
};
const writeConsent = (v: string | null) => {
    try {
        if (v === null) localStorage.removeItem(CONSENT_KEY);
        else localStorage.setItem(CONSENT_KEY, v);
    } catch { /* private mode: asked again next time */ }
};

const initConsent = () => {
    // without a GA4 id for this site there is nothing to consent to: no banner, no consent buttons
    if (!gaAvailable()) return;
    const bar = document.getElementById('consent')!;
    const ask = () => {
        bar.hidden = false;
    };
    const set = (v: 'yes' | 'no') => {
        writeConsent(v);
        bar.hidden = true;
        track('consent', v);
        if (v === 'yes') loadGa();
    };
    document.getElementById('consent-yes')!.addEventListener('click', () => set('yes'));
    document.getElementById('consent-no')!.addEventListener('click', () => set('no'));
    // withdrawing: forget the choice; if GA already ran on this page, drop its cookies and reload
    document.querySelectorAll<HTMLElement>('[data-consent-wrap]').forEach((w) => {
        w.hidden = false;
    });
    document.querySelectorAll<HTMLButtonElement>('[data-consent-reset]').forEach((b) => {
        b.addEventListener('click', () => {
            const was = readConsent();
            writeConsent(null);
            if (was === 'yes') {
                for (const c of document.cookie.split(';')) {
                    const name = c.split('=')[0].trim();
                    if (name.startsWith('_ga')) document.cookie = `${name}=; max-age=0; path=/; domain=${location.hostname.split('.').slice(-2).join('.')}`;
                    if (name.startsWith('_ga')) document.cookie = `${name}=; max-age=0; path=/`;
                }
                location.reload();
                return;
            }
            ask();
        });
    });
    const choice = readConsent();
    if (choice === 'yes') return loadGa();
    if (choice === 'no') return;
    ask();
};

// phones (< 760 px): the nav links live in a native <details> menu; it closes when a link is chosen,
// on Esc (focus back to its summary) and on a click outside it
const initMenu = () => {
    const menu = document.querySelector<HTMLDetailsElement>('details.menu');
    const summary = menu?.querySelector<HTMLElement>('summary');
    if (!menu || !summary) return;
    menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
        menu.open = false;
    }));
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || !menu.open) return;
        menu.open = false;
        summary.focus();
    });
    document.addEventListener('click', (e) => {
        if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
    });
};

// The header keeps one row: when its nav would wrap (windows between phone and wide desktop, longer words in
// es/pl/ru) the links move into the Menu, as on phones. The measured height of the sticky header becomes
// html scroll-padding-top (--top-h), so a #jump or a focused control never comes to rest under it; a header
// that scrolls away (phones, a phone held sideways) reserves nothing.
const initHeader = () => {
    const top = document.querySelector<HTMLElement>('header.top');
    const nav = top?.querySelector<HTMLElement>('.nav');
    const brand = top?.querySelector<HTMLElement>('.brand');
    if (!top || !nav || !brand) return;
    const setHeight = () => {
        const sticky = getComputedStyle(top).position === 'sticky';
        document.documentElement.style.setProperty('--top-h', `${sticky ? Math.ceil(top.getBoundingClientRect().height) : 0}px`);
    };
    const navFits = () => {
        top.classList.remove('compact');
        if (getComputedStyle(nav).display === 'none') return true; // narrow screens: the CSS shows the Menu already
        const b = brand.getBoundingClientRect();
        const onBrandRow = (el: Element | null) => {
            if (!el) return true;
            const r = el.getBoundingClientRect();
            return r.top < b.bottom - 2 && r.bottom > b.top + 2;
        };
        return [...nav.children, top.querySelector('.langs')].every(onBrandRow);
    };
    const layout = () => {
        top.classList.toggle('compact', !navFits());
        setHeight();
    };
    layout();
    window.addEventListener('resize', layout);
    document.fonts?.ready.then(layout).catch(() => undefined);
    if (typeof ResizeObserver === 'function') new ResizeObserver(setHeight).observe(top);
};

// A #hash that points at folded content (the DFU fix, Technical details, an FAQ answer, the agent prompt,
// or anything inside a <details>) opens every closed <details> around it first, then the page scrolls there.
const targetOf = (hash: string): HTMLElement | null => {
    const id = hash.replace(/^#/, '');
    if (!id) return null;
    try {
        return document.getElementById(decodeURIComponent(id));
    } catch {
        return document.getElementById(id);
    }
};
/** opens the <details> the element is (or sits in), outermost included; true when something opened */
const unfold = (el: HTMLElement) => {
    let opened = false;
    for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) {
        if (!d.open) {
            d.open = true;
            opened = true;
        }
    }
    return opened;
};
const revealHash = () => {
    const el = targetOf(location.hash);
    if (!el) return false;
    if (unfold(el)) el.scrollIntoView({ block: 'start' });
    return true;
};
const initFoldedTargets = () => {
    // a click on an in-page link: open first, then the browser's own jump lands on visible content
    document.addEventListener('click', (e) => {
        const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
        const el = a ? targetOf(a.getAttribute('href') ?? '') : null;
        if (el) unfold(el);
    });
    // back/forward, an edited address, a link from another page
    window.addEventListener('hashchange', () => revealHash());
    return revealHash();
};

// the connected board already has the module: Step 1 says so (the configurator sends 'sma:board')
const initFirmwareBadge = () => {
    const badge = document.querySelector<HTMLElement>('[data-fw-found]');
    if (!badge) return;
    window.addEventListener('sma:board', (e) => {
        const d = (e as CustomEvent<{ connected?: boolean; module?: boolean }>).detail;
        badge.hidden = !(d?.connected && d.module);
    });
};

// phones: the floating Feedback button steps aside while the hero's call-to-action buttons are on
// screen (it would cover them), and comes back as soon as they scroll away
const initFeedbackButtonPlacement = () => {
    const btn = document.getElementById('fb-open');
    const cta = document.querySelector('.cta-row');
    if (!btn || !cta || !('IntersectionObserver' in window)) return;
    new IntersectionObserver(([e]) => btn.classList.toggle('away', e.isIntersecting)).observe(cta);
};

const mountConfigurator = async () => {
    const section = document.getElementById('tool');
    if (!section) return;
    // the tool replaces only the no-JS fallback; the section's h2 and lead stay (heading order, title)
    const root = document.createElement('div');
    const fallback = section.querySelector('[data-tool-fallback]');
    if (fallback) fallback.replaceWith(root);
    else section.append(root);
    try {
        const m = await import('./ui/tool');
        m.mountTool(root, t, lang);
    } catch (e) {
        keepError('tool', describe(e));
        const p = document.createElement('p');
        p.className = 'banner warn';
        p.textContent = t('ui.toolLoadFail');
        root.append(p);
        showSiteError(e);
    }
};

const main = async () => {
    initLangSwitch();
    initHeader();
    initMenu();
    const hashFound = initFoldedTargets();
    initFirmwareBadge();
    await loadStrings();
    initCopyButtons();
    initFeedback();
    initFeedbackButtonPlacement();
    initConsent();
    await mountConfigurator();
    // a deep link into the configurator (#tool-connect, #tool-status …) exists only after the mount
    if (!hashFound && targetOf(location.hash)) {
        revealHash();
        targetOf(location.hash)?.scrollIntoView({ block: 'start' });
    }
    const rel = await loadRelease();
    const el = document.getElementById('release');
    if (el) el.textContent = `release ${rel}`;
    track('page_view', lang);
};

main();
