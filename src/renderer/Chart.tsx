import { useEffect, useRef } from 'react';
import { init, dispose, registerIndicator, type Chart, type KLineData, type DataLoaderSubscribeBarParams } from 'klinecharts';
import { indicator } from '../core/indicators';
import type { Candle, Pair, Timeframe } from '../shared/model';

const macdParams = { fast: 12, slow: 26, signal: 9, oscillatorMa: 'ema', signalMa: 'ema' } as const;
const toCandle = (data: KLineData[]): Candle[] => data.map(d => ({ openTime: d.timestamp, closeTime: d.timestamp + 1,
  open: String(d.open), high: String(d.high), low: String(d.low), close: String(d.close),
  volume: d.volume == null ? null : String(d.volume), closed: true }));
registerIndicator({ name: 'TM_EMA', shortName: 'EMA', series: 'price', precision: 6,
  figures: [5, 10].map(p => ({ key: `ema${p}`, title: `${p}: `, type: 'line' })),
  calc: data => { const values = [5, 10].map(p => indicator(toCandle(data), 'ema', p));
    return data.map((_, i) => Object.fromEntries([5, 10].map((p, j) => [`ema${p}`, values[j][i]?.toNumber() ?? null]))); },
  styles: { lines: [{ color: '#f2f2f2' }, { color: '#f7a600' }, { color: '#e6a3a8' }, { color: '#b96bd0' }] },
});
registerIndicator({ name: 'TM_MACD', shortName: 'MACD 12/26/9', precision: 6,
  figures: [{ key: 'hist', title: 'Hist: ', type: 'bar', baseValue: 0 },
    { key: 'line', title: 'MACD: ', type: 'line' }, { key: 'signal', title: 'Signal: ', type: 'line' }],
  calc: data => { const bars = toCandle(data), line = indicator(bars, 'macd', 12, macdParams), signal = indicator(bars, 'macdSignal', 12, macdParams), hist = indicator(bars, 'macdHist', 12, macdParams);
    return data.map((_, i) => ({ line: line[i]?.toNumber() ?? null, signal: signal[i]?.toNumber() ?? null, hist: hist[i]?.toNumber() ?? null })); },
});
registerIndicator({ name: 'TM_STOCH', shortName: 'Stochastic 10/5/5', precision: 2, minValue: 0, maxValue: 100,
  figures: [{ key: 'k', title: 'K: ', type: 'line' }, { key: 'd', title: 'D: ', type: 'line' }],
  calc: data => { const bars = toCandle(data), k = indicator(bars, 'stochK', 10), d = indicator(bars, 'stochD', 10);
    return data.map((_, i) => ({ k: k[i]?.toNumber() ?? null, d: d[i]?.toNumber() ?? null })); },
});
const convert = (bars: Candle[]): KLineData[] => bars.map(c => ({ timestamp: c.openTime,
  open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
  ...(c.volume === null ? {} : { volume: Number(c.volume) }) }));

export type ChartPanel = 'both' | 'macd' | 'stoch' | 'none';
export function CandleChart({ pair, timeframe, candles, panel }: { pair: Pair; timeframe: Timeframe; candles: Candle[]; panel: ChartPanel }): React.JSX.Element {
  const element = useRef<HTMLDivElement>(null), chart = useRef<Chart | null>(null);
  const data = useRef<KLineData[]>([]), push = useRef<DataLoaderSubscribeBarParams['callback'] | null>(null);
  const previous = useRef<KLineData[]>([]);
  data.current = convert(candles);
  useEffect(() => {
    if (!element.current) return;
    const instance = init(element.current, { timezone: 'Etc/UTC', styles: 'dark' });
    if (!instance) return;
    chart.current = instance;
    instance.setStyles({ grid: { horizontal: { color: '#22242b' }, vertical: { color: '#22242b' } },
      candle: { bar: { upColor: '#00c087', downColor: '#f6465d', noChangeColor: '#9a9da7',
        upBorderColor: '#00c087', downBorderColor: '#f6465d', upWickColor: '#00c087', downWickColor: '#f6465d' } } });
    instance.setSymbol({ ticker: pair.code, pricePrecision: 6, volumePrecision: 2 });
    instance.setPeriod(timeframe === '1d' ? { span: 1, type: 'day' } : timeframe === '1h' ? { span: 1, type: 'hour' }
      : { span: Number(timeframe.slice(0, -1)), type: 'minute' });
    instance.setDataLoader({ getBars: ({ type, callback }) => {
      if (type === 'init') { previous.current = data.current; callback(data.current, false); }
      else callback([], false);
    }, subscribeBar: ({ callback }) => { push.current = callback; }, unsubscribeBar: () => { push.current = null; } });
    instance.createIndicator({ name: 'TM_EMA', paneId: 'candle_pane' }, true);
    if (panel === 'stoch' || panel === 'both') instance.createIndicator({ name: 'TM_STOCH', paneId: 'stoch_pane' });
    if (panel === 'macd' || panel === 'both') instance.createIndicator({ name: 'TM_MACD', paneId: 'macd_pane' });
    const observer = new ResizeObserver(() => instance.resize()); observer.observe(element.current);
    return () => { observer.disconnect(); push.current = null; dispose(element.current!); chart.current = null; previous.current = []; };
  }, [pair.id, pair.source, timeframe, panel]);
  useEffect(() => {
    const current = data.current, old = previous.current;
    if (!chart.current || !current.length) return;
    if (!old.length || current[0].timestamp !== old[0]?.timestamp || current.length < old.length) chart.current.resetData();
    else if (push.current) {
      const last = old.at(-1)!.timestamp;
      current.filter(c => c.timestamp >= last).forEach(push.current);
    }
    previous.current = current;
  }, [candles]);
  return <div ref={element} className="chart-canvas" data-testid="candle-chart" />;
}
