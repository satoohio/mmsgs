import { all } from './db.js';

/**
 * Единый реестр WS-соединений и состояния «онлайн».
 *
 * Хранит сами сокеты, поэтому realtime-слой рассылает через эти же хелперы,
 * а доменный слой спрашивает только isOnline(). В памяти процесса: после
 * перезапуска сервера все считаются офлайн, что корректно.
 */
const registry = new Map(); // userId -> Map<connectionId, conn>

export function register(userId, connectionId, conn) {
  if (!registry.has(userId)) registry.set(userId, new Map());
  registry.get(userId).set(connectionId, conn);
}

/** @returns {boolean} true, если пользователь полностью ушёл в офлайн */
export function unregister(userId, connectionId) {
  const set = registry.get(userId);
  if (!set) return false;
  set.delete(connectionId);
  if (set.size === 0) {
    registry.delete(userId);
    return true;
  }
  return false;
}

export function connectionsOf(userId) {
  return registry.get(Number(userId)) || new Map();
}

export function isOnline(userId) {
  const set = registry.get(Number(userId));
  return Boolean(set && set.size > 0);
}

export function onlineIds(userIds) {
  const out = new Set();
  for (const id of userIds || []) if (isOnline(id)) out.add(Number(id));
  return out;
}

export function allOnlineIds() {
  return new Set([...registry.keys()].map(Number));
}

export function totalConnections() {
  let n = 0;
  for (const set of registry.values()) n += set.size;
  return n;
}

/* -------------------------------- Рассылка --------------------------------- */

export function send(conn, payload) {
  if (!conn || conn.readyState !== 1 /* OPEN */) return false;
  try {
    conn.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function sendToUser(userId, payload) {
  const set = registry.get(Number(userId));
  if (!set || !set.size) return false;
  for (const conn of set.values()) send(conn, payload);
  return true;
}

export function sendToUsers(userIds, payload) {
  let delivered = false;
  for (const id of new Set((userIds || []).map(Number))) {
    if (sendToUser(id, payload)) delivered = true;
  }
  return delivered;
}

/**
 * Аудитория событий о пользователе: его друзья и соучастники общих чатов.
 * Один запрос, без загрузки самих чатов.
 */
export function audienceOf(userId) {
  const id = Number(userId);
  const rows = all(
    `SELECT friend_id AS uid FROM friendships WHERE user_id = ?
     UNION
     SELECT cm2.user_id AS uid
       FROM conversation_members cm1
       JOIN conversation_members cm2 ON cm2.conversation_id = cm1.conversation_id
      WHERE cm1.user_id = ?`,
    id, id,
  );
  const ids = new Set(rows.map((r) => Number(r.uid)));
  ids.delete(id);
  return [...ids];
}
