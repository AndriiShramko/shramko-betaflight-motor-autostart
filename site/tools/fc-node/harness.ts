// Bench check of a board with the same device code the website uses: identify, read every setting,
// one live sample; with writeTest: autostart_delay +1 → save → verify → restore → verify.

import { AutostartDevice } from '../../web/src/fc/device.ts';
import { SCHEMA, STATE_NAMES } from '../../web/src/fc/settings.ts';
import type { Transport } from '../../web/src/fc/transport.ts';

export interface CheckOptions {
    writeTest?: boolean;
    print?: (line: string) => void;
    reconnectTimeoutMs?: number;
}

export interface CheckReport {
    ok: boolean;
    verdict: string;
    level: string | null;
    settings: Record<string, string | number>;
    live: { state: string | null; pct: number | null; volts: number | null; motors: number[] } | null;
    writeTest: { from: number; to: number; restored: boolean } | null;
    error?: string;
}

export async function runCheck(transport: Transport, opts: CheckOptions = {}): Promise<CheckReport> {
    const print = opts.print ?? ((l: string) => console.log(l));
    const device = new AutostartDevice(transport, { reconnectTimeoutMs: opts.reconnectTimeoutMs ?? 20000, log: l => print(`  · ${l}`) });
    const report: CheckReport = { ok: false, verdict: '', level: null, settings: {}, live: null, writeTest: null };
    try {
        const id = await device.connect();
        report.verdict = id.verdict;
        print(`board     ${id.board.boardName || id.board.identifier} (${id.board.manufacturerId}) ${id.board.targetName}`);
        print(`firmware  ${id.variant} ${id.fcVersion}, MSP API ${id.apiVersion}, build ${id.build.revision} ${id.build.date} ${id.build.time}`);
        print(`verdict   ${id.verdict}`);
        if (id.verdict === 'not-betaflight') throw new Error('not a Betaflight board');

        await device.stopLive();
        const s = await device.pollOnce();
        if (s) {
            report.live = { state: s.state === null ? null : STATE_NAMES[s.state] ?? String(s.state), pct: s.pct, volts: s.battery?.volts ?? null, motors: s.motors.slice(0, 4) };
            const esc = s.bestOutput >= 0 ? `ESC on output ${s.bestOutput + 1}: ${s.esc[s.bestOutput].rpm} rpm, ${s.esc[s.bestOutput].invalidPct}% bad` : 'no ESC telemetry';
            print(`live      state=${report.live.state} cmd=${s.pct ?? '-'}% motors=${report.live.motors.join(',')} battery=${report.live.volts ?? '-'} V cells=${s.battery?.cells ?? '-'} | ${esc}`);
        }

        print('reading settings (this stops the motor program until the board restarts)');
        const st = await device.readSettings();
        report.level = st.level;
        for (const d of SCHEMA) {
            const v = st.raw.get(d.name);
            if (!v) continue;
            report.settings[d.name] = st.values[d.name];
            const range = v.allowed ? v.allowed.join('|') : v.min !== undefined ? `${v.min}..${v.max}` : '';
            print(`  ${d.name.padEnd(26)} = ${String(v.value).padEnd(8)} ${range}${v.default !== undefined ? `  (default ${v.default})` : ''}`);
        }
        print(`  debug_mode = ${st.debugMode}, dshot_bidir = ${st.dshotBidir}, firmware level ${st.level ?? 'NO AUTOSTART MODULE'}`);
        if (st.missing.length) print(`  missing on this firmware: ${st.missing.join(', ')}`);
        if (!st.level) throw new Error('the autostart module is not on this board');

        if (opts.writeTest) {
            const from = Number(st.values.autostart_delay);
            const to = from < 600 ? from + 1 : from - 1;
            print(`write test: autostart_delay ${from} → ${to}, save (board reboots), verify`);
            await device.writeSettings({ autostart_delay: to }, p => print(`  step ${p.step}${p.total ? ` ${p.done}/${p.total}` : ''}`));
            if (device.settings?.values.autostart_delay !== to) throw new Error('write test: value not verified');
            print(`write test: verified ${to}; restoring ${from}`);
            await device.writeSettings({ autostart_delay: from });
            const restored = device.settings?.values.autostart_delay === from;
            report.writeTest = { from, to, restored };
            if (!restored) throw new Error('write test: restore not verified');
            print(`write test: restored and verified ${from}`);
        }
        report.ok = true;
        print('RESULT    PASS');
    } catch (e) {
        report.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        print(`RESULT    FAIL — ${report.error}`);
    } finally {
        await device.disconnect();
    }
    return report;
}
