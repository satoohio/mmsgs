import config from './config.js';
import { createApp } from './app.js';
import { closeWebSocket } from './realtime.js';
import { get } from './db.js';
import { ensureSeed } from './seed.js';

const { server } = createApp();

// Демо-данные при первом запуске на пустой базе (отключается AUTO_SEED=false)
if (process.env.AUTO_SEED !== 'false') {
  try {
    const row = get('SELECT COUNT(*) AS c FROM users');
    if (Number(row?.c ?? 0) === 0) ensureSeed();
  } catch (err) {
    console.warn('[seed] пропущен:', err.message);
  }
}

server.listen(config.port, config.host, () => {
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`mmsgs запущен: http://${shown}:${config.port}`);
  console.log(`  БД:        ${config.dbFile}`);
  console.log(`  WebSocket: ws://${shown}:${config.port}/ws`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: останавливаюсь…`);
  closeWebSocket();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

export { server };
