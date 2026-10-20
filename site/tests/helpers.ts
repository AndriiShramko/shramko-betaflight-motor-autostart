// Shared test wiring: the mock board behind a fake navigator.serial behind the real WebSerialTransport.

import { AutostartDevice, type DeviceOptions } from '../web/src/fc/device.ts';
import { MockFc, MockSerial, type MockOptions } from '../web/src/fc/mockfc.ts';
import { WebSerialTransport } from '../web/src/fc/transport.ts';

export const rig = (mockOpts: MockOptions = {}, devOpts: DeviceOptions = {}) => {
    const mock = new MockFc({ rebootMs: 150, ...mockOpts });
    const serial = new MockSerial(mock);
    const transport = new WebSerialTransport(serial, { pollMs: 40 });
    const log: string[] = [];
    const device = new AutostartDevice(transport, { reconnectTimeoutMs: 3000, dropTimeoutMs: 1500, log: l => log.push(l), ...devOpts });
    return { mock, serial, transport, device, log };
};

export const waitFor = async (cond: () => boolean, timeoutMs = 3000, what = 'condition') => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
        await new Promise(r => setTimeout(r, 20));
    }
};
