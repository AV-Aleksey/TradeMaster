import WebSocket from 'ws';
const token = process.env.ITICK_TOKEN;
if (!token) throw new Error('ITICK_TOKEN is not configured');
const host = process.argv.includes('--trial') ? 'api-free.itick.io' : 'api.itick.io';
const socket = new WebSocket(`wss://${host}/forex`, { headers: { token }, handshakeTimeout: 15000 });
let quotes = 0, bars = 0;
const stop = setTimeout(() => socket.close(), 20000);
socket.on('message', bytes => {
  try {
    const value = JSON.parse(bytes.toString());
    if (value.resAc === 'auth' && value.code === 1) {
      socket.send(JSON.stringify({ ac: 'subscribe', params: 'EURUSD$GB', types: 'quote' }));
      socket.send(JSON.stringify({ ac: 'subscribe', params: 'EURUSD$GB', types: 'kline@2' }));
    }
    if (value.data?.type === 'quote') quotes++;
    if (value.data?.type === 'kline@2') bars++;
    if (value.resAc || (!value.data && value.code !== undefined)) console.log(JSON.stringify({
      apiCode: value.code, action: value.resAc, message: String(value.msg ?? '').replaceAll(token, '[redacted]').slice(0, 160),
    }));
    if (quotes && bars) socket.close();
  } catch { console.log('Non-JSON response'); }
});
socket.on('unexpected-response', (_request, response) => { console.log(JSON.stringify({ httpStatus: response.statusCode })); clearTimeout(stop); socket.terminate(); });
socket.on('error', () => console.log('WebSocket connection failed'));
socket.on('close', () => { clearTimeout(stop); console.log(JSON.stringify({ quotesReceived: quotes, candleUpdatesReceived: bars })); });
