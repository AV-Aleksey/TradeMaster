const token = process.env.ITICK_TOKEN;
if (!token) {
  console.error('ITICK_TOKEN is not configured');
  process.exit(1);
}
const host = process.argv.includes('--trial') ? 'https://api-free.itick.io' : 'https://api.itick.io';
for (const [name, path] of [
  ['catalog', '/symbol/list?type=forex&region=GB&code=EURUSD'],
  ['candles-5m', '/forex/kline?region=GB&code=EURUSD&kType=2&limit=160'],
]) {
  try {
    const response = await fetch(`${host}${path}`, {
      headers: { token, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const data = Array.isArray(body.data) ? body.data : [];
    console.log(JSON.stringify({
      method: name, environment: host.includes('api-free') ? 'trial' : 'production', httpStatus: response.status, apiCode: body.code,
      message: String(body.msg ?? body.message ?? '').replaceAll(token, '[redacted]').slice(0, 180),
      count: data.length, fields: data[0] ? Object.keys(data[0]) : [],
      symbols: name === 'catalog' ? data.slice(0, 5).map(x => x.c) : undefined,
      firstTime: name === 'candles-5m' ? data[0]?.t : undefined,
      lastTime: name === 'candles-5m' ? data.at(-1)?.t : undefined,
    }));
  } catch (error) {
    console.log(JSON.stringify({ method: name, error: error?.cause?.code ?? error.name }));
  }
}
