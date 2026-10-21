// Feedback on every screen: Bug · Idea · Collaboration (→ the contact form), plus the lead form.

import { ApiError, count, gaEvent, sendLead, sendReport, track } from './api';
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
    // analytics: the first thing typed into the dialog starts the form (ids only, never the text)
    let fbStarted = false;
    form.addEventListener('input', () => {
        if (fbStarted) return;
        fbStarted = true;
        track('form_start', 'feedback', { form_id: 'feedback' });
    });

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
        track('form_submit', 'feedback', { form_id: 'feedback', feedback_kind: k });
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
            // the server stored it: a report, not a lead (generate_lead is the collaboration form's)
            track('feedback_send', k, { form_id: 'feedback', feedback_kind: k });
        } catch (e) {
            // a retry in a moment cannot fix every failure: say what can
            const code = e instanceof ApiError ? e.status : 0;
            track('feedback_fail', String(code), { form_id: 'feedback', reason: String(code) });
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
    // analytics: form_start on the first touch, form_step once per requirement met (role chosen, a valid
    // e-mail, the consent ticked) — which step people stop at; never the values themselves
    const stepsDone = new Set<string>();
    const leadSteps = () => {
        const s = leadState();
        const done: [string, boolean][] = [['role', !!s.role], ['email', EMAIL.test(s.email)], ['consent', s.consent]];
        for (const [step, ok] of done) {
            if (!ok || stepsDone.has(step)) continue;
            stepsDone.add(step);
            track('form_step', step, { form_id: 'lead', step });
        }
    };
    const leadTouch = () => {
        if (!leadTouched) track('form_start', 'lead', { form_id: 'lead' });
        leadTouched = true;
        leadSync();
        leadSteps();
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
        track('form_submit', 'lead', { form_id: 'lead' });
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        try {
            const r = await sendLead({
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
            count('lead_submit');
            // only once the server confirmed it stored the lead (sendLead throws on any HTTP error)
            if (r?.ok) gaEvent('generate_lead', { form_id: 'lead', lead_type: s.role });
            lead.reset();
            leadBtn.disabled = true;
        } catch (e) {
            const code = e instanceof ApiError ? e.status : 0;
            track('lead_fail', String(code), { form_id: 'lead', reason: String(code) });
            leadStatus.textContent = t('ui.fbFail');
            leadBtn.disabled = false;
        }
    });
};
