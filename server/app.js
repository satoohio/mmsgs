import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { api, errorHandler } from './api.js';
import { attachWebSocket } from './realtime.js';

/**
 * Сборка приложения без привязки к порту — удобно и для продакшена,
 * и для тестов (там слушаем эфемерный порт).
 */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Базовая защита заголовков без helmet-зависимости
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
  });

  app.use('/api', api);
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: '1h' }));

  // SPA fallback: всё, что не /api и не файл, отдаём в index.html
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (path.extname(req.path)) return next();
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  });

  app.use((req, res) => res.status(404).json({ error: 'Не найдено' }));
  app.use(errorHandler);

  const server = http.createServer(app);
  const wss = attachWebSocket(server);
  return { app, server, wss };
}
