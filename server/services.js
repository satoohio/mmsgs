import { db, all, get, run, tx, now } from './db.js';
import { sanitizeText, colorFor, hashPassword, verifyPassword } from './auth.js';
import { foldCase, escapeLike, highlight } from './text.js';
import { emit } from './bus.js';
import { isOnline, onlineIds } from './presence.js';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new ApiError(400, msg, details);
const notFound = (msg = 'Не найдено') => new ApiError(404, msg);
const forbidden = (msg = 'Нет доступа') => new ApiError(403, msg);

/* ============================== ПОЛЬЗОВАТЕЛИ =============================== */

const USER_PUBLIC_FIELDS = `id, username, display_name, avatar_color, bio, created_at, last_seen_at`;

export function getUserById(id) {
  return get(`SELECT ${USER_PUBLIC_FIELDS} FROM users WHERE id = ?`, Number(id));
}

export function getUserByUsername(username) {
  return get(`SELECT id, username, display_name, password_hash, avatar_color, bio, created_at, last_seen_at
              FROM users WHERE username_lower = ?`, foldCase(String(username)));
}

/** Строка с хэшем пароля — только для проверки/смены пароля, наружу не отдаётся. */
export function getUserAuthById(id) {
  return get(`SELECT id, username, password_hash FROM users WHERE id = ?`, Number(id));
}

/** Смена пароля: проверяем текущий и пишем новый хэш. */
export function changePassword(userId, currentPassword, newPassword) {
  const row = getUserAuthById(userId);
  if (!row) throw notFound('Пользователь не найден');
  if (!verifyPassword(String(currentPassword ?? ''), row.password_hash)) {
    throw forbidden('Текущий пароль указан неверно');
  }
  if (String(newPassword ?? '').length < 6) throw badRequest('Новый пароль: минимум 6 символов');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(newPassword)), Number(userId));
  return getUserById(userId);
}

export function serializeUser(row, viewerId = null) {
  if (!row) return null;
  const user = {
    id: Number(row.id),
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    bio: row.bio,
    createdAt: Number(row.created_at),
    lastSeenAt: row.last_seen_at == null ? null : Number(row.last_seen_at),
    online: isOnline(row.id),
  };
  if (viewerId && Number(viewerId) === user.id) user.isSelf = true;
  return user;
}

export function serializeUsers(rows, viewerId = null) {
  return (rows || []).map((r) => serializeUser(r, viewerId));
}

export function createUser({ username, displayName, passwordHash, email = null }) {
  const ts = now();
  const login = String(username).trim();
  const name = sanitizeText(displayName, 48) || login;
  const res = run(
    `INSERT INTO users (username, display_name, email, password_hash, avatar_color, bio, created_at,
                        username_lower, display_name_lower)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
    login,
    name,
    email ? String(email).toLowerCase().trim() : null,
    passwordHash,
    colorFor(login),
    ts,
    foldCase(login),
    foldCase(name),
  );
  return getUserById(res.lastInsertRowid);
}

export function updateUser(id, patch) {
  const fields = [];
  const values = [];
  if (patch.displayName !== undefined) {
    const name = sanitizeText(patch.displayName, 48);
    fields.push('display_name = ?', 'display_name_lower = ?');
    values.push(name, foldCase(name));
  }
  if (patch.bio !== undefined) {
    fields.push('bio = ?');
    values.push(sanitizeText(patch.bio, 280));
  }
  if (patch.avatarColor !== undefined) {
    fields.push('avatar_color = ?');
    values.push(/^#[0-9a-fA-F]{6}$/.test(patch.avatarColor) ? patch.avatarColor : colorFor(id));
  }
  if (patch.passwordHash !== undefined) {
    fields.push('password_hash = ?');
    values.push(patch.passwordHash);
  }
  if (!fields.length) return getUserById(id);
  values.push(Number(id));
  run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, ...values);
  const user = getUserById(id);
  emit('user:updated', { userId: Number(id), user: serializeUser(user) });
  return user;
}

export function touchLastSeen(id) {
  run('UPDATE users SET last_seen_at = ? WHERE id = ?', now(), Number(id));
}

/**
 * Поиск людей: по логину, имени или подстроке. Исключает самого ищущего.
 * Возвращает сразу и статус отношений, чтобы фронт рисовал нужную кнопку.
 */
export function searchUsers(viewerId, query, limit = 20) {
  const q = sanitizeText(query, 64);
  if (!q) return [];
  const folded = foldCase(q);
  const like = `%${escapeLike(folded)}%`;
  const prefix = `${escapeLike(folded)}%`;
  const rows = all(
    `SELECT ${USER_PUBLIC_FIELDS} FROM users
      WHERE id != ? AND (username_lower LIKE ? ESCAPE '\\' OR display_name_lower LIKE ? ESCAPE '\\')
      ORDER BY
        CASE WHEN username_lower = ? THEN 0
             WHEN display_name_lower = ? THEN 1
             WHEN username_lower LIKE ? ESCAPE '\\' THEN 2
             ELSE 3 END,
        length(username), username
      LIMIT ?`,
    Number(viewerId), like, like, folded, folded, prefix, Number(limit),
  );
  return rows.map((row) => ({
    ...serializeUser(row, viewerId),
    relation: friendState(viewerId, row.id),
  }));
}

/** Кого можно добавить: последние зарегистрированные, кроме друзей и себя. */
export function suggestUsers(viewerId, limit = 20) {
  const rows = all(
    `SELECT ${USER_PUBLIC_FIELDS} FROM users
      WHERE id != ?
        AND id NOT IN (SELECT friend_id FROM friendships WHERE user_id = ?)
      ORDER BY created_at DESC LIMIT ?`,
    Number(viewerId), Number(viewerId), Number(limit),
  );
  return rows.map((row) => ({ ...serializeUser(row, viewerId), relation: friendState(viewerId, row.id) }));
}

/* ================================ ДРУЗЬЯ =================================== */

/**
 * Отношение viewer -> target:
 *   friends | outgoing (ждёт ответа от target) | incoming (ждёт нашего ответа)
 *   blocked | blocked_by | none
 */
export function friendState(viewerId, targetId) {
  viewerId = Number(viewerId);
  targetId = Number(targetId);
  if (!viewerId || !targetId || viewerId === targetId) return 'self';
  if (get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', viewerId, targetId)) return 'friends';
  if (get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', viewerId, targetId)) return 'blocked';
  if (get('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', targetId, viewerId)) return 'blocked_by';
  const pending = get(
    `SELECT from_user_id, to_user_id FROM friend_requests
      WHERE status = 'pending' AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
    viewerId, targetId, targetId, viewerId,
  );
  if (pending) return Number(pending.from_user_id) === viewerId ? 'outgoing' : 'incoming';
  return 'none';
}

export function listFriends(userId) {
  const rows = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.bio, u.created_at, u.last_seen_at,
            f.since,
            (SELECT c.id FROM conversations c
               JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = ?
               JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = u.id
              WHERE c.type = 'direct' LIMIT 1) AS conversation_id
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?
      ORDER BY u.display_name COLLATE NOCASE`,
    Number(userId), Number(userId),
  );
  return rows.map((r) => ({
    ...serializeUser(r, userId),
    since: Number(r.since),
    conversationId: r.conversation_id == null ? null : Number(r.conversation_id),
  }));
}

export function listFriendRequests(userId, direction = 'incoming') {
  const column = direction === 'outgoing' ? 'from_user_id' : 'to_user_id';
  const rows = all(
    `SELECT fr.id, fr.from_user_id, fr.to_user_id, fr.status, fr.message, fr.created_at, fr.updated_at,
            u.id AS u_id, u.username, u.display_name, u.avatar_color, u.bio, u.created_at AS u_created_at, u.last_seen_at
       FROM friend_requests fr
       JOIN users u ON u.id = (CASE WHEN fr.from_user_id = ? THEN fr.to_user_id ELSE fr.from_user_id END)
      WHERE fr.${column} = ? AND fr.status = 'pending'
      ORDER BY fr.created_at DESC`,
    Number(userId), Number(userId),
  );
  return rows.map((r) => ({
    id: Number(r.id),
    status: r.status,
    message: r.message,
    createdAt: Number(r.created_at),
    direction: Number(r.from_user_id) === Number(userId) ? 'outgoing' : 'incoming',
    user: serializeUser({
      id: r.u_id, username: r.username, display_name: r.display_name,
      avatar_color: r.avatar_color, bio: r.bio, created_at: r.u_created_at, last_seen_at: r.last_seen_at,
    }, userId),
  }));
}

export function sendFriendRequest(fromUserId, targetUsernameOrId, message = '') {
  const target = Number.isFinite(Number(targetUsernameOrId)) && String(targetUsernameOrId).trim() !== ''
    ? get(`SELECT id, username FROM users WHERE id = ?`, Number(targetUsernameOrId))
    : getUserByUsername(String(targetUsernameOrId).replace(/^@/, '').trim());
  if (!target) throw notFound('Пользователь не найден');

  const fromId = Number(fromUserId);
  const toId = Number(target.id);
  if (fromId === toId) throw badRequest('Нельзя добавить себя в друзья');

  const state = friendState(fromId, toId);
  if (state === 'friends') throw badRequest('Вы уже в друзьях');
  if (state === 'blocked') throw badRequest('Пользователь в чёрном списке');
  if (state === 'blocked_by') throw forbidden('Пользователь ограничил общение с вами');
  if (state === 'outgoing') throw badRequest('Заявка уже отправлена');

  // Встречная заявка — сразу дружим
  if (state === 'incoming') {
    const pending = get(
      `SELECT id FROM friend_requests WHERE status = 'pending' AND from_user_id = ? AND to_user_id = ?`,
      toId, fromId,
    );
    return acceptFriendRequest(fromId, pending.id, { notifyAsAccept: true });
  }

  const ts = now();
  const res = tx(() => {
    const r = run(
      `INSERT INTO friend_requests (from_user_id, to_user_id, status, message, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?)`,
      fromId, toId, sanitizeText(message, 280), ts, ts,
    );
    return get(`SELECT * FROM friend_requests WHERE id = ?`, r.lastInsertRowid);
  });

  const request = {
    id: Number(res.id),
    fromUserId: fromId,
    toUserId: toId,
    status: 'pending',
    message: res.message,
    createdAt: Number(res.created_at),
    direction: 'incoming',
    user: serializeUser(getUserById(fromId)),
  };
  emit('friend:request', { toUserId: toId, request });
  return request;
}

function findRequestFor(userId, requestId) {
  const row = get(`SELECT * FROM friend_requests WHERE id = ?`, Number(requestId));
  if (!row) throw notFound('Заявка не найдена');
  if (Number(row.from_user_id) !== Number(userId) && Number(row.to_user_id) !== Number(userId)) {
    throw forbidden('Это не ваша заявка');
  }
  return row;
}

export function acceptFriendRequest(userId, requestId, opts = {}) {
  const row = findRequestFor(userId, requestId);
  if (row.status !== 'pending') throw badRequest('Заявка уже обработана');
  const a = Number(row.from_user_id);
  const b = Number(row.to_user_id);
  const ts = now();
  tx(() => {
    run(`UPDATE friend_requests SET status = 'accepted', updated_at = ? WHERE id = ?`, ts, Number(row.id));
    run(`INSERT OR IGNORE INTO friendships (user_id, friend_id, since) VALUES (?, ?, ?)`, a, b, ts);
    run(`INSERT OR IGNORE INTO friendships (user_id, friend_id, since) VALUES (?, ?, ?)`, b, a, ts);
  });
  const request = {
    id: Number(row.id), fromUserId: a, toUserId: b, status: 'accepted', updatedAt: ts,
    user: serializeUser(getUserById(a)), otherUser: serializeUser(getUserById(b)),
  };
  // Обеим сторонам полезно знать, что дружба установлена
  emit('friend:accepted', { userId: a, request });
  if (!opts.notifyAsAccept) emit('friend:accepted', { userId: b, request });

  // Личный чат создаём сразу: у обоих он должен появиться в списке без перезагрузки
  const direct = getOrCreateDirect(a, b);
  emit('conversation:new', {
    conversation: { id: Number(direct.id) },
    memberIds: [a, b],
  });
  return request;
}

export function declineFriendRequest(userId, requestId) {
  const row = findRequestFor(userId, requestId);
  if (row.status !== 'pending') throw badRequest('Заявка уже обработана');
  run(`UPDATE friend_requests SET status = ?, updated_at = ? WHERE id = ?`,
    Number(row.from_user_id) === Number(userId) ? 'cancelled' : 'declined', now(), Number(row.id));
  return { id: Number(row.id), status: 'declined' };
}

export function removeFriend(userId, friendId) {
  const a = Number(userId);
  const b = Number(friendId);
  tx(() => {
    run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', a, b);
    run('DELETE FROM friendships WHERE user_id = ? AND friend_id = ?', b, a);
    run(`UPDATE friend_requests SET status = 'cancelled', updated_at = ?
          WHERE status = 'accepted' AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
      now(), a, b, b, a);
  });
  emit('friend:removed', { userId: a, friendId: b });
  emit('friend:removed', { userId: b, friendId: a });
  return { ok: true };
}

export function setBlock(userId, blockedId, blocked) {
  const a = Number(userId);
  const b = Number(blockedId);
  if (a === b) throw badRequest('Нельзя заблокировать себя');
  if (!getUserById(b)) throw notFound('Пользователь не найден');
  tx(() => {
    if (blocked) {
      run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)', a, b, now());
      run('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', a, b, b, a);
      run(`UPDATE friend_requests SET status = 'cancelled', updated_at = ?
            WHERE status = 'pending' AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
        now(), a, b, b, a);
    } else {
      run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', a, b);
    }
  });
  return { blocked, relation: friendState(a, b) };
}

export function listBlocked(userId) {
  const rows = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.bio, u.created_at, u.last_seen_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.user_id = ? ORDER BY b.created_at DESC`,
    Number(userId),
  );
  return serializeUsers(rows, userId);
}

/* ================================ ЧАТЫ ===================================== */

export function memberIdsOf(conversationId) {
  return all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', Number(conversationId))
    .map((r) => Number(r.user_id));
}

export function assertMember(userId, conversationId) {
  const row = get(
    'SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    Number(conversationId), Number(userId),
  );
  if (!row) throw forbidden('Вы не участник этого чата');
  return row;
}

export function getConversation(id) {
  return get('SELECT * FROM conversations WHERE id = ?', Number(id));
}

export function serializeMessage(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    conversationId: Number(row.conversation_id),
    sender: serializeUser(row.sender_id !== undefined
      ? { id: row.sender_id, username: row.sender_username, display_name: row.sender_display_name,
          avatar_color: row.sender_avatar_color, bio: '', created_at: 0, last_seen_at: null }
      : getUserById(row.sender_id)),
    body: row.deleted_at ? '' : row.body,
    deleted: Boolean(row.deleted_at),
    editedAt: row.edited_at == null ? null : Number(row.edited_at),
    createdAt: Number(row.created_at),
    replyTo: row.reply_to_id == null ? null : Number(row.reply_to_id),
    attachment: row.attachment_id == null ? null : getAttachment(row.attachment_id),
    reactions: listReactions(row.id),
    clientId: row.client_id || undefined,
  };
}

const MESSAGE_SELECT = `
  SELECT m.*,
         u.id AS sender_id, u.username AS sender_username,
         u.display_name AS sender_display_name, u.avatar_color AS sender_avatar_color
    FROM messages m JOIN users u ON u.id = m.sender_id`;

export function serializeConversation(row, viewerId) {
  const viewerIdNum = Number(viewerId);
  const members = all(
    `SELECT u.id, u.username, u.display_name, u.avatar_color, u.bio, u.created_at, u.last_seen_at,
            cm.role, cm.last_read_message_id, cm.muted
       FROM conversation_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id = ?
      ORDER BY u.display_name COLLATE NOCASE`,
    Number(row.id),
  );
  const membership = members.find((m) => Number(m.id) === viewerIdNum);
  const peer = row.type === 'direct' ? members.find((m) => Number(m.id) !== viewerIdNum) : null;

  const lastMessage = get(
    `${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1`,
    Number(row.id),
  );
  const unread = membership
    ? Number(get(
        `SELECT COUNT(*) AS c FROM messages
          WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted_at IS NULL`,
        Number(row.id), Number(membership.last_read_message_id || 0), viewerIdNum,
      ).c)
    : 0;

  return {
    id: Number(row.id),
    type: row.type,
    title: row.type === 'group' ? row.title : peer ? peer.display_name : 'Диалог',
    topic: row.topic || '',
    avatarColor: row.type === 'group' ? colorFor(`conv:${row.id}`) : peer ? peer.avatar_color : '#6c8cff',
    createdAt: Number(row.created_at),
    lastMessageAt: row.last_message_at == null ? null : Number(row.last_message_at),
    members: members.map((m) => ({ ...serializeUser(m, viewerId), role: m.role })),
    memberIds: members.map((m) => Number(m.id)),
    peer: peer ? serializeUser(peer, viewerId) : null,
    lastMessage: lastMessage ? serializeMessage(lastMessage) : null,
    unread,
    muted: Boolean(membership?.muted),
    role: membership?.role || 'member',
    lastReadMessageId: Number(membership?.last_read_message_id || 0),
  };
}

export function listConversations(userId) {
  const rows = all(
    `SELECT c.* FROM conversations c
       JOIN conversation_members m ON m.conversation_id = c.id
      WHERE m.user_id = ?
      ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    Number(userId),
  );
  return rows.map((row) => serializeConversation(row, userId));
}

/** Только поиск существующего личного чата (без создания). */
export function findDirectConversation(aId, bId) {
  const pairKey = [Math.min(Number(aId), Number(bId)), Math.max(Number(aId), Number(bId))].join(':');
  return get('SELECT * FROM conversations WHERE pair_key = ?', pairKey) || null;
}

/** Личный чат: находим существующий по паре участников или создаём. */
export function getOrCreateDirect(aId, bId) {
  const a = Number(aId);
  const b = Number(bId);
  if (a === b) throw badRequest('Нельзя создать чат с собой');
  if (!getUserById(a) || !getUserById(b)) throw notFound('Пользователь не найден');

  const existing = findDirectConversation(a, b);
  if (existing) {
    // Участник мог покинуть диалог — возвращаем обратно
    tx(() => {
      for (const id of [a, b]) {
        run(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
             VALUES (?, ?, 'member', ?) ON CONFLICT(conversation_id, user_id) DO NOTHING`,
          Number(existing.id), id, now());
      }
    });
    return existing;
  }

  const pairKey = [Math.min(a, b), Math.max(a, b)].join(':');
  const ts = now();
  return tx(() => {
    const conv = run(
      `INSERT INTO conversations (type, title, topic, pair_key, created_by, created_at)
       VALUES ('direct', '', '', ?, ?, ?)`,
      pairKey, a, ts,
    );
    for (const id of [a, b]) {
      run(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        conv.lastInsertRowid, id, ts);
    }
    return get('SELECT * FROM conversations WHERE id = ?', conv.lastInsertRowid);
  });
}

export function createGroup(creatorId, title, memberIds = []) {
  const clean = sanitizeText(title, 60);
  if (clean.length < 2) throw badRequest('Название группы: минимум 2 символа');
  const ids = [...new Set([Number(creatorId), ...memberIds.map(Number)].filter((n) => Number.isFinite(n)))];
  if (ids.length < 2) throw badRequest('Добавьте хотя бы одного участника');
  const existing = ids.filter((id) => getUserById(id));
  if (existing.length !== ids.length) throw badRequest('Не все участники найдены');

  const ts = now();
  const conv = tx(() => {
    const c = run(
      `INSERT INTO conversations (type, title, topic, pair_key, created_by, created_at)
       VALUES ('group', ?, '', NULL, ?, ?)`,
      clean, Number(creatorId), ts,
    );
    for (const id of existing) {
      run(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)`,
        c.lastInsertRowid, id, id === Number(creatorId) ? 'owner' : 'member', ts);
    }
    return get('SELECT * FROM conversations WHERE id = ?', c.lastInsertRowid);
  });

  const serialized = serializeConversation(conv, creatorId);
  emit('conversation:new', { conversation: serialized, memberIds: existing });
  return serialized;
}

export function updateConversation(userId, conversationId, patch) {
  const conv = getConversation(conversationId);
  if (!conv) throw notFound('Чат не найден');
  assertMember(userId, conversationId);
  if (conv.type !== 'group') throw badRequest('Название можно менять только у группы');
  const membership = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    Number(conversationId), Number(userId));
  if (membership.role === 'member') throw forbidden('Менять группу может только владелец');
  if (patch.title !== undefined) {
    const title = sanitizeText(patch.title, 60);
    if (title.length < 2) throw badRequest('Название группы: минимум 2 символа');
    run('UPDATE conversations SET title = ? WHERE id = ?', title, Number(conversationId));
  }
  if (patch.topic !== undefined) {
    run('UPDATE conversations SET topic = ? WHERE id = ?', sanitizeText(patch.topic, 140), Number(conversationId));
  }
  const serialized = serializeConversation(getConversation(conversationId), userId);
  emit('conversation:updated', { conversation: serialized, memberIds: serialized.memberIds });
  return serialized;
}

export function addMembers(userId, conversationId, memberIds) {
  const conv = getConversation(conversationId);
  if (!conv) throw notFound('Чат не найден');
  const membership = assertMember(userId, conversationId);
  if (conv.type === 'direct') throw badRequest('В личный чат нельзя добавить участников');
  const isOwner = membership.role === 'owner';
  const ids = [...new Set(memberIds.map(Number))].filter((id) => id && id !== Number(userId));
  if (!ids.length) throw badRequest('Некого добавлять');

  const current = new Set(memberIdsOf(conversationId));
  const added = [];
  tx(() => {
    for (const id of ids) {
      if (current.has(id)) continue;
      if (!getUserById(id)) continue;
      // В группу может добавлять владелец либо друг приглашаемого (упрощённая модель)
      if (!isOwner && friendState(userId, id) !== 'friends') continue;
      run(`INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)`,
        Number(conversationId), id, now());
      added.push(id);
    }
  });
  if (!added.length) throw forbidden('Не удалось добавить участников');
  const serialized = serializeConversation(getConversation(conversationId), userId);
  emit('member:added', {
    conversationId: Number(conversationId), memberIds: serialized.memberIds, addedIds: added,
  });
  return serialized;
}

export function removeMember(actorId, conversationId, targetId) {
  const conv = getConversation(conversationId);
  if (!conv) throw notFound('Чат не найден');
  if (conv.type === 'direct') throw badRequest('Из личного чата нельзя удалять участников');
  const actor = assertMember(actorId, conversationId);
  const me = Number(actorId) === Number(targetId);
  if (!me) {
    if (actor.role === 'member') throw forbidden('Удалять участников может только владелец группы');
    const target = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      Number(conversationId), Number(targetId));
    if (!target) throw notFound('Участник не найден');
    if (target.role === 'owner') throw forbidden('Владельца нельзя исключить');
  }
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    Number(conversationId), Number(targetId));
  const remaining = memberIdsOf(conversationId);
  emit('member:removed', {
    conversationId: Number(conversationId),
    memberIds: remaining,
    removedId: Number(targetId),
    left: me,
  });
  return { ok: true, left: me, memberIds: remaining };
}

/* ============================== СООБЩЕНИЯ ================================== */

export function listMessages(userId, conversationId, { before = null, limit = 50, after = null } = {}) {
  assertMember(userId, conversationId);
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const conditions = ['m.conversation_id = ?'];
  const params = [Number(conversationId)];
  if (before) {
    conditions.push('m.id < ?');
    params.push(Number(before));
  }
  if (after) {
    conditions.push('m.id > ?');
    params.push(Number(after));
  }
  params.push(cap + 1);
  const rows = all(
    `${MESSAGE_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
    ...params,
  );
  const hasMore = rows.length > cap;
  const page = rows.slice(0, cap).reverse();
  return { messages: page.map(serializeMessage), hasMore };
}

export function sendMessage(userId, conversationId, payload) {
  const conv = getConversation(conversationId);
  if (!conv) throw notFound('Чат не найден');
  assertMember(userId, conversationId);

  const body = sanitizeText(payload.body, 4000);
  const attachmentId = payload.attachmentId ? Number(payload.attachmentId) : null;
  if (!body && !attachmentId) throw badRequest('Пустое сообщение');

  if (attachmentId) {
    const att = get('SELECT * FROM attachments WHERE id = ?', attachmentId);
    if (!att) throw badRequest('Вложение не найдено');
    if (Number(att.owner_id) !== Number(userId)) throw forbidden('Чужое вложение');
  }

  let replyTo = null;
  if (payload.replyToId) {
    replyTo = get('SELECT id FROM messages WHERE id = ? AND conversation_id = ?',
      Number(payload.replyToId), Number(conversationId));
    if (!replyTo) throw badRequest('Сообщение для ответа не найдено');
    replyTo = Number(replyTo.id);
  }

  const ts = now();
  const res = tx(() => {
    const m = run(
      `INSERT INTO messages (conversation_id, sender_id, body, body_fold, reply_to_id, attachment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      Number(conversationId), Number(userId), body, foldCase(body), replyTo, attachmentId, ts,
    );
    run('UPDATE conversations SET last_message_at = ? WHERE id = ?', ts, Number(conversationId));
    // Автор считает своё сообщение прочитанным
    run('UPDATE conversation_members SET last_read_message_id = MAX(last_read_message_id, ?) WHERE conversation_id = ? AND user_id = ?',
      m.lastInsertRowid, Number(conversationId), Number(userId));
    return m.lastInsertRowid;
  });

  const message = serializeMessage(get(`${MESSAGE_SELECT} WHERE m.id = ?`, res));
  const members = memberIdsOf(conversationId);
  const conversation = serializeConversation(getConversation(conversationId), userId);
  emit('message:new', {
    conversationId: Number(conversationId),
    message,
    memberIds: members,
    conversation,
    // Временный id клиента — чтобы отправитель сопоставил оптимистичный пузырёк
    clientId: payload.clientId || null,
  });
  return message;
}

export function editMessage(userId, messageId, body) {
  const row = get('SELECT * FROM messages WHERE id = ?', Number(messageId));
  if (!row) throw notFound('Сообщение не найдено');
  if (Number(row.sender_id) !== Number(userId)) throw forbidden('Можно редактировать только свои сообщения');
  if (row.deleted_at) throw badRequest('Сообщение удалено');
  const clean = sanitizeText(body, 4000);
  if (!clean) throw badRequest('Пустое сообщение');
  if (clean === row.body) return serializeMessage(get(`${MESSAGE_SELECT} WHERE m.id = ?`, row.id));
  run('UPDATE messages SET body = ?, body_fold = ?, edited_at = ? WHERE id = ?',
    clean, foldCase(clean), now(), Number(messageId));
  const message = serializeMessage(get(`${MESSAGE_SELECT} WHERE m.id = ?`, Number(messageId)));
  emit('message:updated', {
    conversationId: Number(row.conversation_id), message, memberIds: memberIdsOf(row.conversation_id),
  });
  return message;
}

export function deleteMessage(userId, messageId) {
  const row = get('SELECT * FROM messages WHERE id = ?', Number(messageId));
  if (!row) throw notFound('Сообщение не найдено');
  const conv = getConversation(row.conversation_id);
  const membership = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    Number(row.conversation_id), Number(userId));
  const isOwner = membership && membership.role === 'owner';
  if (Number(row.sender_id) !== Number(userId) && !isOwner) {
    throw forbidden('Можно удалять только свои сообщения');
  }
  run(`UPDATE messages SET deleted_at = ?, body = '', body_fold = '', attachment_id = NULL WHERE id = ?`,
    now(), Number(messageId));
  const members = memberIdsOf(row.conversation_id);
  const conversation = conv ? serializeConversation(getConversation(row.conversation_id), userId) : null;
  emit('message:deleted', {
    conversationId: Number(row.conversation_id), messageId: Number(messageId), memberIds: members, conversation,
  });
  return { ok: true, id: Number(messageId) };
}

export function markRead(userId, conversationId, messageId) {
  assertMember(userId, conversationId);
  const target = Number(messageId || 0);
  run(`UPDATE conversation_members
          SET last_read_message_id = MAX(last_read_message_id, ?)
        WHERE conversation_id = ? AND user_id = ?`,
    target, Number(conversationId), Number(userId));
  emit('read', {
    conversationId: Number(conversationId), userId: Number(userId),
    messageId: target, memberIds: memberIdsOf(conversationId),
  });
  return { ok: true };
}

export function listReactions(messageId) {
  return all('SELECT user_id, emoji FROM reactions WHERE message_id = ?', Number(messageId))
    .reduce((acc, r) => {
      acc[r.emoji] = acc[r.emoji] || [];
      acc[r.emoji].push(Number(r.user_id));
      return acc;
    }, {});
}

export function toggleReaction(userId, messageId, emoji, on) {
  const row = get('SELECT * FROM messages WHERE id = ?', Number(messageId));
  if (!row) throw notFound('Сообщение не найдено');
  assertMember(userId, row.conversation_id);
  const clean = sanitizeText(emoji, 8) || '👍';
  if (on === false) {
    run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      Number(messageId), Number(userId), clean);
  } else {
    run('INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      Number(messageId), Number(userId), clean, now());
  }
  const message = serializeMessage(get(`${MESSAGE_SELECT} WHERE m.id = ?`, Number(messageId)));
  emit('message:updated', {
    conversationId: Number(row.conversation_id), message, memberIds: memberIdsOf(row.conversation_id),
  });
  return message;
}

/** Поиск по текстам сообщений в чатах пользователя. */
export function searchMessages(userId, query, { conversationId = null, limit = 40 } = {}) {
  const q = sanitizeText(query, 120);
  if (!q) return [];
  const like = `%${escapeLike(foldCase(q))}%`;
  const params = [Number(userId), like];
  let convFilter = '';
  if (conversationId) {
    convFilter = ' AND m.conversation_id = ?';
    params.push(Number(conversationId));
  }
  params.push(Math.min(Math.max(Number(limit) || 40, 1), 200));
  const rows = all(
    `${MESSAGE_SELECT}
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
     WHERE m.deleted_at IS NULL AND m.body_fold LIKE ? ESCAPE '\\'${convFilter}
     ORDER BY m.id DESC LIMIT ?`,
    ...params,
  );
  return rows.map((row) => ({
    message: serializeMessage(row),
    // Подсветка совпадений частями — клиенту не нужно возиться с HTML-экранированием
    matches: highlight(row.body, q),
    conversation: serializeConversation(getConversation(row.conversation_id), userId),
  }));
}

/* =============================== ВЛОЖЕНИЯ ================================== */

export function createAttachment({ ownerId, filename, mime, size, path: filePath }) {
  const res = run(
    `INSERT INTO attachments (owner_id, filename, mime, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    Number(ownerId), sanitizeText(filename, 180) || 'file', sanitizeText(mime, 120) || 'application/octet-stream',
    Number(size), filePath, now(),
  );
  return getAttachment(res.lastInsertRowid);
}

export function getAttachment(id) {
  const row = get('SELECT * FROM attachments WHERE id = ?', Number(id));
  if (!row) return null;
  return {
    id: Number(row.id),
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size),
    url: `/api/attachments/${row.id}/download`,
    isImage: /^image\//.test(row.mime),
  };
}

/* ================================ СВОДКА =================================== */

/** Один запрос вместо пяти при первом открытии приложения. */
export function bootstrap(userId) {
  const me = serializeUser(getUserById(userId), userId);
  const friends = listFriends(userId);
  const conversations = listConversations(userId);
  return {
    me,
    friends,
    conversations,
    incomingRequests: listFriendRequests(userId, 'incoming'),
    outgoingRequests: listFriendRequests(userId, 'outgoing'),
    blocked: listBlocked(userId),
    online: [...onlineIds([...friends.map((f) => f.id), ...conversations.flatMap((c) => c.memberIds)])],
    serverTime: now(),
  };
}

export { db };
