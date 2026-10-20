#!/usr/bin/env node
// Bench check of a Shramko Motor Autostart board with the website's own device code.
//
//   node tools/fc-node/check.mjs COM6                 identify, read and print every setting, one live sample
//   node tools/fc-node/check.mjs COM6 --write-test    + autostart_delay +1 → save → verify → restore → verify
//   node tools/fc-node/check.mjs --mock [--write-test] the same against the emulated board (no hardware)
//
// Close Betaflight Configurator first (the port can only be open once). Propeller OFF:
// reading settings stops the program, every save reboots the board.
// Exit code 0 = PASS, 1 = FAIL, 2 = usage.

import { tsImport } from 'tsx/esm/api';

const args = process.argv.slice(2);
const writeTest = args.includes('--write-test');
const useMock = args.includes('--mock');
const port = args.find(a => !a.startsWith('--'));
if (!useMock && !port) {
    console.error('usage: node tools/fc-node/check.mjs <COMx|/dev/ttyACM0> [--write-test] | --mock [--write-test]');
    process.exit(2);
}

const { runCheck } = await tsImport('./harness.ts', import.meta.url);
const { NodeSerialTransport } = await tsImport('./node-transport.ts', import.meta.url);

let transport;
if (useMock) {
    const { MockFc } = await tsImport('../../web/src/fc/mockfc.ts', import.meta.url);
    const { mockFcBinding } = await tsImport('./mockfc-binding.ts', import.meta.url);
    const mock = new MockFc({ rebootMs: 800 });
    transport = new NodeSerialTransport('MOCK', { binding: mockFcBinding(mock, 'MOCK'), pollMs: 100 });
    console.log('(emulated board, no hardware)');
} else {
    transport = new NodeSerialTransport(port);
}

const report = await runCheck(transport, { writeTest });
process.exit(report.ok ? 0 : 1);
