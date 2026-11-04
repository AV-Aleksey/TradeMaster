import { parse, isLosslessNumber } from 'lossless-json';
import Decimal from 'decimal.js';
import WebSocket from 'ws';
import { normalizeCandles, validateCandle } from '../core/candles';
import { intervalMs, type Candle, type SourceId, type Timeframe } from '../shared/model';
import { ProviderError, RequestScheduler, type BarUpdate, type DataProvider, type Instrument } from './contracts';

const types: Partial<Record<Timeframe, number>> = { '1m': 1, '5m': 2, '15m': 3, '30m': 4, '1h': 5, '1d': 8 };
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('invalidData', 'iTick: некорректный формат ответа');
  return value as Json;
}
function numeric(value: unknown, field: string): string {
  const result = typeof value === 'string' || typeof value === 'number' || isLosslessNumber(value) ? String(value) : '';
  if (result.length > 2048 || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(result)) {
    throw new ProviderError('invalidData', `iTick: некорректное числовое поле ${field}`);
  }
  const decimal = new Decimal(result);
  if (!decimal.isFinite() || Math.abs(decimal.e) > 1000) {
    throw new ProviderError('invalidData', `iTick: числовое поле ${field} вне допустимого диапазона`);
  }
  // JSON numbers may use scientific notation. Expand it without a Number round-trip
  // or arithmetic, preserving all digits before passing decimal strings to the core.
  return decimal.toFixed();
}
export function decodeItickBars(payload: unknown, timeframe: Timeframe): Candle[] {
  if (!Array.isArray(payload)) throw new ProviderError('invalidData', 'iTick: в ответе нет списка свечей');
  const duration = intervalMs[timeframe];
  const candles = payload.map(raw => {
    const bar = object(raw), openTime = Number(numeric(bar.t, 't'));
    if (openTime % duration !== 0) throw new ProviderError('invalidData', 'iTick: границы свечей не соответствуют периоду; мониторинг заблокирован');
    const candle: Candle = { openTime, closeTime: openTime + duration,
      open: numeric(bar.o, 'o'), high: numeric(bar.h, 'h'), low: numeric(bar.l, 'l'), close: numeric(bar.c, 'c'),
      volume: bar.v == null ? null : numeric(bar.v, 'v'), closed: false };
    validateCandle(candle); return candle;
  });
  const sorted = normalizeCandles(candles);
  // Conservative: a later source bar is evidence that the preceding interval ended.
  // Never infer finality from wall-clock time or from the mere presence of 'c'.
  return sorted.map((bar, i) => ({ ...bar, closed: i < sorted.length - 1 }));
}

export class ItickProvider implements DataProvider {
  readonly capabilities = { nativeTimeframes: ['1m', '5m', '15m', '30m', '1h', '1d'] as Timeframe[],
    volume: 'reported' as const, stream: true, calendar: 'unverified' as const };
  readonly id: SourceId;
  readonly name: string;
  private readonly host: string;
  private sockets = new Set<WebSocket>();
  private stopped = false;
  constructor(private readonly token: string, trial = false,
    private readonly fetcher: typeof fetch = fetch, private readonly scheduler = new RequestScheduler()) {
    this.id = trial ? 'itick-trial' : 'itick'; this.name = trial ? 'iTick · Trial' : 'iTick · Production';
    this.host = trial ? 'api-free.itick.io' : 'api.itick.io';
  }
  now(): number { return Date.now(); }
  private request(path: string): Promise<unknown> {
    return this.scheduler.run(async () => {
      if (this.stopped) throw new ProviderError('unavailable', 'Подключение закрыто');
      if (!this.token) throw new ProviderError('unauthorized', 'Укажите ключ iTick в настройках');
      let response: Response;
      try { response = await this.fetcher(`https://${this.host}${path}`, {
        headers: { token: this.token, accept: 'application/json' }, signal: AbortSignal.timeout(15000),
      }); } catch { throw new ProviderError('unavailable', 'iTick: сеть недоступна или превышено время ожидания'); }
      if (response.status === 401) throw new ProviderError('unauthorized', 'iTick: HTTP 401 — ключ не принят для выбранного окружения');
      if (response.status === 403) throw new ProviderError('forbidden', 'iTick: нет доступа к запрошенным данным');
      if (response.status === 429) throw new ProviderError('rateLimited', 'iTick: превышена квота запросов. Повторите позже');
      if (!response.ok) throw new ProviderError('unavailable', `iTick: HTTP ${response.status}`);
      let envelope: Json;
      try { envelope = object(parse(await response.text())); }
      catch { throw new ProviderError('invalidData', 'iTick: некорректный JSON'); }
      if (Number(envelope.code) !== 0) {
        // External descriptions are not echoed: some vendors include request details.
        const code = /^-?\d{1,9}$/.test(String(envelope.code)) ? String(envelope.code) : 'unknown';
        throw new ProviderError('forbidden', `iTick: запрос отклонён (код ${code})`);
      }
      return envelope.data;
    });
  }
  async history(instrument: Instrument, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const type = types[timeframe];
    if (!type) throw new ProviderError('unsupported', 'iTick: период требует агрегации');
    const collected = new Map<number, Candle>();
    let end: number | undefined;
    while (collected.size < limit) {
      const query = new URLSearchParams({ region: instrument.region, code: instrument.code, kType: String(type), limit: String(Math.min(limit - collected.size, 500)) });
      if (end !== undefined) query.set('et', String(end));
      const page = decodeItickBars(await this.request(`/forex/kline?${query}`), timeframe);
      if (!page.length) break;
      const previousSize = collected.size;
      for (const candle of page) collected.set(candle.openTime, candle);
      const oldest = page[0].openTime;
      if (collected.size === previousSize || (end !== undefined && oldest >= end)) break;
      end = oldest - 1;
      // An undersized page indicates the available boundary, not a complete warmup.
      if (page.length < Math.min(limit - previousSize, 500)) break;
    }
    const result = normalizeCandles([...collected.values()]).slice(-limit);
    return result.map((bar, i) => ({ ...bar, closed: i < result.length - 1 }));
  }
  async search(query: string): Promise<Instrument[]> {
    const params = new URLSearchParams({ type: 'forex', region: 'GB' });
    if (query) params.set('code', query.toUpperCase().replace('/', ''));
    const result = await this.request(`/symbol/list?${params}`);
    if (!Array.isArray(result)) throw new ProviderError('invalidData', 'iTick: некорректный каталог');
    return result.map(value => {
      const item = object(value);
      if (typeof item.c !== 'string' || !/^[A-Z0-9._-]{2,32}$/.test(item.c)) throw new ProviderError('invalidData', 'iTick: некорректный код инструмента');
      return { code: item.c, name: typeof item.n === 'string' ? item.n : item.c, region: 'GB' };
    }).slice(0, 100);
  }
  subscribe(instrument: Instrument, timeframe: Timeframe, onBar: (update: BarUpdate) => void, onStatus: (status: string) => void): () => void {
    if (!types[timeframe] || !this.token) return () => {};
    const socket = new WebSocket(`wss://${this.host}/forex`, { headers: { token: this.token }, handshakeTimeout: 15000 });
    this.sockets.add(socket);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let active = true;
    socket.on('open', () => {
      heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ac: 'ping', params: String(Date.now()) })); }, 25000);
    });
    socket.on('message', bytes => {
      if (!active) return;
      try {
        const message = object(parse(bytes.toString()));
        if (message.resAc === 'auth') {
          if (Number(message.code) !== 1) { onStatus('WebSocket: авторизация отклонена; доступен REST'); socket.close(); return; }
          socket.send(JSON.stringify({ ac: 'subscribe', params: `${instrument.code}$${instrument.region}`, types: `kline@${types[timeframe]}` }));
        } else if (message.resAc === 'subscribe') {
          if (Number(message.code) === 1) onStatus('WebSocket подключён');
          else { onStatus('Свечной WebSocket недоступен по текущему доступу; используется REST'); socket.close(); }
        } else if (message.data) {
          const data = object(message.data);
          if (data.type !== `kline@${types[timeframe]}` || data.s !== instrument.code || data.r !== instrument.region) return;
          const [candle] = decodeItickBars([data], timeframe);
          if (candle) onBar({ candle, sourceTime: Date.now() });
        }
      } catch { onStatus('WebSocket: некорректные данные, требуется REST-сверка'); }
    });
    socket.on('error', () => onStatus('WebSocket недоступен; используется REST'));
    socket.on('close', () => { if (heartbeat) clearInterval(heartbeat); this.sockets.delete(socket); if (active) onStatus('WebSocket отключён; используется REST'); });
    return () => { active = false; if (heartbeat) clearInterval(heartbeat); this.sockets.delete(socket); socket.close(); };
  }
  close(): void { this.stopped = true; for (const socket of this.sockets) socket.close(); this.sockets.clear(); }
}
