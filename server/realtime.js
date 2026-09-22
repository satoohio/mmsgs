import { WebSocketServer } from 'ws';
import { bus } from './bus.js';
import { verifyToken } from './auth.js';
import {
  bootstrap, sendMessage, markRead, getConversation, serializeConversation,
  memberIdsOf, touchLastSeen,
} from './services.js';
import {
  register, unregister, connectionsOf, audienceOf, send, sendToUser, sendToUsers,
} from './presence.js';

const HEARTBEAT_MS = 30_000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD = 64 * 1024;

let connectionSeq = 0;
let wssRef = null;

/**
 * Структурные изменения чата сериализуем под каждого получателя отдельно:
 * у участников отличаются title (в личке — имя собеседника), unread, role, muted.
 */
function sendConversationToMembers(conversationId, type) {
  const conv = getConversation(conversationId);
  if (!conv) return;
  for (const userId of memberIdsOf(conversationId)) {
    sendToUser(userId, { type, conversation: serializeConversation(conv, userId) });
  }
}

function tokenFromUrl(req) {
  try {
    return new URL(req.url, 'http://internal').searchParams.get('token');
  } catch {
    return null;
  }
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  wssRef = wss;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/ws';
    try {
      pathname = new URL(req.url, 'http://internal').pathname;
    } catch {
      /* оставим значение по умолчанию */
    }
    if (pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const conn = ws;
    conn.id = `c${++connectionSeq}`;
    conn.userId = null;
    conn.isAlive = true;
    conn.authenticated = false;

    const authTimer = setTimeout(() => {
      if (!conn.authenticated) {
        send(conn, { type: 'error', error: 'Требуется авторизация', fatal: true });
        try { conn.close(4401, 'unauthorized'); } catch { /* ignore */ }
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => { conn.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(conn, { type: 'error', error: 'Некорректный JSON' });
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'auth') {
        const payload = verifyToken(msg.token || tokenFromUrl(req));
        if (!payload?.sub) {
          send(conn, { type: 'error', error: 'Недействительный токен', fatal: true });
          try { conn.close(4401, 'unauthorized'); } catch { /* ignore */ }
          return;
        }
        clearTimeout(authTimer);
        conn.userId = Number(payload.sub);
        conn.authenticated = true;
        register(conn.userId, conn.id, conn);
        touchLastSeen(conn.userId);

        // Полный снимок состояния — клиенту не нужно дёргать пять REST-ручек
        send(conn, { type: 'ready', ...bootstrap(conn.userId), connectionId: conn.id });

        if (connectionsOf(conn.userId).size === 1) {
          sendToUsers(audienceOf(conn.userId), {
            type: 'presence', userId: conn.userId, online: true, lastSeenAt: Date.now(),
          });
        }
        return;
      }

      if (!conn.authenticated) {
        send(conn, { type: 'error', error: 'Сначала отправьте auth', fatal: true });
        return;
      }

      try {
        handleClientMessage(conn, msg);
      } catch (err) {
        send(conn, {
          type: 'error',
          error: err?.message || 'Ошибка запроса',
          status: err?.status || 500,
          ref: msg.type,
          refId: msg.clientId,
        });
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!conn.userId) return;
      const wentOffline = unregister(conn.userId, conn.id);
      touchLastSeen(conn.userId);
      if (wentOffline) {
        sendToUsers(audienceOf(conn.userId), {
          type: 'presence', userId: conn.userId, online: false, lastSeenAt: Date.now(),
        });
      }
    });

    ws.on('error', () => { /* сокет закроется сам, сработает 'close' */ });
  });

  const heartbeat = setInterval(() => {
    for (const conn of wss.clients) {
      if (!conn.isAlive) {
        try { conn.terminate(); } catch { /* ignore */ }
        continue;
      }
      conn.isAlive = false;
      try { conn.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

/** Команды, которые клиент шлёт напрямую в сокет, минуя REST. */
function handleClientMessage(conn, msg) {
  switch (msg.type) {
    case 'ping':
      send(conn, { type: 'pong', t: Date.now() });
      return;

    case 'typing':
      bus.emit('typing', {
        conversationId: Number(msg.conversationId),
        userId: conn.userId,
        memberIds: memberIdsOf(Number(msg.conversationId)),
      });
      return;

    case 'read':
      markRead(conn.userId, Number(msg.conversationId), Number(msg.messageId || 0));
      return;

    case 'message:send': {
      const message = sendMessage(conn.userId, Number(msg.conversationId), {
        body: msg.body,
        replyToId: msg.replyToId,
        attachmentId: msg.attachmentId,
        clientId: msg.clientId,
      });
      // Подтверждение отправителю: сопоставление временного id с настоящим
      send(conn, {
        type: 'message:sent',
        clientId: msg.clientId,
        messageId: message.id,
        conversationId: message.conversationId,
        createdAt: message.createdAt,
      });
      return;
    }

    default:
      send(conn, { type: 'error', error: `Неизвестный тип: ${msg.type}` });
  }
}

/* ------------------------------ Шина → клиенты ----------------------------- */

bus.on('message:new', ({ conversationId, message, memberIds, clientId }) => {
  sendToUsers(memberIds, { type: 'message:new', conversationId, message, clientId });
});

bus.on('message:updated', ({ conversationId, message, memberIds }) => {
  sendToUsers(memberIds, { type: 'message:updated', conversationId, message });
});

bus.on('message:deleted', ({ conversationId, messageId, memberIds, conversation }) => {
  sendToUsers(memberIds, { type: 'message:deleted', conversationId, messageId });
  if (conversation) {
    sendToUsers(memberIds, {
      type: 'conversation:patch',
      patch: {
        id: Number(conversationId),
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
      },
    });
  }
});

bus.on('conversation:new', ({ conversation, memberIds }) => {
  const conv = getConversation(conversation.id);
  if (!conv) return;
  for (const userId of memberIds) {
    sendToUser(userId, { type: 'conversation:new', conversation: serializeConversation(conv, userId) });
  }
});

bus.on('conversation:updated', ({ conversationId, conversation }) => {
  const id = Number(conversationId ?? conversation?.id);
  if (id) sendConversationToMembers(id, 'conversation:updated');
});

bus.on('member:added', ({ conversationId, addedIds }) => {
  const conv = getConversation(conversationId);
  if (!conv) return;
  // Новым участникам — как новый чат, чтобы он сразу появился в списке
  for (const userId of addedIds) {
    sendToUser(userId, { type: 'conversation:new', conversation: serializeConversation(conv, userId) });
  }
  sendConversationToMembers(conversationId, 'conversation:updated');
});

bus.on('member:removed', ({ conversationId, removedId, left }) => {
  sendToUser(removedId, { type: 'conversation:removed', conversationId, left: Boolean(left) });
  sendConversationToMembers(conversationId, 'conversation:updated');
});

bus.on('typing', ({ conversationId, userId, memberIds }) => {
  sendToUsers((memberIds || []).filter((id) => Number(id) !== Number(userId)), {
    type: 'typing', conversationId, userId, at: Date.now(),
  });
});

bus.on('read', ({ conversationId, userId, messageId, memberIds }) => {
  sendToUsers((memberIds || []).filter((id) => Number(id) !== Number(userId)), {
    type: 'read', conversationId, userId, messageId,
  });
});

bus.on('friend:request', ({ toUserId, request }) => {
  sendToUser(toUserId, { type: 'friend:request', request });
});

bus.on('friend:accepted', ({ userId, request }) => {
  sendToUser(userId, { type: 'friend:accepted', request });
});

bus.on('friend:removed', ({ userId, friendId }) => {
  sendToUser(userId, { type: 'friend:removed', friendId });
});

bus.on('user:updated', ({ userId, user }) => {
  sendToUsers(audienceOf(userId), { type: 'user:updated', user });
  sendToUser(userId, { type: 'user:updated', user, self: true });
});

export function closeWebSocket() {
  if (!wssRef) return;
  for (const conn of wssRef.clients) {
    try { conn.close(1001, 'shutdown'); } catch { /* ignore */ }
  }
}
