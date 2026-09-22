import fs from 'node:fs';
import path from 'node:path';
import config from './config.js';

/**
 * Демо-данные: несколько пользователей, дружба, личные и групповые чаты
 * с историей сообщений — чтобы приложение можно было посмотреть сразу.
 *
 *   npm run seed          — добавить демо-данные (идемпотентно)
 *   npm run reset         — удалить БД и пересоздать с нуля
 *   AUTO_SEED=false       — не засевать при старте сервера
 */

const RESET = process.argv.includes('--reset');

function wipe() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = config.dbFile + suffix;
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(config.uploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

if (RESET) {
  wipe();
  console.log('База очищена, пересоздаю…');
}

const { hashPassword } = await import('./auth.js');
const { createUser, getUserByUsername, getOrCreateDirect, createGroup, sendMessage, sendFriendRequest, acceptFriendRequest } =
  await import('./services.js');
const { run, get, now } = await import('./db.js');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const PEOPLE = [
  { username: 'demo',  displayName: 'Демо Пользователь', password: 'demo1234', bio: 'Аккаунт для знакомства с mmsgs' },
  { username: 'anna',  displayName: 'Анна Соколова',     password: 'anna1234', bio: 'Дизайнер, люблю типографику' },
  { username: 'maxim', displayName: 'Максим Ветров',     password: 'max1234',  bio: 'Бэкенд, кофе, велосипед' },
  { username: 'kate',  displayName: 'Екатерина Ли',      password: 'kate1234', bio: 'Продакт в финтехе' },
  { username: 'ivan',  displayName: 'Иван Дорохов',      password: 'ivan1234', bio: 'QA, ломаю то, что вы собрали' },
  { username: 'olga',  displayName: 'Ольга Мирная',      password: 'olga1234', bio: '' },
];

function ensureUser(p) {
  const existing = getUserByUsername(p.username);
  if (existing) return existing;
  return createUser({
    username: p.username,
    displayName: p.displayName,
    passwordHash: hashPassword(p.password),
  });
}

/** Сообщение с «исторической» меткой времени — правим created_at после вставки. */
function seedMessage(userId, conversationId, body, agoMs) {
  const message = sendMessage(userId, conversationId, { body });
  const ts = now() - agoMs;
  run('UPDATE messages SET created_at = ? WHERE id = ?', ts, message.id);
  run('UPDATE conversations SET last_message_at = ? WHERE id = ?', ts, conversationId);
  return message.id;
}

export function ensureSeed() {
  const users = {};
  for (const p of PEOPLE) users[p.username] = ensureUser(p);

  const demo = users.demo.id;
  const anna = users.anna.id;
  const maxim = users.maxim.id;
  const kate = users.kate.id;
  const ivan = users.ivan.id;

  // Дружба: demo <-> anna, maxim, kate; anna <-> maxim; ivan ждёт подтверждения от demo
  const pairs = [[demo, anna], [demo, maxim], [demo, kate], [anna, maxim], [maxim, kate], [anna, kate]];
  for (const [x, y] of pairs) {
    const req = sendFriendRequest(x, y, '');
    if (req?.id) acceptFriendRequest(y, req.id);
  }
  if (!get(`SELECT 1 FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`, ivan, demo)) {
    sendFriendRequest(ivan, demo, 'Привет! Добавь меня, я по поводу тестов.');
  }
  if (!get(`SELECT 1 FROM friend_requests WHERE from_user_id = ? AND to_user_id = ?`, users.olga.id, demo)) {
    sendFriendRequest(users.olga.id, demo, '');
  }

  // Личный чат demo <-> anna
  const directAnna = Number(getOrCreateDirect(demo, anna).id);
  if (Number(get('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?', directAnna).c) === 0) {
    seedMessage(anna, directAnna, 'Привет! Посмотрел mmsgs — как тебе?', 5 * HOUR);
    seedMessage(demo, directAnna, 'Привет! Нормально, realtime работает без лагов', 5 * HOUR - 4 * MINUTE);
    seedMessage(anna, directAnna, 'А групповые чаты уже можно создавать?', 4 * HOUR);
    seedMessage(demo, directAnna, 'Да, кнопка «Новая группа» в сайдбаре', 4 * HOUR - 2 * MINUTE);
    seedMessage(anna, directAnna, 'Отлично, тогда вечером соберём всех в одном чате 👌', 20 * MINUTE);
  }

  // Личный чат demo <-> maxim
  const directMaxim = Number(getOrCreateDirect(demo, maxim).id);
  if (Number(get('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?', directMaxim).c) === 0) {
    seedMessage(maxim, directMaxim, 'Скинь, пожалуйста, ссылку на репозиторий', 2 * DAY);
    seedMessage(demo, directMaxim, 'Держи: github.com/satoohio/mmsgs', 2 * DAY - 10 * MINUTE);
    seedMessage(maxim, directMaxim, 'Спасибо! Гляну схему БД на выходных', 90 * MINUTE);
  }

  // Группа
  const group = get('SELECT * FROM conversations WHERE type = \'group\' AND title = ? AND created_by = ?', 'Команда mmsgs', demo);
  const groupId = group ? Number(group.id) : Number(createGroup(demo, 'Команда mmsgs', [anna, maxim, kate, ivan]).id);
  if (Number(get('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?', groupId).c) === 0) {
    seedMessage(demo, groupId, 'Создал группу для команды — здесь обсуждаем релиз.', 3 * DAY);
    seedMessage(maxim, groupId, 'Отлично. Предлагаю в пятницу выкатить бету.', 3 * DAY - 30 * MINUTE);
    seedMessage(kate, groupId, 'Поддерживаю. Что по списку задач?', 2 * DAY);
    seedMessage(anna, groupId, 'Дизайн чата готов, остались иконки', 2 * DAY - 15 * MINUTE);
    seedMessage(ivan, groupId, 'Прогоню автотесты перед выкаткой 🔧', 6 * HOUR);
    seedMessage(demo, groupId, 'Договорились. Статус — в четверг вечером.', 25 * MINUTE);
    run('UPDATE conversations SET topic = ? WHERE id = ?', 'Релиз, задачи, объявления', groupId);
  }

  console.log('Демо-данные готовы:');
  for (const p of PEOPLE) console.log(`  ${p.username} / ${p.password}  (${p.displayName})`);
  return { users, groupId };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  ensureSeed();
  process.exit(0);
}
