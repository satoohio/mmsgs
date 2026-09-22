import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

/**
 * Тестовый стенд: отдельная временная БД и эфемерный порт.
 * Переменные окружения выставляются ДО импорта серверных модулей,
 * потому что config.js читает их один раз при загрузке.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mmsgs-test-'));
process.env.DATA_DIR = tmpRoot;
process.env.DB_FILE = path.join(tmpRoot, 'test.sqlite');
process.env.JWT_SECRET = 'test-secret-value-for-unit-tests-only';
process.env.AUTO_SEED = 'false';

let started = null;

export async function startServer() {
  if (started) return started;
  const { createApp } = await import('../server/app.js');
  const { server, wss } = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  started = {
    server,
    wss,
    port,
    base: `http://127.0.0.1:${port}`,
    api: `http://127.0.0.1:${port}/api`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    tmpRoot,
    async close() {
      const { closeWebSocket } = await import('../server/realtime.js');
      closeWebSocket();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
  return started;
}

/** fetch с JSON и авторизацией; бросает ошибку на не-2xx, если не попросить иначе. */
export async function call(ctx, method, url, { body, token, raw, expect, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      // undici отдаёт Buffer/Uint8Array без Content-Type — нормализуем тело
      payload = Buffer.isBuffer(body) ? new Uint8Array(body) : body;
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/octet-stream';
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  // Допускаем и относительные пути ('/friends'), и готовые URL из ответов ('/api/attachments/…')
  const suffix = url.startsWith('/api/') ? url.slice(4) : url;
  const res = await fetch(`${ctx.api}${suffix}`, { method, headers, body: payload });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = raw ? await res.arrayBuffer() : isJson ? await res.json() : await res.text();
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${url} → ожидали ${expect}, получили ${res.status}: ${JSON.stringify(data)}`);
  }
  if (expect === undefined && !res.ok) {
    throw new Error(`${method} ${url} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return { status: res.status, data, headers: res.headers };
}

let userSeq = 0;

/** Регистрирует пользователя и возвращает { token, user }. */
export async function registerUser(ctx, overrides = {}) {
  const n = ++userSeq;
  const body = {
    username: overrides.username || `user${n}_${Date.now().toString(36).slice(-4)}`,
    password: overrides.password || 'secret123',
    displayName: overrides.displayName || `Тестер ${n}`,
  };
  const { data } = await call(ctx, 'POST', '/auth/register', { body });
  return { token: data.token, user: data.user, password: body.password, username: body.username };
}

/** Друзья за один вызов: заявка + подтверждение. */
export async function makeFriends(ctx, a, b) {
  const { data } = await call(ctx, 'POST', '/friends/requests', {
    token: a.token, body: { userId: b.user.id },
  });
  await call(ctx, 'POST', `/friends/requests/${data.request.id}/accept`, { token: b.token });
  return data.request;
}

/* ------------------------------ WS-клиент --------------------------------- */

export class WsClient {
  constructor(ctx, label = 'client') {
    this.ctx = ctx;
    this.label = label;
    this.inbox = [];
    this.waiters = [];
    this.closed = false;
  }

  connect(token) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.ctx.wsUrl);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'auth', token }));
      });
      this.ws.on('message', (raw) => this._onMessage(raw));
      this.ws.on('error', reject);
      this.ws.on('close', () => { this.closed = true; });
      this.wait((m) => m.type === 'ready', 5000).then(resolve, reject);
    });
  }

  /** Подключение без авторизации — для негативных проверок. */
  connectRaw() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.ctx.wsUrl);
      this.ws.on('open', resolve);
      this.ws.on('message', (raw) => this._onMessage(raw));
      this.ws.on('error', reject);
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    this.inbox.push(msg);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      if (this.waiters[i].test(msg)) {
        const { resolve } = this.waiters[i];
        this.waiters.splice(i, 1);
        resolve(msg);
      }
    }
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  /** Ждёт первое сообщение, подходящее под предикат (включая уже полученные). */
  wait(test, timeout = 4000) {
    const hit = this.inbox.find(test);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== onHit);
        reject(new Error(`${this.label}: не дождались события за ${timeout}мс. Получено: ${this.inbox.map((m) => m.type).join(', ')}`));
      }, timeout);
      const onHit = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push({ test, resolve: onHit });
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
