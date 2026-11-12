import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { FinamAuthClient } from '../src/providers/finam-auth';
import { FinamProvider, decodeFinamBars } from '../src/providers/finam';
import { commandSchema } from '../src/shared/model';

const instrument = { code: 'EURUSD', region: 'FX', name: 'Euro Dollar' };
const stamp = Date.UTC(2026, 10, 5, 10);
const bar = (time = stamp, price = '1.00000000000000000001') => ({ timestamp: new Date(time).toISOString(),
  open: { value: price }, high: { value: price }, low: { value: price }, close: { value: price }, volume: { value: '0' }, is_data_snapshot: true });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { date: new Date().toUTCString() } });
function api(handler: (path: string, options?: RequestInit) => Response = () => json({ symbol: 'EURUSD@FX', bars: [bar(), bar(stamp + 300000)] })) {
  return vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/sessions') return json({ token: 'session-jwt' });
    if (path === '/v1/sessions/details') return json({ expires_at: new Date(Date.now() + 900000).toISOString(), account_ids: ['private-account'] });
    return handler(String(url), options);
  }) as unknown as ReturnType<typeof vi.fn> & typeof fetch;
}
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

describe('Finam session and market data', () => {
  it('shares auth across concurrent requests and never returns the JWT or account IDs in Ping', async () => {
    const fetcher = api(), auth = new FinamAuthClient(fetcher);
    const results = await Promise.all([auth.check('secret'), auth.check('secret'), auth.access('secret')]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results[0]).toMatchObject({ authenticated: true, accounts: 1 });
    expect(JSON.stringify(results[0])).not.toMatch(/session-jwt|private-account|secret/);
    auth.close(); await expect(auth.access('secret')).rejects.toThrow('закрыто');
  });
  it('renews based on server expiry and replaces session on key change', async () => {
    vi.useFakeTimers();
    const fetcher = api(), auth = new FinamAuthClient(fetcher);
    await auth.access('old'); await auth.access('old'); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(850000); await auth.access('old'); expect(fetcher).toHaveBeenCalledTimes(4);
    await auth.access('new'); expect(fetcher).toHaveBeenCalledTimes(6); auth.close();
  });
  it('retries one unauthorized market-data request with a new session', async () => {
    let attempts = 0;
    const fetcher = api(() => ++attempts === 1 ? json({ message: 'secret' }, 401) : json({ symbol: 'EURUSD@FX', bars: [bar()] }));
    const provider = new FinamProvider(() => 'secret', fetcher, undefined, 0);
    expect(await provider.history(instrument, '5m', 10)).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/sessions'))).toHaveLength(2);
    expect(attempts).toBe(2); provider.close();
  });
  it('preserves decimal prices and ignores snapshot as a finality flag', () => {
    const result = decodeFinamBars([bar(stamp + 300000), bar(), bar()], '5m');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ close: '1.00000000000000000001', volume: '0', closed: true });
    expect(result[1].closed).toBe(false);
    expect(decodeFinamBars([bar()], '5m')[0].closed).toBe(false);
    expect(decodeFinamBars([bar(), bar(stamp + 300000)], '5m', false).every(c => !c.closed)).toBe(true);
  });
  it('decodes string decimals in WebSocket without converting through Number', () => {
    const raw = { ...bar(), open: '1e-7', high: '1e-7', low: '1e-7', close: '1e-7', volume: '0' };
    expect(decodeFinamBars([raw], '5m', false)[0]).toMatchObject({ close: '0.0000001', volume: '0', closed: false });
  });
  it('rejects malformed timestamps, OHLC and numeric data', () => {
    expect(() => decodeFinamBars([{ ...bar(), timestamp: 'bad' }], '5m')).toThrow();
    expect(() => decodeFinamBars([bar(stamp + 1)], '5m')).toThrow();
    expect(() => decodeFinamBars([{ ...bar(), high: { value: '0' } }], '5m')).toThrow();
    expect(() => decodeFinamBars([{ ...bar(), volume: { value: '1e9999999' } }], '5m')).toThrow();
  });
  it('passes symbol, timeframe and bounded interval; sends JWT only in header', async () => {
    const fetcher = api(), provider = new FinamProvider(() => 'secret', fetcher, undefined, 0);
    const result = await provider.history(instrument, '5m', 1);
    expect(result).toHaveLength(1); expect(result[0].closed).toBe(false);
    const [url, options] = fetcher.mock.calls.at(-1)!;
    expect(decodeURIComponent(String(url))).toContain('/EURUSD@FX/bars?timeframe=TIME_FRAME_M5');
    expect(String(url)).not.toMatch(/secret|session-jwt/);
    expect(options.headers.Authorization).toBe('session-jwt');
    expect(new URL(String(url)).searchParams.has('interval.start_time')).toBe(true);
    provider.close();
  });
  it('reports empty history as unavailable rather than an apparently working feed', async () => {
    const provider = new FinamProvider(() => 'secret', api(() => json({ symbol: 'EURUSD@FX', bars: [] })), undefined, 0);
    await expect(provider.history(instrument, '5m', 10)).rejects.toThrow('нет свечей'); provider.close();
  });
  it('rejects cross-instrument responses and unsupported native 10m', async () => {
    const provider = new FinamProvider(() => 'secret', api(() => json({ symbol: 'SBER@MISX', bars: [bar()] })), undefined, 0);
    await expect(provider.history(instrument, '5m', 10)).rejects.toThrow('другого инструмента');
    await expect(provider.history(instrument, '10m', 10)).rejects.toThrow('агрегации'); provider.close();
  });
  it.each([400, 401, 403, 404, 429, 503])('maps HTTP %i without exposing response bodies', async status => {
    const provider = new FinamProvider(() => 'secret', api(() => json({ message: 'secret' }, status)), undefined, 0);
    try { await provider.history(instrument, '5m', 1); throw new Error('should fail'); }
    catch (error) { expect(String(error)).toContain('Finam'); expect(String(error)).not.toContain('secret'); }
    provider.close();
  });
  it('paginates a catalog, preserves MIC and coalesces concurrent searches', async () => {
    let page = 0;
    const fetcher = api(() => json(++page === 1 ? { assets: [{ symbol: 'EURUSD@FX', name: 'EUR/USD' }, { symbol: 'BAD@' }], next_cursor: '123' }
      : { assets: [{ symbol: '#EURUSD@_FX', name: 'Indicative' }, { symbol: 'OLD@FX', is_archived: true }], next_cursor: '0' }));
    const provider = new FinamProvider(() => 'secret', fetcher, undefined, 0);
    const [first, second] = await Promise.all([provider.search('EUR/USD'), provider.search('eurusd')]);
    expect(first).toEqual(second); expect(first).toHaveLength(2); expect(first[0].region).toBe('FX');
    expect(fetcher).toHaveBeenCalledTimes(4);
    await provider.search('EURUSD'); expect(fetcher).toHaveBeenCalledTimes(4); provider.close();
  });
  it('rejects repeating pagination cursors', async () => {
    const provider = new FinamProvider(() => 'secret', api(() => json({ assets: [], next_cursor: '123' })), undefined, 0);
    await expect(provider.search('')).rejects.toThrow('курсор'); provider.close();
  });
  it('resolves an exact symbol without loading the entire catalog', async () => {
    const fetcher = api(() => json({ ticker: 'EURUSD', mic: 'FX', name: 'Euro Dollar' }));
    const provider = new FinamProvider(() => 'secret', fetcher, undefined, 0);
    expect(await provider.search('EURUSD@FX')).toEqual([instrument]); expect(fetcher).toHaveBeenCalledTimes(3); provider.close();
  });
  it('keeps #WWCP Forex instruments in the catalog and encodes # in REST paths', async () => {
    const fetcher = api(url => {
      if (url.includes('/assets/all?')) return json({ assets: [{ symbol: 'EURUSD@#WWCP', ticker: 'EURUSD', mic: '#WWCP', type: 'CURRENCIES', name: 'EUR/USD' }], next_cursor: '0' });
      if (url.includes('/bars?')) return json({ symbol: 'EURUSD@#WWCP', bars: [bar()] });
      return json({ ticker: 'EURUSD', mic: '#WWCP', name: 'EUR/USD' });
    });
    const provider = new FinamProvider(() => 'secret', fetcher, undefined, 0);
    const matches = await provider.search('EURUSD');
    expect(matches).toEqual([{ code: 'EURUSD', region: '#WWCP', name: 'EUR/USD' }]);
    expect(await provider.search('EURUSD@#WWCP')).toEqual(matches);
    expect(await provider.history(matches[0], '5m', 10)).toHaveLength(1);
    const url = String(fetcher.mock.calls.at(-1)![0]);
    expect(url).toContain('EURUSD%40%23WWCP/bars'); expect(new URL(url).hash).toBe('');
    expect(commandSchema.safeParse({ type: 'addPair', source: 'finam', ...matches[0] }).success).toBe(true);
    provider.close();
  });
  it('accepts Finam symbols with MIC at the IPC boundary', () => {
    expect(commandSchema.safeParse({ type: 'addPair', source: 'finam', ...instrument }).success).toBe(true);
    expect(commandSchema.safeParse({ type: 'addPair', source: 'finam', ...instrument, code: 'EURUSD@FX' }).success).toBe(false);
  });
});

class Socket extends EventEmitter {
  readyState = 1;
  send = vi.fn(); ping = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.emit('close'); });
  terminate = this.close;
}
describe('Finam candle stream lifecycle', () => {
  it('waits for handshake, filters symbols, keeps updates provisional and stops reconnecting after unsubscribe', async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const factory = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; });
    const provider = new FinamProvider(() => 'secret', api(), factory, 0), onBar = vi.fn();
    const stop = provider.subscribe(instrument, '5m', onBar, vi.fn());
    await flush(); expect(sockets).toHaveLength(1);
    const socket = sockets[0]; socket.emit('open'); expect(socket.send).not.toHaveBeenCalled();
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'EVENT', event_info: { event: 'HANDSHAKE_SUCCESS' } })));
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({ action: 'SUBSCRIBE', type: 'BARS', data: { symbol: 'EURUSD@FX', timeframe: 'TIME_FRAME_M5' }, token: 'session-jwt' });
    const update = (symbol: string) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'DATA', subscription_type: 'BARS', payload: { symbol, bars: [bar(), bar(stamp + 300000)] } })));
    update('OTHER@FX'); expect(onBar).not.toHaveBeenCalled(); update('EURUSD@FX');
    expect(onBar).toHaveBeenCalledTimes(2); expect(onBar.mock.calls.every(([update]) => !update.candle.closed)).toBe(true);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'DATA', subscription_type: 'BARS', payload: JSON.stringify({ symbol: 'EURUSD@FX', bars: [bar()] }) })));
    expect(onBar).toHaveBeenCalledTimes(3);
    socket.close(); await vi.advanceTimersByTimeAsync(1000); await flush(); expect(sockets).toHaveLength(2);
    stop(); await vi.advanceTimersByTimeAsync(60000); expect(sockets).toHaveLength(2); provider.close();
  });
  it.each([
    [{ type: 'ERROR', error_info: { code: 16, type: 'AUTH_ERROR' } }, true],
    [{ type: 'DATA', subscription_type: 'BARS', payload: { error: { code: 14 } } }, false],
    [{ type: 'DATA', subscription_type: 'BARS', payload: JSON.stringify({ error: { code: 16 } }) }, true],
  ] as const)('recovers from protocol errors and renews rejected credentials', async (message, renew) => {
    vi.useFakeTimers();
    const sockets: Socket[] = [], fetcher = api();
    const factory = () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; };
    const provider = new FinamProvider(() => 'secret', fetcher, factory, 0), status = vi.fn();
    const stop = provider.subscribe(instrument, '5m', vi.fn(), status);
    await flush(); sockets[0].emit('open');
    sockets[0].emit('message', Buffer.from(JSON.stringify(message)));
    expect(sockets[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(sockets).toHaveLength(2);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/sessions'))).toHaveLength(renew ? 2 : 1);
    expect(status).toHaveBeenCalled(); stop(); provider.close();
  });
  it('does not open sockets after close while authorization is pending', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(r => { resolve = r; })) as typeof fetch;
    const factory = vi.fn(() => new Socket() as unknown as WebSocket);
    const provider = new FinamProvider(() => 'secret', fetcher, factory, 0);
    provider.subscribe(instrument, '5m', vi.fn(), vi.fn()); provider.close();
    resolve(json({ token: 'session-jwt' })); await flush(); expect(factory).not.toHaveBeenCalled();
  });
});

// Small public responses recorded from SBER@MISX on 2026-11-05, without auth/account fields.
import { readFileSync } from 'node:fs';
import { finamTimeframes } from '../src/providers/finam';
import type { Timeframe } from '../src/shared/model';
describe('recorded public Finam contracts', () => {
  it.each(Object.entries(finamTimeframes))('decodes recorded REST %s', (timeframe, name) => {
    const payload = JSON.parse(readFileSync(new URL(`./fixtures/finam/rest-${name}.json`, import.meta.url), 'utf8'));
    const bars = decodeFinamBars(payload.bars, timeframe as Timeframe);
    expect(payload.symbol).toBe('SBER@MISX'); expect(bars).toHaveLength(3);
    expect(bars[0].closed).toBe(true); expect(bars.at(-1)!.closed).toBe(false);
  });
  it('accepts recorded string-wrapped WebSocket payload', () => {
    const envelope = JSON.parse(readFileSync(new URL('./fixtures/finam/websocket-bars.json', import.meta.url), 'utf8'));
    expect(typeof envelope.payload).toBe('string');
    const payload = JSON.parse(envelope.payload);
    expect(payload.symbol).toBe('SBER@MISX');
    expect(decodeFinamBars(payload.bars, '1m', false).every(c => !c.closed)).toBe(true);
  });
});
