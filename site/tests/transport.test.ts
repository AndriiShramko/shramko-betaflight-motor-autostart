import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockFc, MockSerial } from '../web/src/fc/mockfc.ts';
import { BOARD_USB_FILTERS, FcError, WebSerialTransport, detectSerialSupport, mapSerialError, type SerialLike, type SerialPortLike } from '../web/src/fc/transport.ts';

const dom = (name: string, msg = name) => new DOMException(msg, name);

test('error mapping: picker cancelled, permission, port busy', () => {
    assert.equal(mapSerialError(dom('NotFoundError', 'No port selected by the user.'), 'request').code, 'cancelled');
    assert.equal(mapSerialError(dom('SecurityError'), 'request').code, 'permission');
    assert.equal(mapSerialError(dom('NetworkError', 'Failed to open serial port.'), 'open').code, 'busy');
    assert.equal(mapSerialError(dom('InvalidStateError'), 'open').code, 'busy');
    assert.equal(mapSerialError(new Error('weird'), 'open').code, 'internal');
});

test('support detection: Web Serial, WebUSB (Android polyfill), none (iOS), insecure', () => {
    assert.equal(detectSerialSupport({ serial: {} } as unknown as Navigator, true), 'web-serial');
    assert.equal(detectSerialSupport({ usb: {} } as unknown as Navigator, true), 'webusb');
    assert.equal(detectSerialSupport({} as Navigator, true), 'none');
    assert.equal(detectSerialSupport({ serial: {} } as unknown as Navigator, false), 'insecure');
});

test('open on a busy port gives a clear "busy" error', async () => {
    const t = new WebSerialTransport(new MockSerial(new MockFc({ busy: true })));
    await assert.rejects(t.open(), (e: unknown) => e instanceof FcError && e.code === 'busy');
});

test('the picker lists flight-controller USB chips only; "show all ports" lists everything', async () => {
    const serial = new MockSerial(new MockFc());
    const asked: unknown[] = [];
    const spy: SerialLike = { requestPort: o => (asked.push(o), serial.requestPort(o)), getPorts: () => serial.getPorts() };
    const t = new WebSerialTransport(spy);
    await t.open();
    await t.close();
    await t.open({ anyPort: true });
    await t.close();
    assert.deepEqual(asked[0], { filters: BOARD_USB_FILTERS });
    assert.ok(BOARD_USB_FILTERS.some(f => f.usbVendorId === 0x0483), 'STM32 native USB (the HGLRC F405: 0483:5740) is listed');
    assert.deepEqual(asked[1], {});
});

test('a Bluetooth port that will not open is "not-usb", the same failure on a USB port is "busy" (control)', async () => {
    const failing = (info: Record<string, unknown>): SerialLike => ({
        requestPort: async () => ({
            open: async () => { throw dom('NetworkError', 'Failed to open serial port.'); },
            close: async () => undefined, readable: null, writable: null,
            getInfo: () => info
        }) as SerialPortLike,
        getPorts: async () => []
    });
    await assert.rejects(new WebSerialTransport(failing({ bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' })).open({ anyPort: true }),
        (e: unknown) => e instanceof FcError && e.code === 'not-usb');
    await assert.rejects(new WebSerialTransport(failing({ usbVendorId: 0x0483, usbProductId: 0x5740 })).open(),
        (e: unknown) => e instanceof FcError && e.code === 'busy');
});

test('closing the picker gives "cancelled"', async () => {
    const t = new WebSerialTransport(new MockSerial(new MockFc({ cancelPicker: true })));
    await assert.rejects(t.open(), (e: unknown) => e instanceof FcError && e.code === 'cancelled');
});

test('bytes flow both ways', async () => {
    const mock = new MockFc();
    const t = new WebSerialTransport(new MockSerial(mock));
    await t.open();
    const got: number[] = [];
    t.onData(b => got.push(...b));
    await t.write(Uint8Array.from([0x24, 0x4d, 0x3c, 0, 1, 1]));
    for (let i = 0; i < 50 && got.length < 9; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(got.slice(0, 5), [0x24, 0x4d, 0x3e, 3, 1]);
    assert.equal(t.describe(), 'USB 0483:5740');
    await t.close();
    assert.equal(t.isOpen, false);
});

test('reboot: port lost, then reopened as a NEW port object without a picker', async () => {
    const mock = new MockFc({ rebootMs: 120 });
    const serial = new MockSerial(mock);
    let pickers = 0;
    const counting: SerialLike = {
        requestPort: o => {
            pickers++;
            return serial.requestPort(o);
        },
        getPorts: () => serial.getPorts(),
        addEventListener: (a, b) => serial.addEventListener(a, b),
        removeEventListener: (a, b) => serial.removeEventListener(a, b)
    };
    const t = new WebSerialTransport(counting, { pollMs: 30 });
    await t.open();
    const first = (await serial.getPorts())[0];
    const reasons: string[] = [];
    t.onClose(r => reasons.push(r));
    mock.reboot();
    for (let i = 0; i < 50 && !reasons.length; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(reasons, ['lost']);
    assert.equal(t.isOpen, false);
    await t.reconnect(2000);
    assert.equal(t.isOpen, true);
    assert.notEqual((await serial.getPorts())[0], first);
    assert.equal(pickers, 1);
    await t.close();
});

test('reconnect gives up with "reconnect-timeout" when the board never comes back (negative control)', async () => {
    const mock = new MockFc({ neverReturnAfterReboot: true });
    const t = new WebSerialTransport(new MockSerial(mock), { pollMs: 30 });
    await t.open();
    mock.reboot();
    await new Promise(r => setTimeout(r, 50));
    const t0 = Date.now();
    await assert.rejects(t.reconnect(400), (e: unknown) => e instanceof FcError && e.code === 'reconnect-timeout');
    assert.ok(Date.now() - t0 >= 380);
});
