import { createTelegramTransport } from './telegram.mjs';
import { serveTelegramOverXmpp, TELEGRAM_XMPP_BATCH } from './telegram-xmpp.mjs';

const token = process.env.MANOLO_TELEGRAM_TOKEN;
if (!/^[1-9][0-9]*:[A-Za-z0-9_-]+$/.test(token ?? '') || token.split(':')[0] !== process.env.MANOLO_TELEGRAM_BOT_ID) {
  throw new Error('Configure MANOLO_TELEGRAM_TOKEN matching MANOLO_TELEGRAM_BOT_ID');
}
const telegram = createTelegramTransport({ token, baseUrl: process.env.MANOLO_TELEGRAM_BASE_URL, limit: TELEGRAM_XMPP_BATCH });
const stop = new AbortController();
const { xmpp } = serveTelegramOverXmpp(process.env, telegram, stop.signal);
xmpp.on('online', () => console.log('Telegram XMPP bridge online'));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
