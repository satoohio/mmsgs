import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import config from './config.js';
import {
  ApiError,
  getUserById, getUserByUsername, createUser, updateUser, changePassword, serializeUser,
  searchUsers, suggestUsers, friendState, listFriends, listFriendRequests, sendFriendRequest,
  acceptFriendRequest, declineFriendRequest, removeFriend, setBlock, listBlocked,
  listConversations, getOrCreateDirect, findDirectConversation, createGroup, updateConversation,
  addMembers, removeMember, serializeConversation, getConversation, assertMember, memberIdsOf,
  listMessages, sendMessage, editMessage, deleteMessage, markRead, toggleReaction, searchMessages,
  createAttachment, bootstrap,
} from './services.js';
import { hashPassword, verifyPassword, signToken, requireAuth, validateRegistration, sanitizeText } from './auth.js';
import { emit } from './bus.js';
import { get, run } from './db.js';

export const api = express.Router();

const wrap = (fn) => (req, res, next) => {
  try {
    Promise.resolve(fn(req, res, next)).catch(next);
  } catch (err) {
    next(err);
  }
};

/* ------------------------------- Авторизация ------------------------------- */

api.post('/auth/register', express.json({ limit: '64kb' }), wrap((req, res) => {
  const { username, password, displayName, display_name } = req.body || {};
  const name = displayName ?? display_name;
  const { errors, username: cleanUsername, name: cleanName } = validateRegistration({
    username, password, displayName: name,
  });
  if (errors.length) throw new ApiError(400, 'Проверьте данные формы', errors);
  if (getUserByUsername(cleanUsername)) {
    throw new ApiError(409, 'Такой логин уже занят');
  }
  const user = createUser({ username: cleanUsername, displayName: cleanName, passwordHash: hashPassword(String(password)) });
  const token = signToken({ sub: user.id, username: user.username });
  res.status(201).json({ token, user: serializeUser(user, user.id) });
}));

api.post('/auth/login', express.json({ limit: '64kb' }), wrap((req, res) => {
  const { username, password } = req.body || {};
  const login = sanitizeText(username, 120).replace(/^@/, '');
  const row = getUserByUsername(login);
  // Одинаковая задержка и сообщение для «нет такого» и «неверный пароль»
  if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
    throw new ApiError(401, 'Неверный логин или пароль');
  }
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), row.id);
  const token = signToken({ sub: row.id, username: row.username });
  res.json({ token, user: serializeUser(getUserById(row.id), row.id) });
}));

api.get('/auth/me', requireAuth, wrap((req, res) => {
  const row = getUserById(req.userId);
  if (!row) throw new ApiError(404, 'Пользователь не найден');
  res.json({ user: serializeUser(row, req.userId) });
}));

api.patch('/auth/me', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const { displayName, bio, avatarColor, currentPassword, newPassword } = req.body || {};
  const patch = {};
  if (displayName !== undefined) {
    const name = sanitizeText(displayName, 48);
    if (name.length < 2) throw new ApiError(400, 'Имя: минимум 2 символа');
    patch.displayName = name;
  }
  if (bio !== undefined) patch.bio = bio;
  if (avatarColor !== undefined) patch.avatarColor = avatarColor;
  if (newPassword !== undefined) changePassword(req.userId, currentPassword, newPassword);
  const user = patch && Object.keys(patch).length ? updateUser(req.userId, patch) : getUserById(req.userId);
  res.json({ user: serializeUser(user, req.userId) });
}));

api.post('/auth/logout', requireAuth, wrap((req, res) => {
  // Токены stateless: сервер лишь фиксирует время выхода
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', Date.now(), req.userId);
  res.json({ ok: true });
}));

/** Всё, что нужно для первой отрисовки, одним запросом. */
api.get('/bootstrap', requireAuth, wrap((req, res) => {
  res.json(bootstrap(req.userId));
}));

/* --------------------------------- Люди ----------------------------------- */

api.get('/users/search', requireAuth, wrap((req, res) => {
  const q = String(req.query.q || '');
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  // Пустой запрос = «кого можно добавить»: недавние регистрации, кроме друзей
  const results = q.trim() ? searchUsers(req.userId, q, limit) : suggestUsers(req.userId, limit);
  res.json({ query: q, results });
}));

api.get('/users/:id', requireAuth, wrap((req, res) => {
  const row = getUserById(Number(req.params.id));
  if (!row) throw new ApiError(404, 'Пользователь не найден');
  const direct = Number(req.params.id) === req.userId ? null : findDirectConversation(req.userId, row.id);
  res.json({
    user: serializeUser(row, req.userId),
    relation: friendState(req.userId, row.id),
    conversationId: direct ? Number(direct.id) : null,
  });
}));

/* --------------------------------- Друзья ---------------------------------- */

api.get('/friends', requireAuth, wrap((req, res) => {
  res.json({ friends: listFriends(req.userId) });
}));

api.get('/friends/requests', requireAuth, wrap((req, res) => {
  const direction = req.query.direction === 'outgoing' ? 'outgoing' : 'incoming';
  res.json({ requests: listFriendRequests(req.userId, direction) });
}));

api.post('/friends/requests', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const { username, userId, user_id, message } = req.body || {};
  const target = userId ?? user_id ?? username;
  if (!target) throw new ApiError(400, 'Укажите логин или id пользователя');
  const request = sendFriendRequest(req.userId, target, message || '');
  res.status(201).json({ request });
}));

api.post('/friends/requests/:id/accept', requireAuth, wrap((req, res) => {
  const request = acceptFriendRequest(req.userId, Number(req.params.id));
  // Сразу готовим личный чат, чтобы собеседники могли писать друг другу
  const conv = getOrCreateDirect(request.fromUserId, request.toUserId);
  res.json({ request, conversation: serializeConversation(conv, req.userId) });
}));

api.post('/friends/requests/:id/decline', requireAuth, wrap((req, res) => {
  res.json({ request: declineFriendRequest(req.userId, Number(req.params.id)) });
}));

api.delete('/friends/:id', requireAuth, wrap((req, res) => {
  res.json(removeFriend(req.userId, Number(req.params.id)));
}));

api.post('/users/:id/block', requireAuth, wrap((req, res) => {
  res.json(setBlock(req.userId, Number(req.params.id), true));
}));

api.delete('/users/:id/block', requireAuth, wrap((req, res) => {
  res.json(setBlock(req.userId, Number(req.params.id), false));
}));

api.get('/blocks', requireAuth, wrap((req, res) => {
  res.json({ blocked: listBlocked(req.userId) });
}));

/* ---------------------------------- Чаты ----------------------------------- */

api.get('/conversations', requireAuth, wrap((req, res) => {
  res.json({ conversations: listConversations(req.userId) });
}));

api.post('/conversations/direct', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const { userId, user_id, username } = req.body || {};
  let target = userId ?? user_id;
  if (!target && username) {
    const row = getUserByUsername(String(username).replace(/^@/, ''));
    if (!row) throw new ApiError(404, 'Пользователь не найден');
    target = row.id;
  }
  if (!target) throw new ApiError(400, 'Укажите собеседника');
  const relation = friendState(req.userId, target);
  if (relation === 'blocked' || relation === 'blocked_by') {
    throw new ApiError(403, 'Общение с этим пользователем ограничено');
  }
  const conv = getOrCreateDirect(req.userId, target);
  const serialized = serializeConversation(conv, req.userId);
  emit('conversation:new', { conversation: serialized, memberIds: serialized.memberIds });
  res.status(201).json({ conversation: serialized });
}));

api.post('/conversations/group', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const { title, memberIds, member_ids } = req.body || {};
  const ids = memberIds ?? member_ids ?? [];
  if (!Array.isArray(ids)) throw new ApiError(400, 'memberIds должен быть массивом');
  res.status(201).json({ conversation: createGroup(req.userId, title, ids) });
}));

api.get('/conversations/:id', requireAuth, wrap((req, res) => {
  const conv = getConversation(Number(req.params.id));
  if (!conv) throw new ApiError(404, 'Чат не найден');
  assertMember(req.userId, conv.id);
  res.json({ conversation: serializeConversation(conv, req.userId) });
}));

api.patch('/conversations/:id', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  res.json({ conversation: updateConversation(req.userId, Number(req.params.id), req.body || {}) });
}));

api.post('/conversations/:id/members', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const ids = (req.body || {}).memberIds ?? (req.body || {}).member_ids ?? [];
  if (!Array.isArray(ids)) throw new ApiError(400, 'memberIds должен быть массивом');
  res.json({ conversation: addMembers(req.userId, Number(req.params.id), ids) });
}));

api.delete('/conversations/:id/members/:userId', requireAuth, wrap((req, res) => {
  res.json(removeMember(req.userId, Number(req.params.id), Number(req.params.userId)));
}));

api.get('/conversations/:id/members', requireAuth, wrap((req, res) => {
  assertMember(req.userId, Number(req.params.id));
  res.json({ memberIds: memberIdsOf(Number(req.params.id)) });
}));

api.post('/conversations/:id/read', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  res.json(markRead(req.userId, Number(req.params.id), (req.body || {}).messageId ?? (req.body || {}).message_id));
}));

api.get('/conversations/:id/messages', requireAuth, wrap((req, res) => {
  const { messages, hasMore } = listMessages(req.userId, Number(req.params.id), {
    before: req.query.before ? Number(req.query.before) : null,
    after: req.query.after ? Number(req.query.after) : null,
    limit: Number(req.query.limit) || config.pageLimit,
  });
  res.json({ messages, hasMore });
}));

api.post('/conversations/:id/messages', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const b = req.body || {};
  const message = sendMessage(req.userId, Number(req.params.id), {
    body: b.body, replyToId: b.replyToId ?? b.reply_to_id, attachmentId: b.attachmentId ?? b.attachment_id,
  });
  res.status(201).json({ message });
}));

api.post('/conversations/:id/typing', requireAuth, wrap((req, res) => {
  assertMember(req.userId, Number(req.params.id));
  emit('typing', {
    conversationId: Number(req.params.id), userId: req.userId, memberIds: memberIdsOf(Number(req.params.id)),
  });
  res.json({ ok: true });
}));

/* ------------------------------- Сообщения --------------------------------- */

api.patch('/messages/:id', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  res.json({ message: editMessage(req.userId, Number(req.params.id), (req.body || {}).body) });
}));

api.delete('/messages/:id', requireAuth, wrap((req, res) => {
  res.json(deleteMessage(req.userId, Number(req.params.id)));
}));

api.post('/messages/:id/reactions', requireAuth, express.json({ limit: '64kb' }), wrap((req, res) => {
  const { emoji, remove } = req.body || {};
  res.json({ message: toggleReaction(req.userId, Number(req.params.id), emoji, !remove) });
}));

api.delete('/messages/:id/reactions', requireAuth, wrap((req, res) => {
  res.json({ message: toggleReaction(req.userId, Number(req.params.id), req.query.emoji || '👍', false) });
}));

/* --------------------------------- Поиск ----------------------------------- */

api.get('/search', requireAuth, wrap((req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ query: '', users: [], messages: [] });
  res.json({
    query: q,
    users: searchUsers(req.userId, q, 10),
    messages: searchMessages(req.userId, q, {
      conversationId: req.query.conversationId ? Number(req.query.conversationId) : null,
      limit: 40,
    }),
  });
}));

/* -------------------------------- Вложения --------------------------------- */

// type: () => true — body-parser по умолчанию пропускает запросы без Content-Type,
// а клиент (undici/fetch, curl -T) его часто не ставит при загрузке бинаря.
api.post('/attachments', requireAuth, express.raw({ type: () => true, limit: config.maxUploadBytes }), wrap((req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buf.length) throw new ApiError(400, 'Пустой файл');
  if (buf.length > config.maxUploadBytes) {
    throw new ApiError(413, `Файл больше ${Math.round(config.maxUploadBytes / 1024 / 1024)} МБ`);
  }
  let filename = 'file';
  try {
    filename = decodeURIComponent(String(req.headers['x-filename'] || '')) || 'file';
  } catch {
    filename = 'file';
  }
  filename = path.basename(filename).slice(0, 180);
  const mime = sanitizeText(req.headers['content-type'], 120) || 'application/octet-stream';
  const id = crypto.randomBytes(12).toString('hex');
  const ext = path.extname(filename).slice(0, 12) || '';
  const rel = path.join('uploads', `${id}${ext}`);
  fs.writeFileSync(path.join(config.dataDir, rel), buf, { mode: 0o600 });
  const attachment = createAttachment({ ownerId: req.userId, filename, mime, size: buf.length, path: rel });
  res.status(201).json({ attachment });
}));

api.get('/attachments/:id/download', requireAuth, wrap((req, res) => {
  const row = get('SELECT * FROM attachments WHERE id = ?', Number(req.params.id));
  if (!row) throw new ApiError(404, 'Вложение не найдено');
  // Доступ — только участникам чата, где вложение использовано, либо владельцу
  const ownerId = Number(req.userId);
  const allowed = Number(row.owner_id) === ownerId
    || Boolean(get(
      `SELECT 1 FROM messages m
         JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
        WHERE m.attachment_id = ? LIMIT 1`, ownerId, Number(row.id),
    ));
  if (!allowed) throw new ApiError(403, 'Нет доступа к вложению');
  const abs = path.join(config.dataDir, row.path);
  if (!fs.existsSync(abs)) throw new ApiError(410, 'Файл недоступен');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `${req.query.inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(abs).pipe(res);
}));

/* -------------------------------- Здоровье --------------------------------- */

api.get('/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), uptime: process.uptime() });
});

/** Единый обработчик ошибок доменного слоя. */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Слишком большой запрос' });
  }
  if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(String(err?.message))) {
    return res.status(409).json({ error: 'Такая запись уже существует' });
  }
  console.error('[api]', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
}
