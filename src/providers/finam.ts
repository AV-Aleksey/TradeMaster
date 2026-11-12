import Decimal from 'decimal.js';
import WebSocket from 'ws';
import { normalizeCandles, validateCandle } from '../core/candles';
import { intervalMs, type Candle, type Timeframe, type SourceTestResult } from '../shared/model';
import { ProviderError, RequestScheduler, type BarUpdate, type DataProvider, type Instrument } from './contracts';
import { FinamAuthClient } from './finam-auth';

export const finamTimeframes: Partial<Record<Timeframe, string>> = {
  '1m': 'TIME_FRAME_M1', '5m': 'TIME_FRAME_M5', '15m': 'TIME_FRAME_M15',
  '30m': 'TIME_FRAME_M30', '1h': 'TIME_FRAME_H1', '1d': 'TIME_FRAME_D',
};
const codePattern = /^[^\s@\x00-\x1f]{1,64}$/;
const micPattern = /^[A-Za-z0-9_#-]{1,16}$/;
export function finamSymbol(instrument: Instrument): string {
  if (!codePattern.test(instrument.code) || !micPattern.test(instrument.region)) throw new ProviderError('unsupported', 'Finam: укажите тикер и MIC площадки из каталога');
  return `${instrument.code}@${instrument.region}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('invalidData', 'Finam: некорректный формат данных');
  return value as Record<string, unknown>;
}
function decimal(value: unknown): string {
  const raw = typeof value === 'string' ? value : object(value).value;
  if (typeof raw !== 'string' || raw.length > 2048 || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) throw new ProviderError('invalidData', 'Finam: некорректное число');
  const result = new Decimal(raw);
  if (!result.isFinite() || Math.abs(result.e) > 1000) throw new ProviderError('invalidData', 'Finam: число вне допустимого диапазона');
  return result.toFixed();
}
export function decodeFinamBars(payload: unknown, timeframe: Timeframe, historical = true): Candle[] {
  if (!Array.isArray(payload)) throw new ProviderError('invalidData', 'Finam: нет списка свечей');
  const duration = intervalMs[timeframe];
  const bars = payload.map(raw => {
    const bar = object(raw);
    const stamp = bar.timestamp;
    const openTime = typeof stamp === 'string' ? Date.parse(stamp) : Number(object(stamp).seconds) * 1000 + Number(object(stamp).nanos ?? 0) / 1e6;
    if (!Number.isSafeInteger(openTime) || (timeframe !== '1d' && openTime % duration !== 0)) throw new ProviderError('invalidData', 'Finam: время свечи не соответствует периоду');
    const candle: Candle = { openTime, closeTime: openTime + duration, open: decimal(bar.open), high: decimal(bar.high),
      low: decimal(bar.low), close: decimal(bar.close), volume: bar.volume == null ? null : decimal(bar.volume), closed: false };
    try { validateCandle(candle); } catch { throw new ProviderError('invalidData', 'Finam: некорректная свеча'); }
    return candle;
  });
  const sorted = normalizeCandles(bars);
  // Snapshot is not a finality flag. Streaming bars remain provisional until REST reconciliation.
  return sorted.map((bar, i) => ({ ...bar, closed: historical && i < sorted.length - 1 }));
}
export function decodeFinamAsset(raw: unknown): Instrument {
  const asset = object(raw);
  const symbol = typeof asset.symbol === 'string' ? asset.symbol.split('@') : [asset.ticker, asset.mic];
  const [code, region] = symbol;
  if (symbol.length !== 2 || typeof code !== 'string' || typeof region !== 'string') throw new ProviderError('unsupported', 'Finam: инструмент без пригодного тикера и MIC');
  finamSymbol({ code, region, name: '' });
  return { code, region, name: typeof asset.name === 'string' && asset.name ? asset.name.slice(0, 100) : code };
}

export class FinamProvider implements DataProvider {
  readonly id = 'finam';
  readonly name = 'Finam';
  readonly capabilities = { nativeTimeframes: Object.keys(finamTimeframes) as Timeframe[], volume: 'reported' as const,
    stream: true, calendar: 'unverified' as const };
  private readonly auth: FinamAuthClient;
  private readonly queues = new Map<string, RequestScheduler>();
  private readonly subscriptions = new Set<() => void>();
  private catalog?: { secret: string; at: number; promise: Promise<Instrument[]> };
  private stopped = false;
  constructor(private readonly token: () => string, fetcher: typeof fetch = fetch,
    private readonly socketFactory: (url: string) => WebSocket = url => new WebSocket(url, { handshakeTimeout: 10000 }), private readonly requestGapMs = 350) {
    this.auth = new FinamAuthClient(fetcher);
  }
  private queue(method: string): RequestScheduler {
    if (!this.queues.has(method)) this.queues.set(method, new RequestScheduler(this.requestGapMs));
    return this.queues.get(method)!;
  }
  private assertCurrent(secret: string): void {
    if (this.stopped) throw new ProviderError('unavailable', 'Finam: подключение закрыто');
    if (this.token() !== secret) throw new ProviderError('unauthorized', 'Ключ Finam изменён. Повторите запрос');
  }
  private async request(method: string, path: string): Promise<Record<string, unknown>> {
    const secret = this.token();
    return this.queue(method).run(async () => {
      this.assertCurrent(secret);
      let session = await this.auth.access(secret);
      this.assertCurrent(secret);
      if (method === 'GetAsset') {
        const account = session.accountIds[0];
        if (!account) throw new ProviderError('forbidden', 'Finam: в сессии нет счёта для проверки инструмента');
        path += `?account_id=${encodeURIComponent(account)}`;
      }
      let body: Record<string, unknown>;
      try { body = await this.auth.request(path, undefined, session.token); }
      catch (error) {
        if (!(error instanceof ProviderError) || error.kind !== 'unauthorized') throw error;
        this.auth.invalidate(session.token);
        this.assertCurrent(secret);
        session = await this.auth.access(secret);
        this.assertCurrent(secret);
        body = await this.auth.request(path, undefined, session.token);
      }
      this.assertCurrent(secret);
      return body;
    });
  }
  async ping(): Promise<SourceTestResult> {
    const secret = this.token();
    const result = await this.auth.check(secret);
    this.assertCurrent(secret);
    return result;
  }
  async history(instrument: Instrument, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    if (!finamTimeframes[timeframe]) throw new ProviderError('unsupported', 'Finam: период требует локальной агрегации');
    const secret = this.token();
    await this.auth.access(secret);
    this.assertCurrent(secret);
    const symbol = finamSymbol(instrument), end = this.now();
    const depth = (timeframe === '1m' ? 7 : timeframe === '1d' ? 365 : 30) * 86400000;
    // Bound the request by documented retention; weekends and breaks need extra calendar time.
    const count = Math.max(1, Math.min(10000, Math.ceil(limit)));
    const span = Math.min(depth - 1000, Math.max(7 * 86400000 - 1000, count * intervalMs[timeframe] * 3));
    const query = new URLSearchParams({ timeframe: finamTimeframes[timeframe]!,
      'interval.start_time': new Date(end - span).toISOString(), 'interval.end_time': new Date(end).toISOString() });
    const body = await this.request('Bars', `/v1/instruments/${encodeURIComponent(symbol)}/bars?${query}`);
    if (body.symbol !== symbol) throw new ProviderError('invalidData', 'Finam: ответ для другого инструмента');
    const bars = decodeFinamBars(body.bars ?? [], timeframe).slice(-count);
    if (!bars.length) throw new ProviderError('unavailable', 'Finam: нет свечей за запрошенный период. Проверьте инструмент, площадку и доступ к данным');
    return bars;
  }
  async search(query: string): Promise<Instrument[]> {
    const needle = query.trim();
    // Exact identifiers avoid downloading the complete catalog for manual entry.
    if (needle.includes('@')) return [decodeFinamAsset(await this.request('GetAsset', `/v1/assets/${encodeURIComponent(needle)}`))];
    const secret = this.token();
    if (!this.catalog || this.catalog.secret !== secret || Date.now() - this.catalog.at > 300000) {
      const promise = this.loadCatalog();
      const entry = { secret, at: Date.now(), promise }; this.catalog = entry;
      void promise.catch(() => { if (this.catalog === entry) this.catalog = undefined; });
    }
    const assets = await this.catalog.promise;
    this.assertCurrent(secret);
    const normalized = needle.toUpperCase().replaceAll('/', '');
    return assets.filter(a => `${a.code}@${a.region} ${a.name}`.toUpperCase().replaceAll('/', '').includes(normalized)).slice(0, 100);
  }
  private async loadCatalog(): Promise<Instrument[]> {
    const assets = new Map<string, Instrument>(), seen = new Set<string>();
    let cursor = '0';
    for (let page = 0; page < 1000; page++) {
      const body = await this.request('AllAssets', `/v1/assets/all?only_active=true&cursor=${encodeURIComponent(cursor)}`);
      if (!Array.isArray(body.assets)) throw new ProviderError('invalidData', 'Finam: нет каталога инструментов');
      for (const raw of body.assets) {
        if (object(raw).is_archived === true) continue;
        try {
          const asset = decodeFinamAsset(raw); assets.set(finamSymbol(asset), asset);
        } catch (error) {
          // Some catalog records have no usable ticker/MIC; they cannot be requested as bars.
          if (!(error instanceof ProviderError) || error.kind !== 'unsupported') throw error;
        }
      }
      const next = String(body.next_cursor ?? '0');
      if (next === '0') return [...assets.values()];
      if (!/^\d+$/.test(next) || seen.has(next)) throw new ProviderError('invalidData', 'Finam: каталог повторяет курсор');
      seen.add(next); cursor = next;
    }
    throw new ProviderError('invalidData', 'Finam: превышено число страниц каталога');
  }
  subscribe(instrument: Instrument, timeframe: Timeframe, onBar: (update: BarUpdate) => void, onStatus: (status: string) => void): () => void {
    const symbol = finamSymbol(instrument);
    if (!finamTimeframes[timeframe]) throw new ProviderError('unsupported', 'Finam: поток этого периода недоступен');
    let active = true, socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined;
    let renewal: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    let attempts = 0;
    const clear = () => { if (renewal) clearTimeout(renewal); if (heartbeat) clearInterval(heartbeat); };
    const reconnect = () => {
      clear();
      if (!active || this.stopped) return;
      onStatus('Finam: поток отключён; REST-сверка и переподключение');
      retry = setTimeout(() => { void connect(); }, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)));
    };
    const connect = async () => {
      const secret = this.token();
      try {
        const session = await this.auth.access(secret);
        this.assertCurrent(secret);
        if (!active) return;
        const current = this.socketFactory('wss://api.finam.ru/ws'); socket = current;
        let subscribed = false, alive = true;
        let handshake: ReturnType<typeof setTimeout> | undefined;
        const send = () => {
          if (subscribed || current.readyState !== WebSocket.OPEN) return;
          subscribed = true;
          current.send(JSON.stringify({ action: 'SUBSCRIBE', type: 'BARS', data: { symbol, timeframe: finamTimeframes[timeframe] }, token: session.token }));
        };
        current.on('open', () => {
          if (!active) { current.close(); return; }
          handshake = setTimeout(() => current.close(), 4500);
          heartbeat = setInterval(() => { if (!alive) { current.terminate(); return; } alive = false; current.ping(); }, 25000);
          renewal = setTimeout(() => current.close(), Math.max(1000, this.auth.remaining(session) - 30000));
        });
        current.on('pong', () => { alive = true; });
        current.on('message', bytes => {
          if (!active || socket !== current || this.token() !== secret) return;
          try {
            const message = object(JSON.parse(bytes.toString()));
            if (message.type === 'EVENT') {
              if (object(message.event_info).event === 'HANDSHAKE_SUCCESS') { if (handshake) clearTimeout(handshake); send(); }
              return;
            }
            if (message.type === 'ERROR') {
              const info = object(message.error_info);
              if ([16, 401, '16', '401'].includes(info.code as number | string) || /auth|token/i.test(String(info.type ?? ''))) this.auth.invalidate(session.token);
              onStatus('Finam: ошибка подписки; используется REST'); current.close(); return;
            }
            if (message.type !== 'DATA' || message.subscription_type !== 'BARS') return;
            // Production currently wraps the protobuf JSON in a JSON string.
            const payload = object(typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload);
            if (payload.error && Number(object(payload.error).code) !== 0) {
              if ([16, 401].includes(Number(object(payload.error).code))) this.auth.invalidate(session.token);
              onStatus('Finam: ошибка данных подписки; REST-сверка и переподключение'); current.close(); return;
            }
            if (payload.symbol !== symbol) return;
            const bars = decodeFinamBars(payload.bars ?? [], timeframe, false);
            attempts = 0;
            for (const candle of bars) { if (!active) break; onBar({ candle, sourceTime: this.now() }); }
          } catch { onStatus('Finam: некорректный поток; требуется REST-сверка'); current.close(); }
        });
        current.on('error', () => { /* close schedules retry; never expose transport errors containing credentials */ });
        current.on('close', () => { if (handshake) clearTimeout(handshake); if (socket === current) { socket = undefined; reconnect(); } });
      } catch { reconnect(); }
    };
    const stop = () => { active = false; if (retry) clearTimeout(retry); clear(); socket?.close(); this.subscriptions.delete(stop); };
    this.subscriptions.add(stop); void connect();
    return stop;
  }
  now(): number { return this.auth.now(); }
  close(): void { this.stopped = true; for (const stop of this.subscriptions) stop(); this.auth.close(); this.catalog = undefined; }
}
