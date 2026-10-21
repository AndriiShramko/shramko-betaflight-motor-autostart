// Page events for the counter and, after consent, Google Analytics 4 (WEB-TECH-BASELINE §T6, vault
// 03 - Resources/Deployment/analytics/ANALYTICS-HOWTO.md). Nothing here is personal: ids of buttons, sections,
// videos and file types only, never what a visitor typed. GA names its parameters (cta_id, cta_location,
// section_id, video_id, file_ext, method, percent); each name is in the counter's list (api/server.py EVENTS).
// Forms (lead, feedback) are counted in feedback.ts, the configurator in tool.ts, errors in diagnostics.ts.

import { gaEvent, track } from './api';

const SLUG = /[^a-z0-9_-]+/g;
const slug = (s: string, max = 24) => s.toLowerCase().replace(SLUG, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x';

/** where on the page an element is: its section id (the hero has none), the header, the footer or a dialog */
export const placeOf = (el: Element): string => {
    const box = el.closest('section, header, footer, dialog, .consent-bar');
    if (!box) return 'page';
    if (box.id) return slug(box.id);
    if (box.classList.contains('hero')) return 'hero';
    return box.tagName.toLowerCase();
};

const CONTACT: [RegExp, string][] = [
    [/^mailto:/i, 'email'],
    [/^tel:/i, 'phone'],
    [/^\/go\/cal\b/, 'calendar'],
    [/^\/go\/li\b/, 'linkedin'],
    [/(^|\/\/)(wa\.me|api\.whatsapp\.com)\//i, 'whatsapp'],
    [/(^|\/\/)t\.me\//i, 'telegram'],
    [/(^|\/\/)(m\.me|www\.messenger\.com)\//i, 'messenger']
];
const FILE = /^\/[^?#]*\.(svg|pdf|zip|hex|bin|png|jpg|webp|mp4|txt)(?:[?#]|$)/i;

const onClick = (e: MouseEvent) => {
    const el = (e.target as Element | null)?.closest?.('a[href], button');
    if (!el) return;
    // the consent buttons themselves are not engagement (the counter has its own 'consent' event)
    if (el.closest('#consent') || el.hasAttribute('data-consent-reset')) return;
    const href = el.getAttribute('href') ?? '';
    const cta_location = placeOf(el);
    for (const [re, method] of CONTACT) {
        if (re.test(href)) return track('contact_click', method, { method, cta_location });
    }
    const file = FILE.exec(href);
    if (file) {
        const file_ext = file[1].toLowerCase();
        return track('file_download_click', file_ext, { file_ext, cta_location });
    }
    let id = el.getAttribute('data-cta');
    if (!id) {
        const go = /^\/go\/([a-z0-9]+)/.exec(href);
        // a counted redirect (GitHub, releases, tools): the API counts go_<slug> too, GA sees which button
        if (go) id = `go_${go[1]}`;
        // the header menu: which part of the page people jump to
        else if (href.startsWith('#') && el.closest('header')) id = `nav_${href.slice(1)}`;
    }
    if (!id) return;
    const cta_id = slug(id);
    track('cta_click', cta_id, { cta_id, cta_location });
};

/** section_view once per section: half of it on screen, or (a section taller than the screen) it fills the middle */
const observeSections = () => {
    if (!('IntersectionObserver' in window)) return;
    const seen = new Set<string>();
    const sections = [...document.querySelectorAll<HTMLElement>('main > section')];
    const idOf = (s: Element) => (s.id ? slug(s.id, 40) : s.classList.contains('hero') ? 'hero' : '');
    const hit = (entries: IntersectionObserverEntry[]) => {
        for (const en of entries) {
            if (!en.isIntersecting) continue;
            const section_id = idOf(en.target);
            if (!section_id || seen.has(section_id)) continue;
            seen.add(section_id);
            track('section_view', section_id.slice(0, 24), { section_id });
        }
    };
    const half = new IntersectionObserver(hit, { threshold: 0.5 });
    const middle = new IntersectionObserver(hit, { rootMargin: '-50% 0px -50% 0px', threshold: 0 });
    for (const s of sections) {
        half.observe(s);
        middle.observe(s);
    }
};

/** the reels play only on a click (controls, preload none): play, 25/50/75 %, complete — once each per video */
const observeVideos = () => {
    document.querySelectorAll<HTMLVideoElement>('video').forEach((v) => {
        if (v.autoplay && v.muted) return; // a background loop is not engagement
        const video_id = slug(v.dataset.videoId || (v.currentSrc || v.querySelector('source')?.getAttribute('src') || 'video').split('/').pop()!.replace(/\.[a-z0-9]+$/i, ''), 40);
        const marks = new Set<number>();
        v.addEventListener('play', () => track('video_play', video_id.slice(0, 24), { video_id }), { once: true });
        v.addEventListener('timeupdate', () => {
            if (!v.duration || !Number.isFinite(v.duration)) return;
            const pct = (v.currentTime / v.duration) * 100;
            for (const m of [25, 50, 75]) {
                if (pct >= m && !marks.has(m)) {
                    marks.add(m);
                    gaEvent('video_progress', { video_id, percent: m });
                }
            }
        });
        v.addEventListener('ended', () => track('video_complete', video_id.slice(0, 24), { video_id }), { once: true });
    });
};

export const initAnalytics = () => {
    document.addEventListener('click', onClick, true);
    observeSections();
    observeVideos();
};
