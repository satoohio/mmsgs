import { DatabaseSync } from 'node:sqlite';
import config from './config.js';
import { foldCase } from './text.js';

/**
 * Единственное подключение к SQLite (node:sqlite, без нативных зависимостей).
 * WAL даёт конкурентное чтение во время записи — достаточно для однопоточного Node.
 */
export const db = new DatabaseSync(config.dbFile);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 4000;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  email         TEXT    UNIQUE,
  password_hash TEXT    NOT NULL,
  avatar_color  TEXT    NOT NULL DEFAULT '#6c8cff',
  bio           TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER,
  -- Регистронезависимый поиск: встроенные LIKE/LOWER в SQLite работают только
  -- с ASCII, поэтому нижний регистр для кириллицы считаем в JS и храним здесь.
  username_lower     TEXT NOT NULL DEFAULT '',
  display_name_lower TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_users_username_lower ON users(username_lower);
CREATE INDEX IF NOT EXISTS ix_users_display_lower ON users(display_name_lower);

CREATE TABLE IF NOT EXISTS friend_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','declined','cancelled')),
  message      TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- Активной может быть только одна заявка между парой пользователей в каждом направлении
CREATE UNIQUE INDEX IF NOT EXISTS ux_friend_requests_pending
  ON friend_requests(from_user_id, to_user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_friend_requests_to ON friend_requests(to_user_id, status);

CREATE TABLE IF NOT EXISTS friendships (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  since     INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS ix_friendships_friend ON friendships(friend_id);

CREATE TABLE IF NOT EXISTS blocks (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL CHECK (type IN ('direct','group')),
  title           TEXT    NOT NULL DEFAULT '',
  topic           TEXT    NOT NULL DEFAULT '',
  pair_key        TEXT    UNIQUE,          -- "minId:maxId" — уникальность лички
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_conversations_last ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT    NOT NULL DEFAULT 'member'
                       CHECK (role IN ('owner','admin','member')),
  joined_at            INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  muted                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_members_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename   TEXT    NOT NULL,
  mime       TEXT    NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL,
  path       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT    NOT NULL DEFAULT '',
  -- Складка регистра/«ё» для поиска по кириллице (см. text.js)
  body_fold       TEXT    NOT NULL DEFAULT '',
  reply_to_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  attachment_id   INTEGER REFERENCES attachments(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS ix_messages_conv ON messages(conversation_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_messages_created ON messages(created_at DESC);

CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
`);

/* ------------------------------- Миграции ---------------------------------- */

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
}

/**
 * Идемпотентные миграции для баз, созданных ранними версиями схемы.
 * Держим их рядом со схемой: приложение стартует с любой существующей БД.
 */
function migrate() {
  const userCols = tableColumns('users');
  for (const col of ['username_lower', 'display_name_lower']) {
    if (!userCols.has(col)) {
      db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`);
    }
  }
  const messageCols = tableColumns('messages');
  if (!messageCols.has('body_fold')) {
    db.exec(`ALTER TABLE messages ADD COLUMN body_fold TEXT NOT NULL DEFAULT ''`);
  }

  // Пересчитываем складку через JS: SQLite LOWER не складывает кириллицу
  const users = db.prepare('SELECT id, username, display_name FROM users').all();
  const updateUser = db.prepare('UPDATE users SET username_lower = ?, display_name_lower = ? WHERE id = ?');
  for (const row of users) {
    updateUser.run(foldCase(row.username), foldCase(row.display_name), Number(row.id));
  }

  const messages = db.prepare('SELECT id, body, body_fold FROM messages').all();
  const updateMessage = db.prepare('UPDATE messages SET body_fold = ? WHERE id = ?');
  for (const row of messages) {
    const folded = foldCase(row.body);
    if (folded !== row.body_fold) updateMessage.run(folded, Number(row.id));
  }

  db.exec('CREATE INDEX IF NOT EXISTS ix_users_username_lower ON users(username_lower)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_users_display_lower ON users(display_name_lower)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_messages_body_fold ON messages(body_fold)');
}

migrate();

export const now = () => Date.now();

/** Обёртка, которая всегда возвращает обычный number для lastInsertRowid/changes. */
export function run(sql, ...params) {
  const res = db.prepare(sql).run(...params);
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

/** Простая транзакция: fn(...) выполняется в BEGIN IMMEDIATE / COMMIT. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function close() {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
