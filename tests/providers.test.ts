import { describe, it, expect, vi } from 'vitest';
import { ItickProvider, decodeItickBars } from '../src/providers/itick';
import { RequestScheduler } from '../src/providers/contracts';
import { aggregate, normalizeCandles } from '../src/core/candles';
import { MarketDataService } from '../src/service/market-data';
import { bars } from './fixtures';
import type { Candle } from '../src/shared/model';
import type { DataProvider, BarUpdate } from '../src/providers/contracts';

const raw = (t: number, c = '1.00000000000000000001') => ({ t, o: c, c, h: c, l: c, v: 12 });
describe('iTick adapter', () => {
  it('normalizes sorting, duplicates and conservative candle finality', () => {
    const result = decodeItickBars([raw(300000), raw(0), raw(300000, '2')], '5m');
    expect(result).toHaveLength(2); expect(result[0].close).toBe('1.00000000000000000001');
    expect(result[0].closed).toBe(true); expect(result[1].closed).toBe(false); expect(result[1].close).toBe('2');
  });
  it('rejects invalid OHLC and unknown timestamp boundaries', () => {
    expect(() => decodeItickBars([{ ...raw(0), h: '0' }], '5m')).toThrow();
    expect(() => decodeItickBars([raw(60001)], '5m')).toThrow();
  });
  it('keeps numeric JSON precision without passing Number through the core', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"code":0,"data":[{"t":0,"o":1.00000000000000000001,"h":1.00000000000000000001,"l":1.00000000000000000001,"c":1.00000000000000000001,"v":0}]}'));
    const provider = new ItickProvider('test-token', false, fetcher as typeof fetch, new RequestScheduler(0));
    const result = await provider.history({ code: 'EURUSD', name: 'EUR/USD', region: 'GB' }, '5m', 100);
    expect(result[0].close).toBe('1.00000000000000000001'); expect(result[0].volume).toBe('0');
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain('kType=2'); expect(String(url)).not.toContain('test-token'); expect(options.headers.token).toBe('test-token');
  });
  it('maps catalog fields instead of leaking vendor objects to UI', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: [{ c: 'EURUSD', n: 'Euro Dollar', e: 'FX', t: 'forex', extra: 'ignored' }] })));
    const provider = new ItickProvider('secret', true, fetcher as typeof fetch, new RequestScheduler(0));
    expect(await provider.search('EURUSD')).toEqual([{ code: 'EURUSD', name: 'Euro Dollar', region: 'GB' }]);
    expect(fetcher.mock.calls[0][0]).toContain('api-free.itick.io/symbol/list');
  });
  it('accepts scientific JSON notation used by real iTick volumes without losing price digits', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"code":0,"data":[{"t":3E+5,"o":1.00000000000000000001E+0,"h":1.00000000000000000001E+0,"l":1.00000000000000000001E+0,"c":1.00000000000000000001E+0,"v":5.21E+3},{"t":6e5,"o":1e-7,"h":1e-7,"l":1e-7,"c":1e-7,"v":3.94E+3}]}'));
    const provider = new ItickProvider('secret', true, fetcher as typeof fetch, new RequestScheduler(0));
    const result = await provider.history({ code: 'EURUSD', name: 'pair', region: 'GB' }, '5m', 100);
    expect(result[0]).toMatchObject({ openTime: 300000, close: '1.00000000000000000001', volume: '5210', closed: true });
    expect(result[1]).toMatchObject({ close: '0.0000001', volume: '3940', closed: false });
  });
  it.each(['NaN', 'Infinity', '1e1000000', 'not-a-number', true])('rejects invalid numeric data %s without echoing the value', value => {
    expect(() => decodeItickBars([{ ...raw(0), v: value }], '5m')).toThrow(/поле v/);
  });
  it.each([401, 403, 429, 503])('maps HTTP %s without echoing response secrets', async status => {
    const provider = new ItickProvider('super-secret', false,
      vi.fn().mockResolvedValue(new Response('super-secret', { status })) as typeof fetch, new RequestScheduler(0));
    await expect(provider.search('')).rejects.toThrow(/iTick/);
    try { await provider.search(''); } catch (e) { expect(String(e)).not.toContain('super-secret'); }
  });
  it('does not treat HTTP 200 with API error as data', async () => {
    const provider = new ItickProvider('secret', false,
      vi.fn().mockResolvedValue(new Response('{"code":403,"msg":"secret"}')) as typeof fetch, new RequestScheduler(0));
    await expect(provider.search('')).rejects.toThrow('код 403');
  });
  it('paginates older history with et and closes bars across page boundaries', async () => {
    const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => raw((start + i) * 300000));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: page(500, 500) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: page(0, 500) })));
    const provider = new ItickProvider('secret', true, fetcher as typeof fetch, new RequestScheduler(0));
    const result = await provider.history({ code: 'EURUSD', name: 'pair', region: 'GB' }, '5m', 1000);
    expect(result).toHaveLength(1000); expect(result[0].openTime).toBe(0);
    expect(result[499].closed).toBe(true); expect(result[500].closed).toBe(true); expect(result[999].closed).toBe(false);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('et')).toBe(String(500 * 300000 - 1));
  });
  it('deduplicates overlapping pages and requests the still-missing history', async () => {
    const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => raw((start + i) * 300000));
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: page(500, 500) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: page(1, 500) })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: page(0, 2) })));
    const provider = new ItickProvider('secret', true, fetcher as typeof fetch, new RequestScheduler(0));
    const result = await provider.history({ code: 'EURUSD', name: 'pair', region: 'GB' }, '5m', 1000);
    expect(result).toHaveLength(1000); expect(new Set(result.map(c => c.openTime)).size).toBe(1000);
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('limit')).toBe('1');
  });
  it('terminates when a server repeats a page without progress', async () => {
    const data = Array.from({ length: 500 }, (_, i) => raw((i + 500) * 300000));
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ code: 0, data })));
    const provider = new ItickProvider('secret', true, fetcher as typeof fetch, new RequestScheduler(0));
    expect(await provider.history({ code: 'EURUSD', name: 'pair', region: 'GB' }, '5m', 1000)).toHaveLength(500);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
describe('common candle data service', () => {
  it('loads 2m from shared 1m data and keeps incomplete or missing minutes provisional', async () => {
    const input = bars([1, 3, 2, 4, 5], '1m');
    input.at(-1)!.closed = false;
    const history = vi.fn(async () => input), subscribe = vi.fn<NonNullable<DataProvider['subscribe']>>(() => () => {});
    const provider: DataProvider = { id: 'test', name: 'test', capabilities: { nativeTimeframes: ['1m'], volume: 'reported', stream: true, calendar: 'unverified' },
      history, subscribe, search: async () => [], now: Date.now, close: () => {} };
    const service = new MarketDataService(new Map([['test', provider]]), () => {});
    const pair = { id: 'p', code: 'EURUSD', region: 'GB', name: 'pair', source: 'test' };
    const result = await service.load(pair, '2m', false, 2);
    expect(history).toHaveBeenCalledWith(pair, '1m', 6);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe.mock.calls[0]?.[1]).toBe('1m');
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ openTime: 0, closeTime: 120000, open: '1', high: '3', low: '1', close: '3', volume: '20', closed: true });
    expect(result[2].closed).toBe(false);
    await service.load(pair, '1m', false, 2);
    expect(history).toHaveBeenCalledTimes(1);
    input.splice(1, 1);
    const refreshed = await service.load(pair, '2m', true, 2);
    expect(refreshed[0].closed).toBe(false);
    service.close();
  });
  it('aggregates full 5m bars to 10m and preserves open incomplete intervals', () => {
    const result = aggregate(bars([1, 3, 2]), '5m', '10m');
    expect(result[0]).toMatchObject({ open: '1', high: '3', low: '1', close: '3', volume: '20', closed: true });
    expect(result[1].closed).toBe(false);
  });
  it('does not close an aggregate through a missing source bar or missing volume', () => {
    const input = bars([1, 2, 3]); input[0].volume = null;
    expect(aggregate(input, '5m', '10m')[0].volume).toBeNull();
    expect(aggregate([input[1]], '5m', '10m')[0].closed).toBe(false);
  });
  it('rejects negative volume and invalid bounds', () => {
    expect(() => normalizeCandles([{ ...bars([1])[0], volume: '-1' }])).toThrow();
  });
  it('deduplicates shared requests and ignores stale callbacks after pruning', async () => {
    let callback: ((update: BarUpdate) => void) | undefined;
    const stop = vi.fn(), history = vi.fn(async () => bars([1, 2]));
    const provider: DataProvider = { id: 'third-provider', name: 'third', capabilities: { nativeTimeframes: ['5m'], volume: 'unavailable', stream: true, calendar: 'unverified' },
      history, search: async () => [], now: () => 600000, close: vi.fn(), subscribe: (_i, _t, cb) => { callback = cb; return stop; } };
    const changed = vi.fn(), service = new MarketDataService(new Map([[provider.id, provider]]), changed);
    const pair = { id: 'p', code: 'EURUSD', region: 'GB', name: 'pair', source: provider.id };
    await Promise.all([service.load(pair, '5m'), service.load(pair, '5m')]);
    expect(history).toHaveBeenCalledTimes(1);
    service.prune(new Set()); const before = changed.mock.calls.length;
    callback?.({ candle: bars([3])[0], sourceTime: 900000 });
    expect(service.cached(pair, '5m')).toEqual([]); expect(changed).toHaveBeenCalledTimes(before); expect(stop).toHaveBeenCalledTimes(1);
  });
  it('never treats a last partial close as final merely because a successor arrived', async () => {
    let callback!: (update: BarUpdate) => void;
    const input = [{ ...bars([1])[0], closed: false }];
    const history = vi.fn(async () => input);
    const provider: DataProvider = { id: 'test', name: 'test', capabilities: { nativeTimeframes: ['5m'], volume: 'reported', stream: true, calendar: 'unverified' },
      history, search: async () => [], now: Date.now, close: () => {}, subscribe: (_i, _t, cb) => { callback = cb; return () => {}; } };
    const service = new MarketDataService(new Map([['test', provider]]), () => {});
    const pair = { id: 'p', code: 'EURUSD', region: 'GB', name: 'pair', source: 'test' };
    await service.load(pair, '5m');
    callback({ candle: { ...bars([1, 2])[1], closed: false }, sourceTime: 600000 });
    expect(service.cached(pair, '5m')[0].closed).toBe(false);
    input.splice(0, input.length, { ...bars([9])[0], closed: true }, { ...bars([1, 2])[1], closed: false });
    await service.load(pair, '5m');
    expect(history).toHaveBeenCalledTimes(2);
    expect(service.cached(pair, '5m')[0]).toMatchObject({ close: '9', closed: true });
    service.close();
  });
});
