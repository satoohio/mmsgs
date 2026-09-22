# mmsgs — веб-мессенджер

Личные и групповые чаты в реальном времени с авторизацией, друзьями, поиском и вложениями. Одностраничное приложение без сборки: фронтенд — чистый JS + CSS, бэкенд — Node 22, Express, WebSocket, SQLite (`node:sqlite`).

**Live demo** после `npm start`: http://localhost:3000  
Демо-аккаунты (создаются `npm run seed` при первом запуске автоматически):

| логин | пароль | имя |
|-------|--------|-----|
| `demo` | `demo1234` | Демо Пользователь |
| `anna` | `anna1234` | Анна Соколова |
| `maxim` | `max1234` | Максим Ветров |
| `kate` | `kate1234` | Екатерина Ли |
| `ivan` | `ivan1234` | Иван Дорохов |
| `olga` | `olga1234` | Ольга Мирная |

---

## Возможности

### Авторизация
- Регистрация с валидацией логина (`3–24`, латиница/цифры/`._-`) и пароля (≥6).
- Логин регистронезависим, `@` в начале игнорируется.
- Пароли — `scrypt` из `node:crypto`, без нативных зависимостей.
- JWT `HS256` собственной реализации, хранится в `localStorage`, подпись проверяется `timingSafeEqual`.
- Смена имени/био/цвета аватара и пароля, `last_seen_at`.

### Поиск и друзья
- **Глобальный поиск** (debounce 280 мс): по людям и по текстам ваших чатов одновременно (`/api/search`).
- Поиск людей регистронезависим и для кириллицы: складка регистра + `ё→е` считается в JS и хранится в колонках `username_lower` / `display_name_lower`, т.к. встроенный `LIKE`/`LOWER` SQLite работает только с ASCII.
- Подсветка совпадений приходит с сервера как `[{text, hit}]` — клиент не возится с HTML-экранированием.
- Экранирование `%_` в `LIKE`.
- Заявки: входящие/исходящие, принятие встречной заявки = автоматическая дружба, отмена/отклонение, чёрный список.
- Блокировка разрывает дружбу и запрещает лички и заявки в обе стороны.
- Сводка `/api/bootstrap` отдаёт всё для первой отрисовки одним запросом: профиль, друзья, чаты, заявки, блок-лист, онлайн-id.

### Чаты
- **Личные**: идемпотентны по паре участников (`pair_key = min:max`), при повторном открытии возвращается тот же id. Заголовок сериализуется под каждого участника (имя собеседника).
- **Групповые**: создание, переименование и смена топика (только владелец), добавление участников (владелец — любого, обычный участник — только своих друзей), выход/исключение, роли `owner/member`.
- **Сообщения**: текст до 4000 символов, вложения до 8 МБ, ответ на сообщение (`reply_to_id`), редактирование своего, удаление (своё или владельцем группы), реакции эмодзи, пагинация `before/limit` с `hasMore`, отметка прочитанного (`last_read_message_id`).
- **Непрочитанные**: считаются на сервере по `last_read_message_id`, не откатываются назад.
- **Вложения**: загрузка через `POST /api/attachments` (любой `Content-Type`, имя файла в `x-filename` percent-encoded для кириллицы), скачивание только участниками чата или владельцем.
- **Поиск по сообщениям**: по `body_fold` (складка регистра), с подсветкой.

### Realtime
- WebSocket `/ws`: `auth` → `ready` (полный bootstrap), затем `message:new/updated/deleted`, `conversation:new/updated/removed`, `typing`, `read`, `presence`, `friend:request/accepted/removed`, `user:updated`.
- Оптимистичная отправка: клиент показывает пузырёк сразу с `clientId`, сервер возвращает `message:sent` + `message:new` с тем же `clientId` — лента заменяет временный узел, а не дублирует.
- Автопереподключение с экспоненциальной задержкой, очередь исходящих, `ping/pong` 25 с.
- Индикатор набора (`typing`) с троттлингом 2.2 с и автоистечением 5 с.
- Presence: `last_seen_at` пишется в БД при каждом `auth`/`close`, аудитория — друзья + соучастники общих чатов.

### Фронтенд
- SPA без сборки, три панели: сайдбар / чат / инфо, адаптив до мобильного (сайдбар ↔ чат).
- Тёмная тема, CSS-переменные, тонкие скроллбары.
- Весь пользовательский контент вставляется через `textContent` / `createTextNode` — `innerHTML` не используется для данных пользователей (защита от XSS).
- Ссылки в сообщениях детектятся регуляркой и рендерятся как `<a target=_blank rel=noopener>`.
- Drag-and-drop и вставка из буфера обмена для файлов, превью вложений, лайтбокс для картинок, эмодзи-пикер, цитаты-ответы, реакции.
- Глобальный поиск `Ctrl/Cmd+K`, поиск внутри чата, кнопка «к последним» после прыжка в историю.

---

## Стек

- **Backend**: Node.js ≥22.5 (используется `node:sqlite`), Express 4, `ws` 8.
- **Frontend**: Vanilla JS (ES modules), без фреймворков и сборщиков.
- **БД**: SQLite WAL, одна таблица `users` с колонками `_lower` для Unicode-поиска, `messages.body_fold` для поиска по кириллице.
- **Тесты**: `node:test`, `jsdom` для сквозных тестов интерфейса, `ws` для WS-клиентов в тестах.

---

## Запуск

```bash
npm install
npm run seed      # опционально: пересоздать БД с демо-данными
npm start         # http://localhost:3000
npm run dev       # с --watch
```

Переменные окружения:

| переменная | по умолчанию | описание |
|------------|--------------|----------|
| `PORT` | `3000` | порт |
| `HOST` | `0.0.0.0` | хост |
| `DATA_DIR` | `./data` | папка для БД и загрузок |
| `DB_FILE` | `data/mmsgs.sqlite` | путь к SQLite |
| `JWT_SECRET` | генерируется в `data/.secret` | секрет подписи токенов |
| `AUTO_SEED` | `true` | засевать демо-данными при пустой БД |
| `TOKEN_TTL_SEC` | `2592000` (30 дней) | время жизни токена |
| `MAX_UPLOAD_BYTES` | `8388608` (8 МБ) | лимит вложения |

---

## API (кратко)

```
POST   /api/auth/register {username, password, displayName}
POST   /api/auth/login    {username, password} -> {token, user}
GET    /api/auth/me
PATCH  /api/auth/me       {displayName, bio, avatarColor, currentPassword, newPassword}
GET    /api/bootstrap

GET    /api/users/search?q=&limit=
GET    /api/users/:id

GET    /api/friends
GET    /api/friends/requests?direction=incoming|outgoing
POST   /api/friends/requests {username|userId, message}
POST   /api/friends/requests/:id/accept
POST   /api/friends/requests/:id/decline
DELETE /api/friends/:id
POST   /api/users/:id/block
DELETE /api/users/:id/block
GET    /api/blocks

GET    /api/conversations
POST   /api/conversations/direct {userId|username}
POST   /api/conversations/group  {title, memberIds}
GET    /api/conversations/:id
PATCH  /api/conversations/:id    {title, topic}
POST   /api/conversations/:id/members {memberIds}
DELETE /api/conversations/:id/members/:userId
POST   /api/conversations/:id/read    {messageId}
GET    /api/conversations/:id/messages?before=&limit=
POST   /api/conversations/:id/messages {body, replyToId, attachmentId}
POST   /api/conversations/:id/typing

PATCH  /api/messages/:id          {body}
DELETE /api/messages/:id
POST   /api/messages/:id/reactions {emoji, remove}

GET    /api/search?q=&conversationId=
POST   /api/attachments  (raw body, headers x-filename, Content-Type)
GET    /api/attachments/:id/download?token=&inline=
GET    /api/health
```

WebSocket `ws://host/ws`:

```js
ws.send(JSON.stringify({type:'auth', token}))
// -> {type:'ready', me, friends, conversations, incomingRequests, ...}

ws.send({type:'ping'})                // -> pong
ws.send({type:'typing', conversationId})
ws.send({type:'read', conversationId, messageId})
ws.send({type:'message:send', conversationId, body, replyToId, attachmentId, clientId})
```

---

## Тесты

```bash
npm test
# или по отдельности
node --test tests/api.test.mjs
node --test tests/realtime.test.mjs
node --test tests/ui.test.mjs
```

- `api.test.mjs` — 33 теста: авторизация, поиск (включая кириллицу и ё), друзья, блоки, чаты, сообщения, вложения, bootstrap.
- `realtime.test.mjs` — 19 тестов: auth, presence, обмен сообщениями, typing, read, группы, друзья в реальном времени.
- `ui.test.mjs` — 20 сквозных тестов интерфейса в `jsdom`: вход, лента, отправка, входящее live-сообщение, цитаты, реакции, редактирование, удаление, глобальный и локальный поиск, друзья/заявки, инфо-панель, выход.

Всего 72 теста.

---

## Структура

```
server/
  app.js          — сборка Express + WS без listen (для тестов)
  index.js        — точка входа, seed при пустой БД
  config.js       — конфиг, секрет в data/.secret
  db.js           — SQLite + миграции (username_lower, body_fold)
  text.js         — foldCase/escapeLike/highlight для Unicode-поиска
  auth.js         — scrypt + JWT HS256 + валидация
  bus.js          — EventEmitter-шина между REST и WS
  presence.js     — реестр WS-соединений и онлайн-статуса
  services.js     — доменная логика (пользователи, друзья, чаты, сообщения)
  api.js          — REST-роутер
  realtime.js     — WS-сервер и рассылка событий
  seed.js         — демо-данные

public/
  index.html
  css/styles.css  — дизайн-система, тёмная тема, адаптив
  js/
    api.js        — REST-клиент с токеном и обработкой 401
    rt.js         — WS-клиент с реконнектом и очередью
    store.js      — состояние и мутации
    ui.js         — DOM-утилиты, аватары, время, тосты, модалки, XSS-безопасный рендер текста
    views/
      auth.js     — экран входа
      sidebar.js  — чаты/друзья/заявки + глобальный поиск
      chat.js     — лента, композер, typing, реакции, drag-n-drop
      info.js     — правая панель
      modals.js   — новая группа, добавление участников, поиск людей, профиль, настройки, лайтбокс
    main.js       — контроллер, связывает всё вместе

tests/
  helpers.mjs     — стенд: временная БД, эфемерный порт, fetch-обёртка, WS-клиент
  api.test.mjs
  realtime.test.mjs
  ui.test.mjs
```

---

## Безопасность и ограничения

- Пароли никогда не покидают сервер (проверено тестом).
- Токены stateless, подпись `timingSafeEqual`, просрочка по `exp`.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.
- Загрузка вложений — только авторизованным, скачивание — только участникам чата или владельцу.
- В личном чате нельзя добавить участников; в группе владелец может добавить любого, участник — только своих друзей (упрощённая модель).
- SQLite — один файл, WAL, `busy_timeout`, транзакции `BEGIN IMMEDIATE` для записи.

---

## Лицензия

MIT.
