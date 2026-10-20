// Feedback on every screen: Bug · Idea · Collaboration (→ the contact form), plus the lead form.

import { ApiError, sendLead, sendReport, track } from './api';
import { browserInfo, getLog, getRelease, onReportRequest, recentErrors, toolDiagnostics } from './diagnostics';
import { lang, listFormat, t } from './i18n';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MIN_MS = 3000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const initFeedback = () => {
    const dlg = $<HTMLDialogElement>('fb');
    const form = dlg.querySelector('form')!;
    const status = form.querySelector<HTMLElement>('.form-status')!;
    const msg = form.querySelector<HTMLTextAreaElement>('textarea[name=message]')!;
    const contact = form.querySelector<HTMLInputElement>('input[name=contact]')!;
    const diag = form.querySelector<HTMLInputElement>('input[name=diag]')!;
    const hp = form.querySelector<HTMLInputElement>('input[name=website]')!;
    const send = $<HTMLButtonElement>('fb-send');
    let openedAt = 0;

    // STOP inside the dialog while a board is connected: a modal dialog makes the rest of the page inert,
    // the configurator's fixed STOP bar included. The tool says when a board is connected ('sma:board')
    // and stops the motor on 'sma:stop' (the same path as its own STOP button).
    const stop = $<HTMLButtonElement>('fb-stop');
    window.addEventListener('sma:board', (e) => {
        stop.hidden = !(e as CustomEvent<{ connected?: boolean }>).detail?.connected;
    });
    stop.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent('sma:stop'));
        status.textContent = t('ui.fbStopSent');
    });

    const kind = () => (form.querySelector<HTMLInputElement>('input[name=kind]:checked')?.value ?? 'bug') as 'bug' | 'idea' | 'coop';
    const sync = () => {
        const k = kind();
        form.querySelector<HTMLElement>('.fb-msg')!.hidden = k === 'coop';
        form.querySelector<HTMLElement>('.fb-coop')!.hidden = k !== 'coop';
        form.querySelector<HTMLElement>('.fb-diag')!.hidden = k !== 'bug';
        status.textContent = '';
    };
    form.addEventListener('change', sync);

    const open = (prefill?: string) => {
        openedAt = Date.now();
        if (prefill !== undefined) {
            form.querySelector<HTMLInputElement>('input[name=kind][value=bug]')!.checked = true;
            diag.checked = true;
            // cut by characters, not UTF-16 units: half an emoji would make the report unreadable for the API
            if (!msg.value.trim()) msg.value = t('ui.errPrefill', { msg: Array.from(prefill).slice(0, 300).join('') });
        }
        sync();
        if (!dlg.open) dlg.showModal();
        track('feedback_open');
        msg.focus();
    };
    $('fb-open').addEventListener('click', () => open());
    onReportRequest((text) => open(text));
    $('fb-close').addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close();
    });
    $('fb-to-contact').addEventListener('click', () => dlg.close());

    send.addEventListener('click', async () => {
        // invisible control and format characters (U+200B …) are dropped by the API too: a message of only those is empty
        const text = msg.value.replace(/[\p{Cf}]|(?![\n\t])\p{Cc}/gu, '').trim();
        if (!text) {
            status.textContent = t('ui.fbEmpty');
            msg.focus();
            return;
        }
        // too-fast sends wait instead of failing (bots are filtered server-side)
        const wait = MIN_MS - (Date.now() - openedAt);
        send.disabled = true;
        status.textContent = t('ui.fbSending');
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const k = kind() === 'idea' ? 'idea' : 'bug';
        const withDiag = k === 'bug' && diag.checked;
        try {
            const r = await sendReport({
                kind: k,
                message: text,
                contact: contact.value.trim() || undefined,
                locale: lang,
                page: 'site',
                release: getRelease(),
                diagnosticsConsent: withDiag,
                diagnostics: withDiag ? { browser: browserInfo(), errors: recentErrors(), log: getLog().slice(-150), tool: toolDiagnostics() } : undefined,
                website: hp.value,
                t: Date.now() - openedAt
            });
            status.textContent = r?.id ? t('ui.fbOk', { id: r.id }) : t('ui.fbOkPlain');
            msg.value = '';
        } catch (e) {
            // a retry in a moment cannot fix every failure: say what can
            const code = e instanceof ApiError ? e.status : 0;
            status.textContent = t(code === 429 ? 'ui.fbTooMany' : code === 400 ? 'ui.fbBad' : 'ui.fbFail');
        } finally {
            send.disabled = false;
        }
    });

    // --- collaboration / lead form
    const lead = $<HTMLFormElement>('lead');
    const leadBtn = lead.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const leadStatus = lead.querySelector<HTMLElement>('.form-status')!;
    const leadOpened = Date.now();
    const leadState = () => {
        const role = lead.querySelector<HTMLInputElement>('input[name=role]:checked')?.value ?? '';
        const email = lead.querySelector<HTMLInputElement>('input[name=email]')!.value.trim();
        const consent = lead.querySelector<HTMLInputElement>('input[name=consent]')!.checked;
        const missing: string[] = [];
        if (!role) missing.push(t('ui.leadNeedRole'));
        if (!EMAIL.test(email)) missing.push(t('ui.leadNeedEmail'));
        if (!consent) missing.push(t('ui.leadNeedConsent'));
        return { role, email, consent, missing };
    };
    // the status region (polite) stays empty until the visitor touches the form: the static requirement is
    // the hint under the button (#lead-hint, aria-describedby), not an announcement on every page load
    let leadTouched = false;
    const leadSync = () => {
        const s = leadState();
        leadBtn.disabled = s.missing.length > 0;
        if (leadTouched) leadStatus.textContent = s.missing.length ? t('ui.leadNeed', { missing: listFormat(s.missing) }) : '';
    };
    const leadTouch = () => {
        leadTouched = true;
        leadSync();
    };
    lead.addEventListener('input', leadTouch);
    lead.addEventListener('change', leadTouch);
    leadSync();
    lead.addEventListener('submit', async (e) => {
        e.preventDefault();
        const s = leadState();
        if (s.missing.length) return leadTouch();
        const wait = MIN_MS - (Date.now() - leadOpened);
        leadBtn.disabled = true;
        leadStatus.textContent = t('ui.fbSending');
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try {
            await sendLead({
                role: s.role,
                email: s.email,
                message: lead.querySelector<HTMLTextAreaElement>('textarea[name=message]')!.value.trim(),
                consent: s.consent,
                locale: lang,
                page: 'contact',
                website: lead.querySelector<HTMLInputElement>('input[name=website]')!.value,
                t: Date.now() - leadOpened
            });
            leadStatus.textContent = t('ui.leadOk');
            track('lead_submit', undefined, { role: s.role });
            lead.reset();
            leadBtn.disabled = true;
        } catch {
            leadStatus.textContent = t('ui.fbFail');
            leadBtn.disabled = false;
        }
    });
};
