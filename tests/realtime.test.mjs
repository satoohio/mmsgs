import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, call, registerUser, makeFriends, WsClient, sleep } from './helpers.mjs';

let ctx;
const clients = [];

before(async () => { ctx = await startServer(); });
after(async () => {
  for (const c of clients) c.close();
  await sleep(50);
  await ctx.close();
});

async function online(user, label) {
  const c = new WsClient(ctx, label);
  clients.push(c);
  const ready = await c.connect(user.token);
  return { c, ready };
}

describe('WebSocket: подключение и авторизация', () => {
  test('после auth приходит снимок состояния (ready)', async () => {
    const u = await registerUser(ctx, { username: 'ws_ready' });
    const { c, ready } = await online(u, 'ws_ready');
    assert.equal(ready.type, 'ready');
    assert.equal(ready.me.username, 'ws_ready');
    assert.ok(Array.isArray(ready.conversations));
    assert.ok(Array.isArray(ready.friends));
    assert.ok(ready.connectionId);
    c.close();
  });

  test('команда до авторизации отклоняется', async () => {
    const c = new WsClient(ctx, 'ws_noauth');
    clients.push(c);
    await c.connectRaw();
    c.send({ type: 'ping' });
    const err = await c.wait((m) => m.type === 'error');
    assert.match(err.error, /auth/i);
    assert.equal(err.fatal, true);
    c.close();
  });

  test('недействительный токен — соединение закрывают', async () => {
    const c = new WsClient(ctx, 'ws_badtoken');
    clients.push(c);
    await c.connectRaw();
    c.send({ type: 'auth', token: 'not.a.token' });
    const err = await c.wait((m) => m.type === 'error');
    assert.match(err.error, /токен/i);
    await sleep(100);
    assert.ok(c.closed || c.ws.readyState !== 1, 'сокет закрыт после плохого токена');
  });

  test('неизвестный тип команды → ошибка, соединение живо', async () => {
    const u = await registerUser(ctx, { username: 'ws_unknown' });
    const { c } = await online(u, 'ws_unknown');
    c.send({ type: 'what_is_this' });
    const err = await c.wait((m) => m.type === 'error' && /Неизвестный тип/.test(m.error));
    assert.ok(err);
    c.send({ type: 'ping' });
    const pong = await c.wait((m) => m.type === 'pong');
    assert.ok(pong.t > 0);
    c.close();
  });
});

describe('Presence', () => {
  test('друг видит онлайн и офлайн', async () => {
    const a = await registerUser(ctx, { username: 'pres_a' });
    const b = await registerUser(ctx, { username: 'pres_b' });
    await makeFriends(ctx, a, b);

    const bClient = await online(b, 'pres_b');
    const inList = bClient.ready.friends.find((f) => f.username === 'pres_a');
    assert.ok(inList, 'друг есть в списке сразу после подтверждения заявки');
    assert.equal(inList.online, false, 'пока не подключён — офлайн');
    assert.ok(bClient.ready.friends.every((f) => f.id !== b.user.id), 'самого себя в друзьях нет');

    const aClient = await online(a, 'pres_a');
    const sawOnline = await bClient.c.wait((m) => m.type === 'presence' && m.online === true);
    assert.equal(sawOnline.userId, a.user.id);

    aClient.c.close();
    const sawOffline = await bClient.c.wait((m) => m.type === 'presence' && m.online === false);
    assert.equal(sawOffline.userId, a.user.id);
    assert.ok(sawOffline.lastSeenAt > 0);

    // last_seen_at persisted: REST отдаёт его же
    const profile = await call(ctx, 'GET', `/users/${a.user.id}`, { token: b.token });
    assert.equal(profile.data.user.online, false);
    assert.ok(profile.data.user.lastSeenAt > 0);
    bClient.c.close();
  });

  test('посторонний не получает presence', async () => {
    const a = await registerUser(ctx, { username: 'pres_x' });
    const stranger = await registerUser(ctx, { username: 'pres_stranger' });
    const s = await online(stranger, 'pres_stranger');
    const x = await online(a, 'pres_x');
    await sleep(150);
    assert.ok(!s.c.inbox.some((m) => m.type === 'presence' && m.userId === a.user.id));
    x.c.close();
    s.c.close();
  });
});

describe('Обмен сообщениями в реальном времени', () => {
  let a, b, convId, aClient, bClient;

  before(async () => {
    a = await registerUser(ctx, { username: 'rt_a' });
    b = await registerUser(ctx, { username: 'rt_b' });
    await makeFriends(ctx, a, b);
    const { data } = await call(ctx, 'POST', '/conversations/direct', { token: a.token, body: { userId: b.user.id } });
    convId = data.conversation.id;
    aClient = await online(a, 'rt_a');
    bClient = await online(b, 'rt_b');
  });

  after(() => { aClient.c.close(); bClient.c.close(); });

  test('отправка через сокет: ack отправителю и delivery получателю', async () => {
    const clientId = 'tmp-1';
    aClient.c.send({ type: 'message:send', conversationId: convId, body: 'привет в реальном времени', clientId });

    const ack = await aClient.c.wait((m) => m.type === 'message:sent' && m.clientId === clientId);
    assert.ok(ack.messageId > 0);

    const own = await aClient.c.wait((m) => m.type === 'message:new' && m.message?.id === ack.messageId);
    assert.equal(own.message.body, 'привет в реальном времени');

    const received = await bClient.c.wait((m) => m.type === 'message:new' && m.message?.id === ack.messageId);
    assert.equal(received.conversationId, convId);
    assert.equal(received.message.sender.username, 'rt_a');
    assert.ok(received.message.createdAt > 0);
  });

  test('отправка через REST тоже долетает по сокету', async () => {
    await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: 'через http' } });
    const received = await bClient.c.wait((m) => m.type === 'message:new' && m.message?.body === 'через http');
    assert.ok(received.message.id);
  });

  test('пустое сообщение через сокет → ошибка, а не падение соединения', async () => {
    aClient.c.send({ type: 'message:send', conversationId: convId, body: '  ', clientId: 'tmp-bad' });
    const err = await aClient.c.wait((m) => m.type === 'error' && m.refId === 'tmp-bad');
    assert.equal(err.status, 400);
    assert.equal(aClient.c.ws.readyState, 1, 'соединение осталось живым');
  });

  test('чужой чат по сокету недоступен', async () => {
    const stranger = await registerUser(ctx, { username: 'rt_stranger' });
    const s = await online(stranger, 'rt_stranger');
    s.c.send({ type: 'message:send', conversationId: convId, body: 'вломился', clientId: 'tmp-x' });
    const err = await s.c.wait((m) => m.type === 'error' && m.refId === 'tmp-x');
    assert.equal(err.status, 403);
    await sleep(100);
    assert.ok(!bClient.c.inbox.some((m) => m.type === 'message:new' && m.message?.body === 'вломился'));
    s.c.close();
  });

  test('typing доходит собеседнику, но не самому себе', async () => {
    aClient.c.send({ type: 'typing', conversationId: convId });
    const typing = await bClient.c.wait((m) => m.type === 'typing');
    assert.equal(typing.userId, a.user.id);
    assert.equal(typing.conversationId, convId);
    assert.ok(!aClient.c.inbox.some((m) => m.type === 'typing' && m.userId === a.user.id));
  });

  test('read-рецепт приходит отправителю', async () => {
    const last = await call(ctx, 'GET', `/conversations/${convId}/messages?limit=1`, { token: b.token });
    const lastId = last.data.messages[last.data.messages.length - 1].id;
    bClient.c.send({ type: 'read', conversationId: convId, messageId: lastId });
    const read = await aClient.c.wait((m) => m.type === 'read');
    assert.equal(read.userId, b.user.id);
    assert.equal(read.messageId, lastId);
  });

  test('редактирование и удаление транслируются участникам', async () => {
    const { data } = await call(ctx, 'POST', `/conversations/${convId}/messages`, { token: a.token, body: { body: 'до правки' } });
    await bClient.c.wait((m) => m.type === 'message:new' && m.message.id === data.message.id);

    await call(ctx, 'PATCH', `/messages/${data.message.id}`, { token: a.token, body: { body: 'после правки' } });
    const updated = await bClient.c.wait((m) => m.type === 'message:updated' && m.message.id === data.message.id);
    assert.equal(updated.message.body, 'после правки');

    await call(ctx, 'DELETE', `/messages/${data.message.id}`, { token: a.token });
    const deleted = await bClient.c.wait((m) => m.type === 'message:deleted' && m.messageId === data.message.id);
    assert.ok(deleted);
    const patch = await bClient.c.wait((m) => m.type === 'conversation:patch' && m.patch.id === convId);
    assert.ok(patch.patch.lastMessage !== undefined);
  });
});

describe('Групповые чаты в реальном времени', () => {
  test('создание группы рассылает участникам снимок чата', async () => {
    const owner = await registerUser(ctx, { username: 'grp_owner' });
    const member = await registerUser(ctx, { username: 'grp_member' });
    const memberClient = await online(member, 'grp_member');

    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Группа в реальном времени', memberIds: [member.user.id] },
    });
    const created = await memberClient.c.wait((m) => m.type === 'conversation:new');
    assert.equal(created.conversation.id, data.conversation.id);
    assert.equal(created.conversation.title, 'Группа в реальном времени');
    assert.equal(created.conversation.type, 'group');
    memberClient.c.close();
  });

  test('сообщение в группе получают все участники', async () => {
    const owner = await registerUser(ctx, { username: 'grp2_owner' });
    const m1 = await registerUser(ctx, { username: 'grp2_m1' });
    const m2 = await registerUser(ctx, { username: 'grp2_m2' });
    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Трио', memberIds: [m1.user.id, m2.user.id] },
    });
    const c1 = await online(m1, 'grp2_m1');
    const c2 = await online(m2, 'grp2_m2');

    await call(ctx, 'POST', `/conversations/${data.conversation.id}/messages`, { token: owner.token, body: { body: 'всем привет' } });
    const r1 = await c1.c.wait((m) => m.type === 'message:new' && m.message?.body === 'всем привет');
    const r2 = await c2.c.wait((m) => m.type === 'message:new' && m.message?.body === 'всем привет');
    assert.equal(r1.conversationId, data.conversation.id);
    assert.equal(r2.conversationId, data.conversation.id);
    c1.c.close();
    c2.c.close();
  });

  test('добавление участника присылает ему новый чат', async () => {
    const owner = await registerUser(ctx, { username: 'grp3_owner' });
    const added = await registerUser(ctx, { username: 'grp3_added' });
    // Группу нельзя создать без участников
    await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Пополняемая', memberIds: [] }, expect: 400,
    });
    const seed = await registerUser(ctx, { username: 'grp3_seed' });
    const created = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'Пополняемая', memberIds: [seed.user.id] },
    });
    const addedClient = await online(added, 'grp3_added');
    await call(ctx, 'POST', `/conversations/${created.data.conversation.id}/members`, {
      token: owner.token, body: { memberIds: [added.user.id] },
    });
    const got = await addedClient.c.wait((m) => m.type === 'conversation:new');
    assert.equal(got.conversation.id, created.data.conversation.id);
    assert.ok(got.conversation.memberIds.includes(added.user.id));
    addedClient.c.close();
  });

  test('исключение участника: ему приходит conversation:removed', async () => {
    const owner = await registerUser(ctx, { username: 'grp4_owner' });
    const victim = await registerUser(ctx, { username: 'grp4_victim' });
    const { data } = await call(ctx, 'POST', '/conversations/group', {
      token: owner.token, body: { title: 'На вылет', memberIds: [victim.user.id] },
    });
    const victimClient = await online(victim, 'grp4_victim');
    await call(ctx, 'DELETE', `/conversations/${data.conversation.id}/members/${victim.user.id}`, { token: owner.token });
    const removed = await victimClient.c.wait((m) => m.type === 'conversation:removed');
    assert.equal(removed.conversationId, data.conversation.id);
    assert.equal(removed.left, false);
    victimClient.c.close();
  });
});

describe('Друзья в реальном времени', () => {
  test('заявка и подтверждение приходят пушем', async () => {
    const a = await registerUser(ctx, { username: 'fr_a' });
    const b = await registerUser(ctx, { username: 'fr_b' });
    const bClient = await online(b, 'fr_b');
    const aClient = await online(a, 'fr_a');

    const { data } = await call(ctx, 'POST', '/friends/requests', {
      token: a.token, body: { username: 'fr_b', message: 'дружим?' }, expect: 201,
    });
    const push = await bClient.c.wait((m) => m.type === 'friend:request');
    assert.equal(push.request.id, data.request.id);
    assert.equal(push.request.user.username, 'fr_a');
    assert.equal(push.request.message, 'дружим?');

    await call(ctx, 'POST', `/friends/requests/${data.request.id}/accept`, { token: b.token });
    const acceptedA = await aClient.c.wait((m) => m.type === 'friend:accepted');
    const acceptedB = await bClient.c.wait((m) => m.type === 'friend:accepted');
    assert.ok(acceptedA.request.id === data.request.id);
    assert.ok(acceptedB.request.id === data.request.id);

    const convA = await aClient.c.wait((m) => m.type === 'conversation:new');
    assert.equal(convA.conversation.type, 'direct');
    assert.equal(convA.conversation.title, b.user.displayName, 'заголовок сериализован под получателя');
    const convB = await bClient.c.wait((m) => m.type === 'conversation:new');
    assert.equal(convB.conversation.id, convA.conversation.id, 'один и тот же диалог у обоих');
    assert.equal(convB.conversation.title, a.user.displayName);
    aClient.c.close();
    bClient.c.close();
  });

  test('удаление из друзей приходит обеим сторонам', async () => {
    const a = await registerUser(ctx, { username: 'fr_del_a' });
    const b = await registerUser(ctx, { username: 'fr_del_b' });
    await makeFriends(ctx, a, b);
    const aClient = await online(a, 'fr_del_a');
    const bClient = await online(b, 'fr_del_b');
    await call(ctx, 'DELETE', `/friends/${b.user.id}`, { token: a.token });
    const ea = await aClient.c.wait((m) => m.type === 'friend:removed');
    const eb = await bClient.c.wait((m) => m.type === 'friend:removed');
    assert.equal(ea.friendId, b.user.id);
    assert.equal(eb.friendId, a.user.id);
    aClient.c.close();
    bClient.c.close();
  });
});
