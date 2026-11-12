import { afterEach, describe, expect, it, vi } from 'vitest';
import { FinamAuthClient } from '../src/providers/finam-auth';
import { FinamProvider } from '../src/providers/finam';

const epoch = Date.UTC(2026, 10, 5, 15);
function server({ date = true, lifetime = 900000, malformedClock = false }: { date?: boolean; lifetime?: number; malformedClock?: boolean } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const now = epoch + performance.now(), path = new URL(String(input)).pathname;
    const body = path === '/v1/sessions' ? { token: 'private-jwt' }
      : path === '/v1/sessions/details' ? { expires_at: new Date(now + lifetime).toISOString(), account_ids: ['private-id'] }
      : path === '/v1/assets/clock' ? { timestamp: malformedClock ? 'bad' : new Date(now).toISOString() }
      : { symbol: 'EURUSD@#WWCP', bars: [{ timestamp: new Date(epoch).toISOString(),
        open: { value: '1' }, high: { value: '1' }, low: { value: '1' }, close: { value: '1' }, volume: { value: '1' } }] };
    return new Response(JSON.stringify(body), { headers: date ? { date: new Date(now).toUTCString() } : {} });
  });
}
afterEach(() => vi.useRealTimers());
describe('Finam session server clock', () => {
  it.each([86400000, -86400000, 3 * 3600000])('accepts a valid session when PC clock offset is %i ms', async offset => {
    vi.useFakeTimers(); vi.setSystemTime(epoch + offset);
    const fetcher = server(), client = new FinamAuthClient(fetcher);
    const result = await client.check('private-secret');
    expect(result.authenticated).toBe(true); expect(client.now()).toBe(epoch);
    expect(JSON.stringify(result)).not.toMatch(/private-/);
    await client.access('private-secret'); expect(fetcher).toHaveBeenCalledTimes(2); client.close();
  });
  it('renews with monotonic elapsed time even when the local clock changes', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    const fetcher = server(), client = new FinamAuthClient(fetcher);
    const initial = await client.access('secret');
    vi.setSystemTime(epoch + 3 * 86400000);
    expect(await client.access('secret')).toBe(initial); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(850000);
    expect(client.remaining(initial)).toBe(50000);
    await client.access('secret'); expect(fetcher).toHaveBeenCalledTimes(4); client.close();
  });
  it('uses authenticated Clock if HTTP Date is absent and the local clock is ahead', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch + 86400000);
    const fetcher = server({ date: false }), client = new FinamAuthClient(fetcher);
    expect((await client.check('secret')).authenticated).toBe(true);
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/v1/sessions', '/v1/sessions/details', '/v1/assets/clock']);
    expect(client.now()).toBe(epoch); client.close();
  });
  it('refreshes the fallback Clock for each new session', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch + 86400000);
    const fetcher = server({ date: false }), client = new FinamAuthClient(fetcher);
    await client.check('secret'); await vi.advanceTimersByTimeAsync(1000); await client.check('secret');
    expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/clock'))).toHaveLength(2);
    expect(client.now()).toBe(epoch + 1000); client.close();
  });
  it('revalidates an explicit Ping and surfaces server revocation instead of trusting a cached JWT', async () => {
    const normal = server(); let revoked = false;
    const fetcher = vi.fn(async (input: string | URL | Request) => revoked ? new Response('{}', { status: 401 }) : normal(input));
    const client = new FinamAuthClient(fetcher);
    await client.check('secret'); revoked = true;
    await expect(client.check('secret')).rejects.toThrow('токен недействителен');
    expect(fetcher).toHaveBeenCalledTimes(3); client.close();
  });
  it('does not silently accept a genuinely expired token or loop forever', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch - 86400000);
    const fetcher = server({ lifetime: -10000 }), client = new FinamAuthClient(fetcher);
    await expect(client.check('secret')).rejects.toThrow('дважды вернул истёкшую');
    expect(fetcher).toHaveBeenCalledTimes(4); client.close();
  });
  it('retries a stale session returned by the server once and accepts the fresh one', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch);
    let details = 0;
    const normal = server();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === '/v1/sessions/details' && ++details === 1) {
        return new Response(JSON.stringify({ expires_at: new Date(epoch - 1000).toISOString() }), { headers: { date: new Date(epoch).toUTCString() } });
      }
      return normal(input);
    });
    const client = new FinamAuthClient(fetcher);
    expect((await client.check('secret')).authenticated).toBe(true); expect(fetcher).toHaveBeenCalledTimes(4); client.close();
  });
  it('rejects malformed server time instead of falling back to an unchecked success', async () => {
    const client = new FinamAuthClient(server({ date: false, malformedClock: true }));
    await expect(client.check('secret')).rejects.toThrow('серверное время'); client.close();
  });
  it('builds the initial historical interval from Finam time after authorization', async () => {
    vi.useFakeTimers(); vi.setSystemTime(epoch + 86400000);
    const fetcher = server(), provider = new FinamProvider(() => 'secret', fetcher, undefined, 0);
    await provider.history({ code: 'EURUSD', name: 'EUR/USD', region: '#WWCP' }, '5m', 10);
    const url = new URL(String(fetcher.mock.calls.at(-1)![0]));
    expect(url.searchParams.get('interval.end_time')).toBe(new Date(epoch).toISOString());
    expect(provider.now()).toBe(epoch); provider.close();
  });
});
