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
    await loadStrings();
    initCopyButtons();
    initFeedback();
    initFeedbackButtonPlacement();
    initConsent();
    await mountConfigurator();
    const rel = await loadRelease();
    const el = document.getElementById('release');
    if (el) el.textContent = `release ${rel}`;
    track('page_view', lang);
};

main();
