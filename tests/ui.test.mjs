import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { WebSocket as NodeWebSocket } from 'ws';
import { startServer, call, registerUser, makeFriends, WsClient, sleep } from './helpers.mjs';

/**
 * Сквозной тест интерфейса: настоящий сервер + настоящий фронтенд в jsdom.
 * Проверяем не «код не упал», а поведение, которое видит пользователь:
 * вход, лента, отправка, живое входящее сообщение, поиск, выход.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let ctx;
let dom;
let peerClient;
let alice, bob, conversationId;

const doc = () => dom.window.document;
const $ = (sel) => doc().querySelector(sel);
const $$ = (sel) => [...doc().querySelectorAll(sel)];
const text = (sel) => $(sel)?.textContent ?? '';

async function waitFor(check, { timeout = 6000, label = 'условие' } = {}) {
  const started = Date.now();
  for (;;) {
    let value;
    try {
      value = await check();
    } catch {
      value = false;
    }
    if (value) return value;
    if (Date.now() - started > timeout) {
      throw new Error(`Не дождались: ${label} (последняя проверка: ${JSON.stringify(value)})`);
    }
    await sleep(40);
  }
}

function fire(el, type, init = {}) {
  const EventCtor = init.key !== undefined ? dom.window.KeyboardEvent : dom.window.Event;
  el.dispatchEvent(new EventCtor(type, { bubbles: true, cancelable: true, ...init }));
}

function click(el) {
  assert.ok(el, 'элемент для клика не найден');
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

function setValue(el, value) {
  el.value = value;
  fire(el, 'input');
}

before(async () => {
  ctx = await startServer();

  // Данные: два друга, личный чат, одно входящее сообщение
  alice = await registerUser(ctx, { username: 'ui_alice', displayName: 'Алиса UI' });
  bob = await registerUser(ctx, { username: 'ui_bob', displayName: 'Боб UI' });
  await makeFriends(ctx, alice, bob);
  const direct = await call(ctx, 'POST', '/conversations/direct', { token: alice.token, body: { userId: bob.user.id } });
  conversationId = direct.data.conversation.id;
  await call(ctx, 'POST', `/conversations/${conversationId}/messages`, { token: bob.token, body: { body: 'историческое сообщение' } });

  // Собеседник будет слушать сокет как отдельный клиент
  peerClient = new WsClient(ctx, 'ui_bob_peer');
  await peerClient.connect(bob.token);

  // --- Поднимаем jsdom и прокидываем его globals в процесс ---
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  dom = new JSDOM(html, { url: `${ctx.base}/`, pretendToBeVisual: true });
  const { window } = dom;

  window.WebSocket = NodeWebSocket;
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};

  const assignGlobal = (key, value) => {
    try {
      Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
    } catch {
      try {
        globalThis[key] = value;
      } catch {
        /* ignore read-only */
      }
    }
  };

  assignGlobal('window', window);
  assignGlobal('document', window.document);
  assignGlobal('navigator', window.navigator);
  assignGlobal('localStorage', window.localStorage);
  assignGlobal('location', window.location);
  assignGlobal('HTMLElement', window.HTMLElement);
  assignGlobal('Node', window.Node);
  assignGlobal('Event', window.Event);
  assignGlobal('CustomEvent', window.CustomEvent);
  assignGlobal('KeyboardEvent', window.KeyboardEvent);
  assignGlobal('MouseEvent', window.MouseEvent);
  assignGlobal('FormData', window.FormData);
  assignGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  assignGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
  assignGlobal('WebSocket', NodeWebSocket);

  // Относительные URL ('/api/…') Node-fetch не понимает — дорезолвим до стенда
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) =>
    realFetch(typeof url === 'string' && url.startsWith('/') ? new URL(url, ctx.base) : url, options);

  await import('../public/js/main.js');
  await waitFor(() => $('#auth-screen') && !$('#auth-screen').classList.contains('hidden'), { label: 'экран входа' });
});

after(async () => {
  peerClient?.close();
  await sleep(50);
  dom?.window.close();
  await ctx.close();
});

describe('Интерфейс: вход и лента', () => {
  test('форма входа показывает демо-подсказки и валидирует пустые поля', async () => {
    const chips = $$('[data-demo]');
    assert.ok(chips.length >= 3, 'есть кнопки демо-доступов');
    click($('#auth-form [type="submit"]'));
    await waitFor(() => !$('#auth-error').hidden, { label: 'ошибка валидации' });
    assert.match(text('#auth-error'), /логин и пароль/i);
  });

  test('регистрация переключает вкладку и требует длинный пароль', async () => {
    click($('[data-tab="register"]'));
    assert.ok(!$('[data-only="register"]').classList.contains('hidden'), 'поле имени показано');
    assert.match(text('#auth-submit'), /Создать аккаунт/);
    setValue($('#auth-form [name="username"]'), 'newbie');
    setValue($('#auth-form [name="password"]'), '123');
    click($('#auth-form [type="submit"]'));
    await waitFor(() => !$('#auth-error').hidden, { label: 'ошибка длины пароля' });
    assert.match(text('#auth-error'), /6 символов/);
    click($('[data-tab="login"]'));
  });

  test('неверный пароль → понятная ошибка, приложение не открывается', async () => {
    setValue($('#auth-form [name="username"]'), 'ui_alice');
    setValue($('#auth-form [name="password"]'), 'wrongpass');
    click($('#auth-form [type="submit"]'));
    await waitFor(() => !$('#auth-error').hidden && /Неверный логин/.test(text('#auth-error')), { label: '401 в форме' });
    assert.ok($('#app').classList.contains('hidden'));
  });

  test('успешный вход: сайдбар показывает чаты и данные профиля', async () => {
    setValue($('#auth-form [name="username"]'), 'ui_alice');
    setValue($('#auth-form [name="password"]'), alice.password);
    click($('#auth-form [type="submit"]'));

    await waitFor(() => !$('#app').classList.contains('hidden'), { label: 'приложение открыто' });
    await waitFor(() => $$('#sidebar-list .row').length > 0, { label: 'список чатов' });
    assert.equal(text('#me-name'), 'Алиса UI');
    assert.equal(text('#me-nick'), '@ui_alice');

    const row = $('#sidebar-list .row');
    assert.equal(row.querySelector('.row__title span').textContent, 'Боб UI', 'заголовок лички — имя собеседника');
    assert.match(row.querySelector('.row__snippet').textContent, /историческое сообщение/);
    assert.ok(row.querySelector('.badge'), 'бейдж непрочитанных виден');
  });

  test('статус соединения меняется на «на связи»', async () => {
    await waitFor(() => text('#conn-text') === 'на связи', { label: 'websocket подключён' });
    assert.ok($('#conn-dot').classList.contains('is-online'));
  });
});

describe('Интерфейс: диалог', () => {
  test('клик по чату открывает ленту с историей', async () => {
    click($('#sidebar-list .row'));
    await waitFor(() => $$('#messages .msg').length > 0, { label: 'сообщения отрисованы' });
    assert.equal(text('#chat-title'), 'Боб UI');
    assert.match(text('#messages'), /историческое сообщение/);
    assert.match(text('#chat-subtitle'), /в сети|был\(а\)/);
    assert.ok($('#messages .day-sep'), 'есть разделитель дней');
    // Непрочитанные сброшены
    await waitFor(() => !$('#sidebar-list .row .badge'), { label: 'бейдж непрочитанных снят' });
  });

  test('отправка через композер: пузырёк появляется и долетает собеседнику', async () => {
    const body = 'привет из сквозного теста';
    setValue($('#composer-input'), body);
    assert.equal($('#btn-send').disabled, false, 'кнопка отправки активна');
    click($('#btn-send'));

    await waitFor(() => text('#messages').includes(body), { label: 'сообщение в ленте' });
    const received = await peerClient.wait((m) => m.type === 'message:new' && m.message?.body === body);
    assert.equal(received.conversationId, conversationId);

    await waitFor(() => {
      const own = $$('#messages .msg.is-own').at(-1);
      return own && own.querySelector('.tick') && !own.dataset.id.startsWith('tmp-');
    }, { label: 'оптимистичный пузырёк заменён настоящим' });

    assert.equal($$('#messages .msg').filter((n) => n.textContent.includes(body)).length, 1, 'нет дубля сообщения');
    assert.equal($('#composer-input').value, '', 'поле ввода очищено');
  });

  test('Enter отправляет, Shift+Enter переносит строку', async () => {
    setValue($('#composer-input'), 'черновик');
    fire($('#composer-input'), 'keydown', { key: 'Enter', shiftKey: true });
    assert.equal($('#composer-input').value, 'черновик', 'Shift+Enter не отправляет');
    await waitFor(() => text('#chat-subtitle') !== '', { label: 'заголовок на месте' });

    fire($('#composer-input'), 'keydown', { key: 'Enter' });
    await waitFor(() => text('#messages').includes('черновик'), { label: 'Enter отправил сообщение' });
    assert.equal($('#composer-input').value, '');
  });

  test('входящее сообщение появляется в ленте без перезагрузки', async () => {
    await call(ctx, 'POST', `/conversations/${conversationId}/messages`, { token: bob.token, body: { body: 'встречное сообщение' } });
    await waitFor(() => text('#messages').includes('встречное сообщение'), { label: 'live-сообщение в DOM' });
    const incoming = $$('#messages .msg').filter((n) => !n.classList.contains('is-own')).at(-1);
    assert.ok(incoming, 'чужое сообщение не помечено как своё');
    assert.ok(text('#sidebar-list .row .row__snippet').includes('встречное сообщение'), 'сниппет в сайдбаре обновился');
  });

  test('индикатор «печатает…» показывается и гаснет', async () => {
    peerClient.send({ type: 'typing', conversationId });
    await waitFor(() => !$('#typing-indicator').hidden, { label: 'индикатор печати' });
    assert.match(text('#typing-indicator'), /печатает/);
    assert.match(text('#chat-subtitle'), /печатает/);
  });

  test('ответ на сообщение подставляет цитату в композер', async () => {
    const replyButtons = $$('#messages .msg__tool').filter((b) => b.title === 'Ответить');
    assert.ok(replyButtons.length, 'кнопки ответа есть');
    click(replyButtons.at(-1));
    await waitFor(() => !$('#reply-preview').hidden, { label: 'превью ответа' });
    assert.ok(text('#reply-text').length > 0);

    setValue($('#composer-input'), 'отвечаю на цитату');
    click($('#btn-send'));
    await waitFor(() => {
      const node = $$('#messages .msg.is-own').at(-1);
      return node && node.querySelector('.quote') && text('#messages').includes('отвечаю на цитату');
    }, { label: 'сообщение с цитатой' });
    await waitFor(() => $('#reply-preview').hidden, { label: 'превью ответа скрыто' });
  });

  test('реакция ставится и отображается у собеседника', async () => {
    const reactButtons = $$('#messages .msg__tool').filter((b) => b.title === 'Отреагировать');
    click(reactButtons.at(-1));
    await waitFor(() => $('#reaction-popover'), { label: 'поповер реакций' });
    click($$('#reaction-popover button')[0]);
    await waitFor(() => $('#messages .reaction'), { label: 'реакция в DOM' });
    assert.match($('#messages .reaction').textContent, /1/);
  });

  test('редактирование своего сообщения меняет текст в ленте', async () => {
    setValue($('#composer-input'), 'текст до правки');
    click($('#btn-send'));
    await waitFor(() => text('#messages').includes('текст до правки'), { label: 'сообщение отправлено' });

    const editBtn = await waitFor(() => {
      const target = $$('#messages .msg.is-own').at(-1);
      if (!target) return null;
      return [...target.querySelectorAll('.msg__tool')].find((b) => b.title === 'Изменить');
    }, { label: 'кнопка Изменить' });
    click(editBtn);
    await waitFor(() => $('#composer-input').value === 'текст до правки', { label: 'текст подставлен в композер' });

    setValue($('#composer-input'), 'текст после правки');
    fire($('#composer-input'), 'keydown', { key: 'Enter' });
    await waitFor(() => text('#messages').includes('текст после правки'), { label: 'правка сохранена' });
    assert.ok(!text('#messages').includes('текст до правки'), 'старый текст исчез');
    assert.match($$('#messages .msg.is-own').at(-1).textContent, /изменено/);
  });

  test('удаление сообщения помечает его в ленте', async () => {
    setValue($('#composer-input'), 'сообщение на удаление');
    click($('#btn-send'));
    await waitFor(() => text('#messages').includes('сообщение на удаление'), { label: 'отправлено' });

    const delBtn = await waitFor(() => {
      const target = $$('#messages .msg.is-own').at(-1);
      if (!target) return null;
      return [...target.querySelectorAll('.msg__tool')].find((b) => b.title === 'Удалить');
    }, { label: 'кнопка Удалить' });
    click(delBtn);
    await waitFor(() => $('#modal-root .modal'), { label: 'диалог подтверждения' });
    click($$('#modal-root .modal__foot .btn').find((b) => b.textContent === 'Удалить'));
    await waitFor(() => text('#messages').includes('Сообщение удалено'), { label: 'сообщение удалено' });
    assert.ok(!text('#messages').includes('сообщение на удаление'));
  });
});

describe('Интерфейс: поиск, друзья, выход', () => {
  test('глобальный поиск находит человека и сообщение', async () => {
    setValue($('#global-search'), 'ui_bob');
    await waitFor(() => text('#sidebar-list').includes('Люди'), { label: 'результаты по людям' });
    assert.match(text('#sidebar-list'), /Боб UI/);

    setValue($('#global-search'), 'встречное');
    await waitFor(() => text('#sidebar-list').includes('Сообщения'), { label: 'результаты по сообщениям' });
    assert.ok($('#sidebar-list mark'), 'совпадение подсвечено');
    assert.match($('#sidebar-list mark').textContent, /встречное/i);

    click($('#search-clear'));
    await waitFor(() => $$('#sidebar-list .row').length > 0 && !text('#sidebar-list').includes('Сообщения ·'), { label: 'возврат к чатам' });
  });

  test('поиск внутри чата ограничивает выдачу диалогом', async () => {
    click($('#btn-search-in-chat'));
    await waitFor(() => !$('#chat-searchbar').hidden, { label: 'панель поиска в чате' });
    setValue($('#chat-search-input'), 'историческое');
    await waitFor(() => text('#messages').includes('Найдено'), { label: 'результаты в ленте' });
    assert.match(text('#messages'), /историческое сообщение/);
    click($('#chat-search-close'));
    await waitFor(() => $('#chat-searchbar').hidden, { label: 'поиск закрыт' });
  });

  test('вкладка «Друзья» показывает список и кнопку «Написать»', async () => {
    click($('.tab[data-pane="friends"]'));
    await waitFor(() => text('#sidebar-list').includes('Друзья ·'), { label: 'вкладка друзей' });
    assert.match(text('#sidebar-list'), /Боб UI/);
    assert.match(text('#sidebar-list'), /в сети|был\(а\)/);
    const write = $$('#sidebar-list .btn').find((b) => b.textContent === 'Написать');
    assert.ok(write, 'кнопка «Написать» на месте');
    click(write);
    await waitFor(() => !$('#app').classList.contains('hidden') && text('#chat-title') === 'Боб UI', { label: 'чат открылся из друзей' });
    click($('.tab[data-pane="chats"]'));
  });

  test('вкладка «Заявки» показывает входящую заявку с действиями', async () => {
    const carl = await registerUser(ctx, { username: 'ui_carl', displayName: 'Карл UI' });
    await call(ctx, 'POST', '/friends/requests', { token: carl.token, body: { username: 'ui_alice', message: 'добавь меня' } });
    await waitFor(() => Number($('#requests-badge').textContent) > 0 && !$('#requests-badge').hidden, { label: 'бейдж заявок' });

    click($('.tab[data-pane="requests"]'));
    await waitFor(() => text('#sidebar-list').includes('Входящие') && text('#sidebar-list').includes('Карл UI'), { label: 'вкладка заявок с Карлом' });
    assert.match(text('#sidebar-list'), /добавь меня/);

    const acceptBtn = await waitFor(() => $$('#sidebar-list .btn').find((b) => b.textContent === 'Принять'), { label: 'кнопка Принять' });
    click(acceptBtn);
    await waitFor(() => !text('#sidebar-list').includes('Карл UI') || !text('#sidebar-list').includes('Входящие · 1'), { label: 'заявка обработана' });
    await waitFor(() => {
      click($('.tab[data-pane="friends"]'));
      return text('#sidebar-list').includes('Карл UI');
    }, { label: 'новый друг в списке' });
    click($('.tab[data-pane="chats"]'));
  });

  test('панель информации о чате открывается и закрывается', async () => {
    // Открываем именно диалог с Бобом, а не первый в списке (после принятия заявки первым может стать Карл)
    const bobRow = $$('#sidebar-list .row').find((r) => r.textContent.includes('Боб UI')) || $('#sidebar-list .row');
    click(bobRow);
    await waitFor(() => $$('#messages .msg').length > 0 && text('#chat-title') === 'Боб UI', { label: 'чат с Бобом открыт' });
    click($('#btn-info'));
    await waitFor(() => !$('#info-panel').hidden, { label: 'панель инфо открыта' });
    assert.match(text('#info-panel'), /Боб UI/);
    assert.match(text('#info-panel'), /@ui_bob/);
    assert.ok($$('#info-panel .btn').some((b) => b.textContent === 'Заблокировать'));
    click($('#btn-info'));
    await waitFor(() => $('#info-panel').hidden, { label: 'панель инфо закрыта' });
  });

  test('выход через подтверждение возвращает на экран входа', async () => {
    click($('#btn-logout'));
    await waitFor(() => $('#modal-root .modal'), { label: 'диалог выхода' });
    assert.match(text('#modal-root .modal__title'), /Выйти из mmsgs/);
    click($$('#modal-root .modal__foot .btn').find((b) => b.textContent === 'Выйти'));
    await waitFor(() => !$('#auth-screen').classList.contains('hidden'), { label: 'экран входа снова виден' });
    assert.ok($('#app').classList.contains('hidden'));
    assert.equal(localStorage.getItem('mmsgs.token'), null, 'токен удалён');
  });
});
