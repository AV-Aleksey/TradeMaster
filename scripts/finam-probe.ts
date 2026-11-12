import { app, safeStorage } from 'electron';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { FinamProvider } from '../src/providers/finam';
import { desktopFetch } from '../src/main/telegram-network';
import WebSocket from 'ws';

// Read-only diagnostics. Output contains public market data and aggregate auth status only.
app.setName('trademaster');
if (process.env.TRADEMASTER_DATA_DIR) app.setPath('userData', resolve(process.env.TRADEMASTER_DATA_DIR));
void app.whenReady().then(async () => {
  let provider: FinamProvider | undefined;
  let stage = 'credentials';
  try {
    if (!process.env.FINAM_TOKEN && !await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Encryption unavailable');
    const directory = process.env.TRADEMASTER_DATA_DIR ? resolve(process.env.TRADEMASTER_DATA_DIR) : resolve('.local/app-data');
    const token = process.env.FINAM_TOKEN || (await safeStorage.decryptStringAsync(readFileSync(join(directory, 'credentials-finam.enc')))).result;
    const fixtureDirectory = process.env.FINAM_FIXTURE_DIR;
    const fixture = (name: string, data: unknown) => {
      if (!fixtureDirectory) return;
      mkdirSync(fixtureDirectory, { recursive: true });
      writeFileSync(join(fixtureDirectory, name), JSON.stringify(data, null, 2) + '\n');
    };
    provider = new FinamProvider(() => token, async (input, options) => {
      const response = await desktopFetch(input, options);
      if (response.ok && String(input).includes('/bars?')) {
        const body = await response.clone().json();
        if (Array.isArray(body.bars) && body.bars.length) fixture(`rest-${new URL(String(input)).searchParams.get('timeframe')}.json`, { symbol: body.symbol, bars: body.bars.slice(-3) });
      }
      return response;
    }, url => {
      const socket = new WebSocket(url, { handshakeTimeout: 10000 });
      socket.on('message', bytes => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.type === 'DATA' && message.subscription_type === 'BARS') {
            const payload = typeof message.payload === 'string' ? JSON.parse(message.payload) : message.payload;
            if (Array.isArray(payload.bars) && payload.bars.length) {
              const sample = { symbol: payload.symbol, bars: payload.bars.slice(-3) };
              fixture('websocket-bars.json', { type: 'DATA', subscription_type: 'BARS', payload: typeof message.payload === 'string' ? JSON.stringify(sample) : sample });
            }
          }
        } catch { /* Adapter reports malformed messages. */ }
      });
      return socket;
    });
    stage = 'auth';
    console.log(JSON.stringify({ method: 'auth', ...await provider.ping() }));
    stage = 'catalog';
    const instruments = await provider.search(process.env.FINAM_SYMBOL || process.env.FINAM_QUERY || 'SBER@MISX');
    console.log(JSON.stringify({ method: 'catalog', count: instruments.length, instruments: instruments.slice(0, 10) }));
    const instrument = instruments[0];
    if (!instrument) throw new Error('Инструмент не найден: задайте FINAM_QUERY или FINAM_SYMBOL');
    stage = 'bars';
    let count = 0;
    for (const timeframe of ['1m', '5m', '15m', '30m', '1h', '1d'] as const) {
      const bars = await provider.history(instrument, timeframe, 120);
      count += bars.length;
      console.log(JSON.stringify({ method: 'bars', instrument, timeframe, count: bars.length, first: bars[0], last: bars.at(-1) }));
    }
    if (!count) throw new Error('Empty history');
    stage = 'stream';
    await new Promise<void>((resolve, reject) => {
      let reported = false;
      const timer = setTimeout(() => { stop(); reject(new Error('No stream data')); }, 20000);
      const stop = provider!.subscribe(instrument, '1m', update => {
        if (reported || update.candle.openTime < Date.now() - 120000) return;
        reported = true;
        console.log(JSON.stringify({ method: 'stream', ...update })); clearTimeout(timer); stop(); resolve();
      }, status => console.log(JSON.stringify({ method: 'stream-status', status })));
    });
    provider.close(); app.exit(0);
  } catch (error) {
    provider?.close();
    // Never print arbitrary backend/OS errors that could contain private values.
    console.error(JSON.stringify({ stage, errorType: error instanceof Error ? error.name : 'unknown', error: error instanceof Error && (error.name === 'ProviderError' || stage === 'credentials') ? error.message : 'Проверка не завершена: проверьте сохранённый ключ, каталог данных и доступ к сети' }));
    app.exit(1);
  }
});
