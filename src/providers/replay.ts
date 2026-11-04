import { intervalMs, type Candle, type Timeframe } from '../shared/model';
import type { DataProvider, Instrument } from './contracts';

export class ReplayProvider implements DataProvider {
  readonly id = 'replay' as const;
  readonly name = 'Тестовые данные · Replay ×60';
  readonly capabilities = { nativeTimeframes: ['1m', '5m', '10m', '15m', '30m', '1h', '1d'] as Timeframe[],
    volume: 'synthetic' as const, stream: true, calendar: 'demo-24h' as const };
  private start = Math.floor(Date.now() / 300000) * 300000;
  private wallStart = Date.now();
  now(): number { return this.start + (Date.now() - this.wallStart) * 60; }
  private candle(code: string, openTime: number, duration: number, at: number): Candle {
    const seed = [...code].reduce((a, ch) => a + ch.charCodeAt(0), 0);
    const price = (time: number): number => {
      const step = time / 60000;
      return 1.08 + (seed % 17) / 1000 + Math.sin(step / 12) * .0015 + Math.sin(step / 47) * .003 + Math.sin(step / 3) * .00035;
    };
    const open = price(openTime), close = price(Math.min(openTime + duration, at));
    const spread = .00012 + Math.abs(Math.sin(openTime / 60000)) * .00015;
    return { openTime, closeTime: openTime + duration, open: open.toFixed(6), close: close.toFixed(6),
      high: (Math.max(open, close) + spread).toFixed(6), low: (Math.min(open, close) - spread).toFixed(6),
      volume: (50 + Math.abs(Math.sin(openTime / 100000 + seed)) * 400).toFixed(2), closed: openTime + duration <= at };
  }
  async history(instrument: Instrument, timeframe: Timeframe, limit: number): Promise<Candle[]> {
    const at = this.now(), duration = intervalMs[timeframe], latest = Math.floor(at / duration) * duration;
    return Array.from({ length: limit }, (_, i) => this.candle(instrument.code, latest - (limit - 1 - i) * duration, duration, at));
  }
  async search(query: string): Promise<Instrument[]> {
    return ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF'].filter(code => code.includes(query.toUpperCase().replace('/', '')))
      .map(code => ({ code, name: `${code.slice(0, 3)} / ${code.slice(3)} · тест`, region: 'GB' }));
  }
  subscribe(instrument: Instrument, timeframe: Timeframe, onBar: Parameters<NonNullable<DataProvider['subscribe']>>[2]): () => void {
    let previousOpen = Math.floor(this.now() / intervalMs[timeframe]) * intervalMs[timeframe];
    const timer = setInterval(() => {
      const at = this.now(), duration = intervalMs[timeframe];
      const currentOpen = Math.floor(at / duration) * duration;
      if (currentOpen > previousOpen) {
        // Emit exact completed values, not the last partial snapshot seen by the UI.
        for (let open = previousOpen; open < currentOpen; open += duration) onBar({ candle: this.candle(instrument.code, open, duration, open + duration), sourceTime: at });
        previousOpen = currentOpen;
      }
      onBar({ candle: this.candle(instrument.code, Math.floor(at / duration) * duration, duration, at), sourceTime: at });
    }, 1000);
    return () => clearInterval(timer);
  }
  close(): void { /* subscriptions are owned and disposed by the market-data service */ }
}
