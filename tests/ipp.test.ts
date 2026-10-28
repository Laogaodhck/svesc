import http from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  buildGetPrinterAttributesRequest,
  ippGetAttributes,
  parseIppResponse,
  toConsumables,
  toPrinterState,
  type IppAttribute,
  type IppResult,
} from '../src/main/engine/printers/ipp';

function attribute(tag: number, name: string, value: string | number | Buffer): Buffer {
  const nameBytes = Buffer.from(name);
  const valueBytes = typeof value === 'number' ? Buffer.alloc(4)
    : typeof value === 'string' ? Buffer.from(value) : value;
  if (typeof value === 'number') valueBytes.writeInt32BE(value);
  const prefix = Buffer.alloc(3);
  prefix[0] = tag;
  prefix.writeUInt16BE(nameBytes.length, 1);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(valueBytes.length);
  return Buffer.concat([prefix, nameBytes, length, valueBytes]);
}

function packet(parts: Buffer[] = [], statusCode = 0, requestId = 1): Buffer {
  const header = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]);
  header.writeUInt16BE(statusCode, 2);
  header.writeInt32BE(requestId, 4);
  return Buffer.concat([header, Buffer.from([4]), ...parts, Buffer.from([3])]);
}

function result(attributes: IppAttribute[] = [], statusCode = 0): IppResult {
  return { statusCode, path: '/ipp/print', attrs: new Map(attributes.map((entry) => [entry.name, entry])) };
}

function stateResult(state?: number | string, reasons: (string | number)[] = []): IppResult {
  return result([
    { name: 'printer-state', tag: 0x23, values: state === undefined ? [] : [state] },
    { name: 'printer-state-reasons', tag: 0x44, values: reasons },
  ]);
}

interface LocalServer {
  port: number;
  paths: string[];
  sockets: Set<Socket>;
}

async function withServer(handler: http.RequestListener, run: (server: LocalServer) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? '');
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing loopback address');
    await run({ port: address.port, paths, sockets });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  }
}

const printerAttributes = [
  attribute(0x23, 'printer-state', 4),
  attribute(0x44, 'printer-state-reasons', 'none'),
  attribute(0x21, 'marker-levels', -1),
];

describe('IPP encoding and bounded parsing', () => {
  it('keeps the three-argument builder and default port compatible', () => {
    const request = buildGetPrinterAttributesRequest('127.0.0.1', '/ipp/print', 42);
    expect([...request.subarray(0, 4)]).toEqual([2, 0, 0, 9]);
    const parsed = parseIppResponse(request);
    expect(parsed.requestId).toBe(42);
    expect(parsed.attrs.get('printer-uri')?.values).toEqual(['ipp://127.0.0.1:631/ipp/print']);
    expect(parsed.attrs.get('requested-attributes')?.values).toEqual([
      'marker-levels', 'marker-names', 'marker-colors', 'printer-state',
      'printer-state-reasons', 'queued-job-count', 'printer-make-and-model',
    ]);
    expect(parseIppResponse(buildGetPrinterAttributesRequest('127.0.0.1', '/ipp')).requestId).toBe(1);
  });

  it('uses an optional port in the printer URI', () => {
    const request = buildGetPrinterAttributesRequest('127.0.0.1', '/ipp', 17, 12345);
    expect(parseIppResponse(request).attrs.get('printer-uri')?.values).toEqual(['ipp://127.0.0.1:12345/ipp']);
  });

  it('parses multiple values and groups without mixing names', () => {
    const response = packet([
      Buffer.from([1]),
      attribute(0x47, 'attributes-charset', 'utf-8'),
      Buffer.from([4]),
      attribute(0x21, 'marker-levels', 75),
      attribute(0x21, '', -3),
      attribute(0x42, 'marker-names', 'Black'),
      attribute(0x42, '', 'Cyan'),
      attribute(0x44, 'printer-state-reasons', 'toner-low-warning'),
      attribute(0x44, '', 'media-jam-error'),
      Buffer.from([5]),
      attribute(0x10, 'unsupported-attribute', Buffer.alloc(0)),
    ], 1, 91);
    const parsed = parseIppResponse(response);
    expect(parsed.requestId).toBe(91);
    expect(parsed.attrs.get('marker-levels')?.values).toEqual([75, -3]);
    expect(parsed.attrs.get('marker-names')?.values).toEqual(['Black', 'Cyan']);
    expect(parsed.attrs.get('printer-state-reasons')?.values).toEqual(['toner-low-warning', 'media-jam-error']);
    expect(parsed.attrs.get('unsupported-attribute')?.values).toEqual(['']);
  });

  it.each([0, 1, 2, 0x0400, 0x0406, 0x0503])('preserves legal status 0x%s for the caller', (status) => {
    expect(parseIppResponse(packet(printerAttributes, status)).statusCode).toBe(status);
  });

  it.each([[1, 0], [1, 1], [2, 0], [2, 1], [2, 2]])('accepts IPP version %s.%s', (major, minor) => {
    const response = packet();
    response[0] = major;
    response[1] = minor;
    expect(parseIppResponse(response).requestId).toBe(1);
  });

  it.each([[0, 0], [1, 2], [2, 3], [3, 0], [255, 255]])('rejects invalid version %s.%s', (major, minor) => {
    const response = packet();
    response[0] = major;
    response[1] = minor;
    expect(() => parseIppResponse(response)).toThrow(/版本/);
  });

  it.each([0, -1, -2147483648])('rejects invalid request ID %s', (requestId) => {
    expect(() => parseIppResponse(packet([], 0, requestId))).toThrow(/requestId/);
  });

  it('rejects every truncated prefix, including missing end-of-attributes', () => {
    const response = packet([attribute(0x21, 'marker-levels', 32), attribute(0x42, 'marker-names', 'Black')]);
    for (let length = 0; length < response.length; length += 1) {
      expect(() => parseIppResponse(response.subarray(0, length)), `prefix length ${length}`).toThrow();
    }
  });

  it('checks the name boundary before reading the value length', () => {
    expect(() => parseIppResponse(packet([Buffer.from([0x44, 0xff, 0xff])]))).toThrow(/名称/);
  });

  it('rejects a declared value beyond the buffer', () => {
    const encoded = attribute(0x44, 'reason', 'x');
    encoded.writeUInt16BE(0xffff, 3 + Buffer.byteLength('reason'));
    expect(() => parseIppResponse(packet([encoded]))).toThrow(/值长度/);
  });

  it.each([0x21, 0x23])('requires exactly four bytes for integer/enum tag %s', (tag) => {
    for (const length of [0, 1, 2, 3, 5, 8]) {
      expect(() => parseIppResponse(packet([attribute(tag, 'value', Buffer.alloc(length))]))).toThrow(/长度/);
    }
    expect(parseIppResponse(packet([attribute(tag, 'value', -3)])).attrs.get('value')?.values).toEqual([-3]);
  });

  it('validates boolean and resolution lengths instead of inventing zero', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(2), Buffer.from([2])]) {
      expect(() => parseIppResponse(packet([attribute(0x22, 'accepting', bytes)]))).toThrow();
    }
    for (const length of [0, 4, 8, 10]) {
      expect(() => parseIppResponse(packet([attribute(0x33, 'resolution', Buffer.alloc(length))]))).toThrow();
    }
    const resolution = Buffer.alloc(9);
    resolution.writeInt32BE(600);
    resolution.writeInt32BE(600, 4);
    resolution[8] = 3;
    const parsed = parseIppResponse(packet([
      attribute(0x22, 'accepting', Buffer.from([1])), attribute(0x33, 'resolution', resolution),
    ]));
    expect(parsed.attrs.get('accepting')?.values).toEqual([1]);
    expect(parsed.attrs.get('resolution')?.values).toEqual([600]);
  });

  it('requires a group before attributes and a named value after each group delimiter', () => {
    const response = packet([attribute(0x44, 'reason', 'none')]);
    expect(() => parseIppResponse(Buffer.concat([response.subarray(0, 8), response.subarray(9)]))).toThrow();
    expect(() => parseIppResponse(packet([attribute(0x44, '', 'none')]))).toThrow();
    expect(() => parseIppResponse(packet([
      attribute(0x44, 'reason', 'none'), Buffer.from([4]), attribute(0x44, '', 'media-jam'),
    ]))).toThrow(/多值属性/);
  });

  it('rejects mismatched continuation types and unsupported structural tags', () => {
    expect(() => parseIppResponse(packet([
      attribute(0x21, 'marker-levels', 50), attribute(0x44, '', 'zero'),
    ]))).toThrow(/多值属性/);
    for (const tag of [0, 0x0b, 0x34, 0x37, 0x4a, 0x7f]) {
      expect(() => parseIppResponse(packet([attribute(tag, 'value', '')]))).toThrow();
    }
  });

  it('does not treat an embedded end tag as the end and rejects trailing data', () => {
    const response = packet([attribute(0x30, 'opaque', Buffer.from([1, 3, 4]))]);
    expect(parseIppResponse(response).attrs.get('opaque')?.values).toEqual(['\x01\x03\x04']);
    expect(() => parseIppResponse(response.subarray(0, -1))).toThrow(/结束/);
    expect(() => parseIppResponse(Buffer.concat([response, Buffer.from([0])]))).toThrow(/多余数据/);
  });

  it('bounds both input bytes and attribute counts', () => {
    expect(() => parseIppResponse(Buffer.alloc(1024 * 1024 + 1))).toThrow(/长度/);
    const repeated = Array.from({ length: 16384 }, () => attribute(0x44, '', ''));
    expect(() => parseIppResponse(packet([attribute(0x44, 'value', ''), ...repeated]))).toThrow(/数量/);
  });
});

describe('IPP printer state and consumables', () => {
  it.each([
    [3, 'idle'], [4, 'printing'], [5, 'error'], [0, 'unknown'], [6, 'unknown'],
    ['3', 'unknown'], [undefined, 'unknown'],
  ])('maps state %s to %s without guessing', (raw, expected) => {
    expect(toPrinterState(stateResult(raw, ['none']))).toEqual({ state: expected, detail: null });
  });

  it.each([
    'media-empty', 'media-needed', 'media-jam', 'toner-empty', 'ink-empty', 'marker-supply-empty',
    'door-open', 'cover-open', 'interlock-open', 'paused',
  ])('recognizes blocking reason %s', (reason) => {
    expect(toPrinterState(stateResult(3, [reason]))).toEqual({ state: 'error', detail: reason });
  });

  it.each(['media-low', 'toner-low', 'ink-low', 'marker-supply-low', 'moving-to-paused'])('recognizes warning %s', (reason) => {
    expect(toPrinterState(stateResult(4, [reason]))).toEqual({ state: 'warning', detail: reason });
  });

  it.each([
    ['vendor-condition-error', 'error'], ['vendor-condition-warning', 'warning'],
    ['media-empty-warning', 'warning'], ['toner-low-error', 'error'],
    ['media-jam-report', 'printing'],
  ])('honors the explicit severity of %s', (reason, expected) => {
    expect(toPrinterState(stateResult(4, [reason])).state).toBe(expected);
  });

  it('keeps errors above warnings regardless of reason ordering or stopped state', () => {
    for (const reasons of [['toner-low-warning', 'media-jam-error'], ['media-jam-error', 'toner-low-warning']]) {
      expect(toPrinterState(stateResult(4, reasons))).toEqual({
        state: 'error', detail: 'media-jam-error; toner-low-warning',
      });
    }
    expect(toPrinterState(stateResult(5, ['toner-low-warning'])).state).toBe('error');
  });

  it('keeps report-only or unfamiliar reasons informational, preserving unknown state', () => {
    const reasons = ['none', 'warming-up', 'connecting-to-device', 'vendor-info', 'cups-waiting-for-job-completed'];
    expect(toPrinterState(stateResult(4, reasons))).toEqual({
      state: 'printing', detail: reasons.slice(1).join('; '),
    });
    expect(toPrinterState(stateResult(undefined, ['vendor-info'])).state).toBe('unknown');
    expect(toPrinterState(stateResult(undefined, ['media-jam-error'])).state).toBe('error');
    expect(toPrinterState(result())).toEqual({ state: 'unknown', detail: null });
  });

  it('ignores empty/non-string reasons and limits actual detail with errors first', () => {
    expect(toPrinterState(stateResult(3, ['', ' ', 0, 'none']))).toEqual({ state: 'idle', detail: null });
    const mapped = toPrinterState(stateResult(3, ['x'.repeat(1000), '\nMEDIA-JAM-ERROR\x00']));
    expect(mapped.state).toBe('error');
    expect(mapped.detail).toHaveLength(256);
    expect(mapped.detail?.startsWith('MEDIA-JAM-ERROR; ')).toBe(true);
    expect(mapped.detail?.endsWith('…')).toBe(true);
    expect(mapped.detail).not.toMatch(/[\x00-\x1f\x7f]/);
  });

  it('does not infer printer state from a failed IPP result', () => {
    expect(toPrinterState({ ...stateResult(3), statusCode: 0x0400 })).toEqual({ state: 'unknown', detail: null });
  });

  it('leaves negative, nonnumeric and missing levels unknown, while preserving actual zero', () => {
    const levels = [-1, -2, -3, '0', Number.NaN, Number.POSITIVE_INFINITY, 0, 75, 150];
    const supplies = toConsumables(result([
      { name: 'marker-levels', tag: 0x21, values: levels },
      { name: 'marker-names', tag: 0x42, values: ['Black', 'Cyan'] },
    ]));
    expect(supplies.map((supply) => supply.levelPct)).toEqual([null, null, null, null, null, null, 0, 75, 100]);
    expect(supplies[0]).toMatchObject({ kind: 'black', label: 'Black', current: -1, source: 'ipp' });
    expect(supplies[1]?.kind).toBe('cyan');
    expect(toConsumables(result())).toEqual([]);
  });
});

describe('IPP HTTP (127.0.0.1 only)', () => {
  it.each([0, 1, 2])('accepts success %s and sends the matching request ID and URI', async (status) => {
    const requests: Buffer[] = [];
    await withServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push(Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/ipp' });
        res.end(packet(printerAttributes, status, 123));
      });
    }, async ({ port, paths, sockets }) => {
      const response = await ippGetAttributes('127.0.0.1', { port, requestId: 123 });
      expect(response?.statusCode).toBe(status);
      expect(response?.path).toBe('/ipp/print');
      expect(paths).toEqual(['/ipp/print']);
      expect(requests).toHaveLength(1);
      const sent = parseIppResponse(requests[0]);
      expect(sent.requestId).toBe(123);
      expect(sent.attrs.get('printer-uri')?.values).toEqual([`ipp://127.0.0.1:${port}/ipp/print`]);
      expect(response && toPrinterState(response)).toEqual({ state: 'printing', detail: null });
      expect(response && toConsumables(response)[0]?.levelPct).toBeNull();
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it.each([0x0400, 0x0406, 0x0503, 0x0100, 0x0003])('does not retry IPP status %s on another path', async (status) => {
    await withServer((req, res) => {
      req.resume();
      res.end(packet(printerAttributes, status));
    }, async ({ port, paths, sockets }) => {
      expect(await ippGetAttributes('127.0.0.1', { port })).toBeNull();
      expect(paths).toEqual(['/ipp/print']);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it('closes a never-ending HTTP 404 body before trying the second fixed path', async () => {
    const uris: string[] = [];
    await withServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const parsed = parseIppResponse(Buffer.concat(chunks));
        uris.push(String(parsed.attrs.get('printer-uri')?.values[0]));
        if (req.url === '/ipp/print') {
          res.writeHead(404);
          res.flushHeaders();
        } else res.end(packet(printerAttributes));
      });
    }, async ({ port, paths, sockets }) => {
      expect((await ippGetAttributes('127.0.0.1', { port }))?.path).toBe('/ipp');
      expect(paths).toEqual(['/ipp/print', '/ipp']);
      expect(uris).toEqual([`ipp://127.0.0.1:${port}/ipp/print`, `ipp://127.0.0.1:${port}/ipp`]);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it.each([302, 401, 403, 500])('closes a never-ending HTTP %s body without changing paths', async (status) => {
    await withServer((req, res) => {
      req.resume();
      res.writeHead(status);
      res.flushHeaders();
    }, async ({ port, paths, sockets }) => {
      expect(await ippGetAttributes('127.0.0.1', { port })).toBeNull();
      expect(paths).toEqual(['/ipp/print']);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it.each(['requestId', 'version', 'end-tag', 'integer'])('rejects malformed/mismatched %s without retry', async (kind) => {
    const response = packet(printerAttributes);
    if (kind === 'requestId') response.writeInt32BE(2, 4);
    if (kind === 'version') response[0] = 0;
    const malformed = kind === 'end-tag' ? response.subarray(0, -1)
      : kind === 'integer' ? packet([attribute(0x21, 'marker-levels', Buffer.alloc(3))]) : response;
    await withServer((req, res) => {
      req.resume();
      res.end(malformed);
    }, async ({ port, paths }) => {
      expect(await ippGetAttributes('127.0.0.1', { port })).toBeNull();
      expect(paths).toEqual(['/ipp/print']);
    });
  });

  it.each(['declared', 'chunked'])('bounds a %s response to 1 MiB and closes the stream', async (kind) => {
    await withServer((req, res) => {
      req.resume();
      if (kind === 'declared') {
        res.writeHead(200, { 'Content-Length': String(1024 * 1024 + 1) });
        res.flushHeaders();
      } else {
        res.writeHead(200);
        res.write(Buffer.alloc(1024 * 1024 + 1));
      }
    }, async ({ port, paths, sockets }) => {
      expect(await ippGetAttributes('127.0.0.1', { port })).toBeNull();
      expect(paths).toEqual(['/ipp/print']);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it.each(['headers', 'body', 'drip'])('times out stalled %s and closes both attempts', async (kind) => {
    await withServer((req, res) => {
      req.resume();
      if (kind === 'headers') return;
      res.writeHead(200);
      res.flushHeaders();
      if (kind === 'drip') {
        const timer = setInterval(() => res.write(Buffer.from([0])), 10);
        res.once('close', () => clearInterval(timer));
      }
    }, async ({ port, paths, sockets }) => {
      expect(await ippGetAttributes('127.0.0.1', { port, timeoutMs: 200 })).toBeNull();
      expect(paths).toEqual(['/ipp/print', '/ipp']);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it('handles an aborted response without returning partial attributes', async () => {
    await withServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'Content-Length': '1000' });
      res.write(packet(printerAttributes), () => res.destroy());
    }, async ({ port, paths, sockets }) => {
      expect(await ippGetAttributes('127.0.0.1', { port })).toBeNull();
      expect(paths).toEqual(['/ipp/print', '/ipp']);
      await expect.poll(() => sockets.size).toBe(0);
    });
  });

  it('contains synchronous request failures and invalid options', async () => {
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new RangeError('invalid request'); });
    try {
      expect(await ippGetAttributes('127.0.0.1')).toBeNull();
      expect(request).toHaveBeenCalledTimes(1);
      for (const opts of [
        { port: 0 }, { port: 65536 }, { port: Number.NaN }, { requestId: 0 }, { requestId: -1 },
        { requestId: 1.5 }, { requestId: 0x80000000 }, { timeoutMs: 0 }, { timeoutMs: Number.POSITIVE_INFINITY },
      ]) {
        expect(await ippGetAttributes('127.0.0.1', opts)).toBeNull();
      }
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
    }
  });
});
