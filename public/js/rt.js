/**
 * WebSocket-клиент: автопереподключение с экспоненциальной задержкой,
 * очередь исходящих на время разрыва, статус соединения для UI.
 *
 * Протокол (JSON):
 *   client → server: auth, ping, typing, read, message:send
 *   server → client: ready, message:new/sent/updated/deleted, conversation:*,
 *                    presence, typing, read, friend:*, user:updated, error, pong
 */

const RECONNECT_MIN = 600;
const RECONNECT_MAX = 15_000;
const TYPING_THROTTLE = 2_200;

export class Realtime {
  constructor({ getToken, onEvent, onStateChange }) {
    this.getToken = getToken;
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.ws = null;
    this.state = 'offline'; // offline | connecting | online
    this.attempt = 0;
    this.queue = [];
    this.closedByUser = false;
    this.lastTypingSent = new Map(); // conversationId -> ts
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  connect() {
    const token = this.getToken();
    if (!token) {
      this.setState('offline');
      return;
    }
    this.closedByUser = false;
    this.setState('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }));
    };

    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        this.attempt = 0;
        this.setState('online');
        this.flushQueue();
      }
      this.onEvent?.(msg);
    };

    ws.onerror = () => { /* за ошибкой всегда следует close */ };

    ws.onclose = (evt) => {
      this.stopPing();
      this.ws = null;
      if (this.closedByUser) {
        this.setState('offline');
        return;
      }
      // 4401 — наш код «плохой токен»: переподключаться бессмысленно
      if (evt.code === 4401) {
        this.setState('offline');
        this.onEvent?.({ type: 'unauthorized' });
        return;
      }
      this.setState('offline');
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MIN * 2 ** this.attempt, RECONNECT_MAX);
    this.attempt += 1;
    this.setState('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => this.raw({ type: 'ping' }), 25_000);
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  raw(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /** Отправка с очередью: если соединения нет, команда уйдёт после реконнекта. */
  send(payload, { queue = true } = {}) {
    if (this.raw(payload)) return true;
    if (queue && !this.closedByUser) this.queue.push(payload);
    return false;
  }

  flushQueue() {
    const pending = this.queue.splice(0, this.queue.length);
    for (const payload of pending) this.raw(payload);
    this.startPing();
  }

  get isOpen() {
    return this.state === 'online' && this.ws?.readyState === WebSocket.OPEN;
  }

  typing(conversationId) {
    const last = this.lastTypingSent.get(conversationId) || 0;
    const now = Date.now();
    if (now - last < TYPING_THROTTLE) return;
    this.lastTypingSent.set(conversationId, now);
    this.send({ type: 'typing', conversationId }, { queue: false });
  }

  read(conversationId, messageId) {
    this.send({ type: 'read', conversationId, messageId }, { queue: false });
  }

  sendMessage({ conversationId, body, replyToId, attachmentId, clientId }) {
    return this.send({ type: 'message:send', conversationId, body, replyToId, attachmentId, clientId });
  }

  disconnect() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPing();
    this.queue = [];
    if (this.ws) {
      try { this.ws.close(1000, 'logout'); } catch { /* ignore */ }
      this.ws = null;
    }
    this.setState('offline');
  }
}

export default Realtime;
