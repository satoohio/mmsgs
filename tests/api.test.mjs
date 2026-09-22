import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, call, registerUser, makeFriends } from './helpers.mjs';

let ctx;

before(async () => { ctx = await startServer(); });
after(async () => { await ctx.close(); });

describe('Авторизация', () => {
  test('регистрация выдаёт токен и профиль', async () => {
    const { data } = await call(ctx, 'POST', '/auth/register', {
      body: { username: 'alice_reg', password: 'secret123', displayName: 'Алиса' },
      expect: 201,
    });
    assert.ok(data.token.length > 40);
    assert.equal(data.user.username, 'alice_reg');
    assert.equal(data.user.displayName, 'Алиса');
    assert.match(data.user.avatarColor, /^#[0-9a-f]{6}$/i);
    assert.equal(data.user.passwordHash, undefined, 'хэш пароля не должен покидать сервер');
  });

  test('повторный логин отклоняется (409), регистр не важен', async () => {
    await call(ctx, 'POST', '/auth/register', {
      body: { username: 'ALICE_REG', password: 'secret123' }, expect: 409,
    });
  });

  test('слабый пароль и кривой логин → 400 с понятными деталями', async () => {
    const { data } = await call(ctx, 'POST', '/auth/register', {
      body: { username: 'a', password: '123' }, expect: 400,
    });
    assert.ok(Array.isArray(data.details) && data.details.length >= 2);
  });

  test('неверный пароль → 401', async () => {
    await call(ctx, 'POST', '/auth/login', {
      body: { username: 'alice_reg', password: 'wrong' }, expect: 401,
    });
  });

  test('несуществующий логин → тот же 401 (не раскрываем наличие аккаунта)', async () => {
    await call(ctx, 'POST', '/auth/login', {
      body: { username: 'no_such_user', password: 'whatever' }, expect: 401,
    });
  });

  test('вход по логину с @ и смена пароля', async () => {
    const login = await call(ctx, 'POST', '/auth/login', {
      body: { username: '@alice_reg', password: 'secret123' },
    });
    assert.equal(login.data.user.username, 'alice_reg');

    await call(ctx, 'PATCH', '/auth/me', {
      token: login.data.token,
      body: { currentPassword: 'bad', newPassword: 'newsecret1' }, expect: 403,
    });
    await call(ctx, 'PATCH', '/auth/me', {
      token: login.data.token,
      body: { currentPassword: 'secret123', newPassword: 'newsecret1', displayName: 'Алиса Р.' },
    });
    const relogin = await call(ctx, 'POST', '/auth/login', {
      body: { username: 'alice_reg', password: 'newsecret1' },
    });
    assert.equal(relogin.data.user.displayName, 'Алиса Р.');
  });

  test('доступ без токена закрыт', async () => {
    for (const url of ['/bootstrap', '/friends', '/conversations', '/users/search?q=a']) {
      const { status } = await call(ctx, 'GET', url, { expect: 401 });
      assert.equal(status, 401, url);
    }
  });

  test('подделанная подпись токена не проходит', async () => {
    const { data } = await call(ctx, 'POST', '/auth/login', {
      body: { username: 'alice_reg', password: 'newsecret1' },
    });
    const [h, p] = data.token.split('.');
    const forged = `${h}.${p}.AAAA`;
    await call(ctx, 'GET', '/bootstrap', { token: forged, expect: 401 });
  });
});

describe('Поиск людей и друзья', () => {
  let anna, boris, vita;

  before(async () => {
    anna = await registerUser(ctx, { username: 'anna_f', displayName: 'Анна' });
    boris = await registerUser(ctx, { username: 'boris_f', displayName: 'Борис Гребенщиков' });
    vita = await registerUser(ctx, { username: 'vita_f', displayName: 'Вита' });
  });

  test('поиск по подстроке логина и имени, отношение помечено', async () => {
    const { data } = await call(ctx, 'GET', '/users/search?q=борис', { token: anna.token });
    assert.ok(data.results.some((u) => u.username === 'boris_f'));
    const found = data.results.find((u) => u.username === 'boris_f');
    assert.equal(found.relation, 'none');
    assert.equal(found.online, false);
  });

  test('пустой запрос отдаёт список «кого можно добавить» без самого себя', async () => {
    const { data } = await call(ctx, 'GET', '/users/search', { token: anna.token });
    assert.ok(data.results.length > 0);
    assert.ok(!data.results.some((u) => u.id === anna.user.id));
  });

  test('кириллица ищется без учёта регистра и «ё»', async () => {
    const byLower = await call(ctx, 'GET', `/users/search?q=${encodeURIComponent('борис')}`, { token: anna.token });
    assert.ok(byLower.data.results.some((u) => u.username === 'boris_f'), 'поиск строчными по имени с заглавной');
    const byUpper = await call(ctx, 'GET', `/users/search?q=${encodeURIComponent('БОРИС ГРЕБ')}`, { token: anna.token });
    assert.ok(byUpper.data.results.some((u) => u.username === 'boris_f'), 'поиск ЗАГЛАВНЫМИ');

    const yo = await registerUser(ctx, { username: 'yo_user', displayName: 'Алёна Ёлкина' });
    const r1 = await call(ctx, 'GET', `/users/search?q=${encodeURIComponent('алена')}`, { token: anna.token });
    assert.ok(r1.data.results.some((u) => u.id === yo.user.id), '«алена» находит «Алёна»');
    const r2 = await call(ctx, 'GET', `/users/search?q=${encodeURIComponent('ёлкина')}`, { token: anna.token });
    assert.ok(r2.data.results.some((u) => u.id === yo.user.id), '«ёлкина» находит «Ёлкина»');
  });

  test('символы LIKE экранируются: "%_" не матчит всех подряд', async () => {
    const { data } = await call(ctx, 'GET', '/users/search?q=%25_', { token: anna.token });
    assert.deepEqual(data.results, []);
  });

  test('полный цикл заявки: отправка → входящая → подтверждение → дружба', async () => {
    const { data } = await call(ctx, 'POST', '/friends/requests', {
      token: anna.token, body: { username: 'boris_f', message: 'Привет! Давай дружить' }, expect: 201,
    });
    assert.equal(data.request.status, 'pending');

    const incoming = await call(ctx, 'GET', '/friends/requests?direction=incoming', { token: boris.token });
    assert.equal(incoming.data.requests.length, 1);
    assert.equal(incoming.data.requests[0].user.username, 'anna_f');
    assert.equal(incoming.data.requests[0].message, 'Привет! Давай дружить');

    const outgoing = await call(ctx, 'GET', '/friends/requests?direction=outgoing', { token: anna.token });
    assert.equal(outgoing.data.requests.length, 1);

    // Повторная заявка запрещена
    await call(ctx, 'POST', '/friends/requests', {
      token: anna.token, body: { username: 'boris_f' }, expect: 400,
    });

    const accept = await call(ctx, 'POST', `/friends/requests/${data.request.id}/accept`, { token: boris.token });
    assert.equal(accept.data.request.status, 'accepted');
    assert.ok(accept.data.conversation, 'сразу создаётся личный чат');
    assert.equal(accept.data.conversation.type, 'direct');

    const friends = await call(ctx, 'GET', '/friends', { token: anna.token });
    assert.equal(friends.data.friends.length, 1);
    assert.equal(friends.data.friends[0].username, 'boris_f');
    assert.equal(friends.data.friends[0].conversationId, accept.data.conversation.id);

    const search = await call(ctx, 'GET', '/users/search?q=boris_f', { token: anna.token });
    assert.equal(search.data.results[0].relation, 'friends');
  });

  test('встречная заявка автоматически устанавливает дружбу', async () => {
    await call(ctx, 'POST', '/friends/requests', { token: vita.token, body: { userId: anna.user.id }, expect: 201 });
    const { data } = await call(ctx, 'POST', '/friends/requests', { token: anna.token, body: { userId: vita.user.id } });
    assert.equal(data.request.status, 'accepted');
    const friends = await call(ctx, 'GET', '/friends', { token: anna.token });
    assert.ok(friends.data.friends.some((f) => f.username === 'vita_f'));
  });

  test('отклонение и отмена заявки', async () => {
    const carl = await registerUser(ctx, { username: 'carl_f' });
    const { data } = await call(ctx, 'POST', '/friends/requests', { token: carl.token, body: { userId: anna.user.id }, expect: 201 });
    await call(ctx, 'POST', `/friends/requests/${data.request.id}/decline`, { token: anna.token });
    const incoming = await call(ctx, 'GET', '/friends/requests', { token: anna.token });
    assert.equal(incoming.data.requests.length, 0);

    // После отклонения можно отправить заново
    await call(ctx, 'POST', '/friends/requests', { token: carl.token, body: { userId: anna.user.id }, expect: 201 });

    // Чужую заявку обработать нельзя
    await call(ctx, 'POST', `/friends/requests/${data.request.id}/accept`, { token: boris.token, expect: 403 });
  });

  test('нельзя добавить себя и несуществующего пользователя', async () => {
    await call(ctx, 'POST', '/friends/requests', { token: anna.token, body: { userId: anna.user.id }, expect: 400 });
    await call(ctx, 'POST', '/friends/requests', { token: anna.token, body: { username: 'ghost_user' }, expect: 404 });
  });

  test('удаление из друзей разрывает связь с обеих сторон', async () => {
    await call(ctx, 'DELETE', `/friends/${boris.user.id}`, { token: anna.token });
    const a = await call(ctx, 'GET', '/friends', { token: anna.token });
    const b = await call(ctx, 'GET', '/friends', { token: boris.token });
    assert.ok(!a.data.friends.some((f) => f.id === boris.user.id));
    assert.ok(!b.data.friends.some((f) => f.id === anna.user.id));
  });

  test('чёрный список блокирует заявки и личные чаты', async () => {
    const spam = await registerUser(ctx, { username: 'spam_f' });
    await call(ctx, 'POST', `/users/${spam.user.id}/block`, { token: anna.token });

    await call(ctx, 'POST', '/friends/requests', { token: spam.token, body: { userId: anna.user.id }, expect: 403 });
    await call(ctx, 'POST', '/conversations/direct', { token: spam.token, body: { userId: anna.user.id }, expect: 403 });

    const blocks = await call(ctx, 'GET', '/blocks', { token: anna.token });
    assert.equal(blocks.data.blocked.length, 1);
    const search = await call(ctx, 'GET', '/users/search?q=spam_f', { token: anna.token });
    assert.equal(search.data.results[0].relation, 'blocked');

    await call(ctx, 'DELETE', `/users/${spam.user.id}/block`, { token: anna.token });
    await call(ctx, 'POST', '/friends/requests', { token: spam.token, body: { userId: anna.user.id }, expect: 201 });
  });
});

describe('Личные и групповые чаты', () => {
  let owner, m1, m2, outsider;

  before(async () => {
    owner = await registerUser(ctx, { username: 'g_owner' });
    m1 = await registerUser(ctx, { username: 'g_m1' });
    m2 = await registerUser(ctx, { username: 'g_m2' });
    outsider = await registerUser(ctx, { username: 'g_outsider' });
  });

  test('личный чат идемпотентен: повторный вызов возвращает тот же id', async () => {
    const a = await call(ctx, 'POST', '/conversations/direct', { token: owner.token, body: { userId: m1.user.id }, expect: 201 });
    const b = await call(ctx, 'POST', '/conversations/direct', { token: m1.token, body: { userId: owner.user.id } });
    assert.equal(a.data.conversation.id, b.data.conversation.id);
    assert.equal(a.data.conversation.title, m1.user.displayName, 'для владельца заголовок — имя собеседника');
    assert.equal(b.data.conversation.title, owner.user.displayName, 'для собеседника — имя владельца');
    await call(ctx, 'POST', '/conversations/direct', { token: owner.token, body: { userId: owner.user.id }, expect: 400 });
  });

  test('создание группы: участники, роли, заголовок', async () => {
    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token,
      body: { title: 'Проект «Восток»', memberIds: [m1.user.id, m2.user.id] },
      expect: 201,
    });
    const conv = data.conversation;
    assert.equal(conv.type, 'group');
    assert.equal(conv.title, 'Проект «Восток»');
    assert.equal(conv.role, 'owner');
    assert.deepEqual(conv.memberIds.sort((x, y) => x - y), [owner.user.id, m1.user.id, m2.user.id].sort((x, y) => x - y));

    await call(ctx, 'POST', '/conversations/group', { token: owner.token, body: { title: 'x', memberIds: [m1.user.id] }, expect: 400 });
    await call(ctx, 'POST', '/conversations/group', { token: owner.token, body: { title: 'Без участников', memberIds: [] }, expect: 400 });
    return conv.id;
  });

  test('чужой не читает чат и не видит его в списке', async () => {
    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Закрытая группа', memberIds: [m1.user.id] }, expect: 201,
    });
    const id = data.conversation.id;
    await call(ctx, 'GET', `/conversations/${id}/messages`, { token: outsider.token, expect: 403 });
    await call(ctx, 'GET', `/conversations/${id}`, { token: outsider.token, expect: 403 });
    await call(ctx, 'POST', `/conversations/${id}/messages`, { token: outsider.token, body: { body: 'вломился' }, expect: 403 });
    const list = await call(ctx, 'GET', '/conversations', { token: outsider.token });
    assert.ok(!list.data.conversations.some((c) => c.id === id));
  });

  test('добавление участников и выход из группы', async () => {
    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Расширяемая', memberIds: [m1.user.id] }, expect: 201,
    });
    const id = data.conversation.id;

    const added = await call(ctx, 'POST', `/conversations/${id}/members`, { token: owner.token, body: { memberIds: [m2.user.id] } });
    assert.ok(added.data.conversation.memberIds.includes(m2.user.id));

    // Обычный участник может добавить только своего друга
    await makeFriends(ctx, m2, outsider);
    const byMember = await call(ctx, 'POST', `/conversations/${id}/members`, { token: m2.token, body: { memberIds: [outsider.user.id] } });
    assert.ok(byMember.data.conversation.memberIds.includes(outsider.user.id));

    // Выход из группы
    await call(ctx, 'DELETE', `/conversations/${id}/members/${outsider.user.id}`, { token: outsider.token });
    const after = await call(ctx, 'GET', `/conversations/${id}`, { token: owner.token });
    assert.ok(!after.data.conversation.memberIds.includes(outsider.user.id));

    // Владелец исключает участника; исключать владельца нельзя
    await call(ctx, 'DELETE', `/conversations/${id}/members/${m1.user.id}`, { token: owner.token });
    await call(ctx, 'DELETE', `/conversations/${id}/members/${owner.user.id}`, { token: m2.token, expect: 403 });
  });

  test('переименование группы доступно только владельцу', async () => {
    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Старое имя', memberIds: [m1.user.id] }, expect: 201,
    });
    const id = data.conversation.id;
    await call(ctx, 'PATCH', `/conversations/${id}`, { token: m1.token, body: { title: 'Захват' }, expect: 403 });
    const renamed = await call(ctx, 'PATCH', `/conversations/${id}`, { token: owner.token, body: { title: 'Новое имя', topic: 'Описание' } });
    assert.equal(renamed.data.conversation.title, 'Новое имя');
    assert.equal(renamed.data.conversation.topic, 'Описание');
  });
});

describe('Сообщения', () => {
  let a, b, convId;

  before(async () => {
    a = await registerUser(ctx, { username: 'msg_a' });
    b = await registerUser(ctx, { username: 'msg_b' });
    await makeFriends(ctx, a, b);
    const { data } = await call(ctx, 'POST', '/conversations/direct', { token: a.token, body: { userId: b.user.id } });
    convId = data.conversation.id;
  });

  test('отправка, список и порядок', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await call(ctx, 'POST', `/conversations/${convId}/messages`, {
        token: i % 2 ? a.token : b.token, body: { body: `сообщение ${i}` }, expect: 201,
      });
    }
    const { data } = await call(ctx, 'GET', `/conversations/${convId}/messages`, { token: b.token });
    assert.equal(data.messages.length, 5);
    assert.deepEqual(data.messages.map((m) => m.body), ['сообщение 1', 'сообщение 2', 'сообщение 3', 'сообщение 4', 'сообщение 5']);
    assert.equal(data.hasMore, false);
    assert.equal(data.messages[0].sender.username, 'msg_a');
  });

  test('пустое сообщение отклоняется', async () => {
    await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: '   ' }, expect: 400 });
    await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: {}, expect: 400 });
  });

  test('пагинация назад: limit + before + hasMore', async () => {
    const page1 = await call(ctx, 'GET', `/conversations/${convId}/messages?limit=2`, { token: a.token });
    assert.equal(page1.data.messages.length, 2);
    assert.equal(page1.data.hasMore, true);
    const oldest = page1.data.messages[0].id;
    const page2 = await call(ctx, 'GET', `/conversations/${convId}/messages?limit=2&before=${oldest}`, { token: a.token });
    assert.ok(page2.data.messages.every((m) => m.id < oldest));
  });

  test('непрочитанные и отметка о прочтении', async () => {
    const conv = await call(ctx, 'GET', `/conversations/${convId}`, { token: b.token });
    assert.ok(conv.data.conversation.unread > 0, 'у получателя есть непрочитанные');
    const self = await call(ctx, 'GET', `/conversations/${convId}`, { token: a.token });
    assert.equal(self.data.conversation.unread, 0, 'автор свои сообщения не считает непрочитанными');

    const last = conv.data.conversation.lastMessage.id;
    await call(ctx, 'POST', `/conversations/${convId}/read`, { token: b.token, body: { messageId: last } });
    const after = await call(ctx, 'GET', `/conversations/${convId}`, { token: b.token });
    assert.equal(after.data.conversation.unread, 0);
    // Отметка не откатывается назад
    await call(ctx, 'POST', `/conversations/${convId}/read`, { token: b.token, body: { messageId: 1 } });
    const after2 = await call(ctx, 'GET', `/conversations/${convId}`, { token: b.token });
    assert.equal(after2.data.conversation.unread, 0);
  });

  test('редактирование и удаление: только своё, владелец группы — исключение', async () => {
    const { data } = await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: 'опечатка' } });
    const id = data.message.id;

    await call(ctx, 'PATCH', `/messages/${id}`, { token: b.token, body: { body: 'чужая правка' }, expect: 403 });
    const edited = await call(ctx, 'PATCH', `/messages/${id}`, { token: a.token, body: { body: 'исправлено' } });
    assert.equal(edited.data.message.body, 'исправлено');
    assert.ok(edited.data.message.editedAt > 0);

    await call(ctx, 'DELETE', `/messages/${id}`, { token: b.token, expect: 403 });
    await call(ctx, 'DELETE', `/messages/${id}`, { token: a.token });
    const list = await call(ctx, 'GET', `/conversations/${convId}/messages`, { token: b.token });
    const deleted = list.data.messages.find((m) => m.id === id);
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.body, '', 'текст удалённого сообщения не отдаётся');
  });

  test('ответ на сообщение (reply)', async () => {
    const first = await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: 'вопрос' } });
    const reply = await call(ctx, 'POST', `/conversations/${convId}/messages`, {
      token: b.token, body: { body: 'ответ', replyToId: first.data.message.id },
    });
    assert.equal(reply.data.message.replyTo, first.data.message.id);
    await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: b.token, body: { body: 'x', replyToId: 999999 }, expect: 400 });
  });

  test('реакции: поставить и снять', async () => {
    const { data } = await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: 'ура' } });
    const id = data.message.id;
    const reacted = await call(ctx, 'POST', `/messages/${id}/reactions`, { token: b.token, body: { emoji: '🔥' } });
    assert.deepEqual(reacted.data.message.reactions['🔥'], [b.user.id]);
    const twice = await call(ctx, 'POST', `/messages/${id}/reactions`, { token: b.token, body: { emoji: '🔥' } });
    assert.equal(twice.data.message.reactions['🔥'].length, 1, 'дубль реакции не создаётся');
    const removed = await call(ctx, 'POST', `/messages/${id}/reactions`, { token: b.token, body: { emoji: '🔥', remove: true } });
    assert.deepEqual(removed.data.message.reactions, {});
    await call(ctx, 'POST', `/messages/${id}/reactions`, { token: b.token, body: { emoji: '👍' } });
    await call(ctx, 'DELETE', `/messages/${id}/reactions?emoji=👍`, { token: b.token });
  });

  test('поиск по сообщениям ограничен своими чатами', async () => {
    await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: 'уникальное слово зефирка' } });
    const mine = await call(ctx, 'GET', '/search?q=зефирка', { token: b.token });
    assert.equal(mine.data.messages.length, 1);
    assert.equal(mine.data.messages[0].conversation.id, convId);

    const stranger = await registerUser(ctx, { username: 'msg_stranger' });
    const theirs = await call(ctx, 'GET', '/search?q=зефирка', { token: stranger.token });
    assert.equal(theirs.data.messages.length, 0, 'посторонний не видит чужие сообщения');

    const scoped = await call(ctx, 'GET', `/search?q=зефирка&conversationId=${convId}`, { token: a.token });
    assert.equal(scoped.data.messages.length, 1);
  });

  test('вложения: загрузка, отправка, доступ только участникам', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const up = await call(ctx, 'POST', '/attachments', {
      token: a.token,
      body: png,
      // Имя файла может быть кириллическим: в заголовке — percent-encoding,
      // сервер декодирует (браузерный клиент делает так же)
      headers: { 'Content-Type': 'image/png', 'x-filename': encodeURIComponent('скрин.png') },
      expect: 201,
    });
    assert.ok(up.data.attachment.id);
    assert.ok(up.data.attachment.url.includes('/api/attachments/'));
    assert.equal(up.data.attachment.isImage, true);
    assert.equal(up.data.attachment.filename, 'скрин.png', 'иммя файла декодируется из x-filename');
    assert.equal(up.data.attachment.size, png.length);

    // Без Content-Type загрузка тоже проходит (клиент мог не выставить заголовок)
    const noCt = await call(ctx, 'POST', '/attachments', {
      token: a.token, body: png, headers: { 'Content-Type': undefined }, expect: 201,
    });
    assert.equal(noCt.data.attachment.isImage, false);

    const { data } = await call(ctx, 'POST', `/conversations/${convId}/messages`, {
      token: a.token, body: { body: 'смотри картинку', attachmentId: up.data.attachment.id },
    });
    assert.equal(data.message.attachment.id, up.data.attachment.id);
    assert.equal(data.message.attachment.isImage, true);

    const ok = await call(ctx, 'GET', up.data.attachment.url, { token: b.token, raw: true });
    assert.equal(ok.status, 200);
    const stranger = await registerUser(ctx, { username: 'att_stranger' });
    await call(ctx, 'GET', up.data.attachment.url, { token: stranger.token, expect: 403 });
  });
});

describe('Сводка /bootstrap', () => {
  test('одним запросом отдаёт всё для первой отрисовки', async () => {
    const u1 = await registerUser(ctx, { username: 'boot_1' });
    const u2 = await registerUser(ctx, { username: 'boot_2' });
    await makeFriends(ctx, u1, u2);
    await call(ctx, 'POST', '/conversations/group', { token: u1.token, body: { title: 'Бутстрап', memberIds: [u2.user.id] } });

    const { data } = await call(ctx, 'GET', '/bootstrap', { token: u1.token });
    assert.equal(data.me.username, 'boot_1');
    assert.equal(data.friends.length, 1);
    assert.equal(data.conversations.length, 2);
    assert.ok(Array.isArray(data.incomingRequests));
    assert.ok(Array.isArray(data.online));
    assert.ok(typeof data.serverTime === 'number');
    const group = data.conversations.find((c) => c.type === 'group');
    assert.equal(group.title, 'Бутстрап');
    assert.ok(group.members.length === 2);
  });
});
