import {
  state, sortedConversations, userById, isOnline, lastSeen, unreadTotal,
} from '../store.js';
import {
  h, clear, avatar, $, formatListTime, formatLastSeen, renderText, renderHighlighted,
} from '../ui.js';

/**
 * Сайдбар: три вкладки (чаты / друзья / заявки) и режим глобального поиска.
 * Все действия уходят наружу колбэками — представление не знает про API.
 */
export function createSidebar(actions) {
  const listEl = $('#sidebar-list');
  const tabs = [...document.querySelectorAll('.tab')];
  const searchInput = $('#global-search');
  const searchClear = $('#search-clear');
  const badge = $('#requests-badge');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      state.pane = tab.dataset.pane;
      state.query = '';
      state.searchResults = null;
      searchInput.value = '';
      actions.onPaneChange?.();
      render();
    });
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    state.query = '';
    state.searchResults = null;
    searchClear.hidden = true;
    actions.onSearch?.('');
    render();
    searchInput.focus();
  });

  searchInput.addEventListener('input', () => {
    const value = searchInput.value.trim();
    state.query = value;
    searchClear.hidden = !value;
    actions.onSearch?.(value);
  });

  searchInput.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') {
      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
    }
  });

  function setTab(name) {
    for (const tab of tabs) tab.classList.toggle('is-active', tab.dataset.pane === name);
  }

  /* ------------------------------ Строки списка ---------------------------- */

  function conversationRow(conv) {
    const isActive = Number(state.activeConversationId) === Number(conv.id);
    const last = conv.lastMessage;
    const snippet = last
      ? (last.deleted
        ? 'сообщение удалено'
        : last.attachment && !last.body
          ? '📎 вложение'
          : last.body)
      : conv.topic || 'Нет сообщений — напишите первым';

    const prefix = last && conv.type === 'group' && !last.deleted && last.sender?.id !== state.me?.id
      ? `${last.sender.displayName.split(' ')[0]}: `
      : last?.sender?.id === state.me?.id ? 'Вы: ' : '';

    const online = conv.type === 'direct' && conv.peer ? isOnline(conv.peer.id) : null;

    const row = h('div', {
      class: `row${isActive ? ' is-active' : ''}`,
      role: 'listitem',
      tabindex: '0',
      onClick: () => actions.onOpenConversation(conv.id),
      onKeydown: (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          actions.onOpenConversation(conv.id);
        }
      },
    }, [
      avatar(conv.type === 'group' ? { title: conv.title, avatarColor: conv.avatarColor } : conv.peer, {
        group: conv.type === 'group',
        presence: online,
      }),
      h('div', { class: 'row__main' }, [
        h('div', { class: 'row__title' }, [
          h('span', { text: conv.title, style: { overflow: 'hidden', textOverflow: 'ellipsis' } }),
          conv.type === 'group' ? h('span', { class: 'tag', text: 'группа' }) : null,
        ]),
        h('div', { class: 'row__snippet' }, [
          prefix ? h('span', { text: prefix }) : null,
          renderText(snippet),
        ]),
      ]),
      h('div', { class: 'row__meta' }, [
        h('span', { class: 'row__time', text: formatListTime(last?.createdAt || conv.lastMessageAt || conv.createdAt) }),
        conv.unread > 0 ? h('span', { class: 'badge', text: String(conv.unread > 99 ? '99+' : conv.unread) }) : null,
      ]),
    ]);
    return row;
  }

  function friendRow(friend) {
    const online = isOnline(friend.id);
    return h('div', { class: 'row', role: 'listitem' }, [
      avatar(friend, { presence: online }),
      h('div', { class: 'row__main' }, [
        h('div', { class: 'row__title' }, [h('span', { text: friend.displayName })]),
        h('div', {
          class: 'row__snippet',
          style: online ? { color: 'var(--green)' } : undefined,
          text: online ? 'в сети' : `@${friend.username} · ${formatLastSeen(lastSeen(friend.id))}`,
        }),
      ]),
      h('div', { class: 'row__actions' }, [
        h('button', {
          class: 'btn btn--sm',
          text: 'Написать',
          onClick: (evt) => { evt.stopPropagation(); actions.onOpenFriend(friend.id); },
        }),
        h('button', {
          class: 'icon-btn icon-btn--sm',
          title: 'Удалить из друзей',
          text: '✕',
          onClick: (evt) => { evt.stopPropagation(); actions.onRemoveFriend(friend); },
        }),
      ]),
    ]);
  }

  function requestRow(request) {
    // Сервер отдаёт direction, но в live-событии его может не быть — считаем входящей, если лежит в incoming
    const incoming = request.direction ? request.direction === 'incoming' : true;
    return h('div', { class: 'row', role: 'listitem' }, [
      avatar(request.user, {}),
      h('div', { class: 'row__main' }, [
        h('div', { class: 'row__title' }, [
          h('span', { text: request.user.displayName }),
          h('span', { class: `tag tag--${incoming ? 'incoming' : 'outgoing'}`, text: incoming ? 'вам' : 'отправлена' }),
        ]),
        h('div', { class: 'row__snippet', text: request.message || `@${request.user.username}` }),
      ]),
      h('div', { class: 'row__actions' }, incoming
        ? [
          h('button', { class: 'btn btn--sm btn--primary', text: 'Принять', onClick: () => actions.onAcceptRequest(request) }),
          h('button', { class: 'btn btn--sm btn--ghost', text: 'Отклонить', onClick: () => actions.onDeclineRequest(request) }),
        ]
        : [
          h('button', { class: 'btn btn--sm btn--ghost', text: 'Отозвать', onClick: () => actions.onDeclineRequest(request) }),
        ]),
    ]);
  }

  function userRow(user, { action } = {}) {
    const relation = user.relation;
    const tagText = {
      friends: 'в друзьях', outgoing: 'заявка отправлена', incoming: 'ждёт вашего ответа',
      blocked: 'заблокирован', blocked_by: 'ограничил вас', none: '', self: 'это вы',
    }[relation] || '';

    const buttons = [];
    if (relation === 'none') {
      buttons.push(h('button', { class: 'btn btn--sm btn--primary', text: 'Добавить', onClick: () => actions.onAddFriend(user) }));
    } else if (relation === 'incoming') {
      buttons.push(h('button', { class: 'btn btn--sm btn--primary', text: 'Принять', onClick: () => actions.onAcceptFromSearch(user) }));
    } else if (relation === 'outgoing') {
      buttons.push(h('button', { class: 'btn btn--sm btn--ghost', text: 'Отозвать', onClick: () => actions.onCancelFromSearch(user) }));
    } else if (relation === 'friends') {
      buttons.push(h('button', { class: 'btn btn--sm', text: 'Написать', onClick: () => actions.onOpenFriend(user.id) }));
    }
    if (action) buttons.push(action);

    return h('div', { class: 'row', role: 'listitem' }, [
      avatar(user, { presence: isOnline(user.id) }),
      h('div', { class: 'row__main' }, [
        h('div', { class: 'row__title' }, [
          h('span', { text: user.displayName }),
          tagText ? h('span', { class: `tag tag--${relation === 'friends' ? 'friends' : relation}`, text: tagText }) : null,
        ]),
        h('div', {
          class: 'row__snippet',
          text: user.bio ? `${user.bio}` : `@${user.username}`,
        }),
      ]),
      h('div', { class: 'row__actions' }, buttons),
    ]);
  }

  function messageResultRow(hit) {
    const conv = hit.conversation;
    return h('button', {
      class: 'row',
      role: 'listitem',
      onClick: () => actions.onOpenMessage?.(conv.id, hit.message.id),
    }, [
      avatar(conv.type === 'group' ? { title: conv.title, avatarColor: conv.avatarColor } : conv.peer, { group: conv.type === 'group' }),
      h('div', { class: 'row__main' }, [
        h('div', { class: 'row__title' }, [
          h('span', { text: conv.title }),
          h('span', { class: 'row__time', text: formatListTime(hit.message.createdAt) }),
        ]),
        h('div', { class: 'row__snippet' }, [
          h('span', { text: `${hit.message.sender?.displayName || ''}: ` }),
          renderHighlighted(hit.matches),
        ]),
      ]),
    ]);
  }

  function emptyState(title, hint, actionNode) {
    return h('div', { class: 'empty' }, [
      h('strong', { text: title }),
      h('span', { text: hint }),
      actionNode ? h('div', { style: { marginTop: '12px' } }, [actionNode]) : null,
    ]);
  }

  /* -------------------------------- Отрисовка ------------------------------ */

  function renderSearch() {
    const results = state.searchResults;
    if (state.searchLoading) {
      return [h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })];
    }
    if (!results) return [emptyState('Начните вводить запрос', 'Ищем по логину, имени и тексту ваших сообщений')];

    const users = results.users || [];
    const messages = results.messages || [];
    if (!users.length && !messages.length) {
      return [emptyState('Ничего не найдено', `По запросу «${state.query}» нет людей и сообщений`)];
    }

    const nodes = [];
    if (users.length) {
      nodes.push(h('div', { class: 'result-group' }, [
        h('div', { class: 'result-head', text: `Люди · ${users.length}` }),
        ...users.map((u) => userRow(u)),
      ]));
    }
    if (messages.length) {
      nodes.push(h('div', { class: 'result-group' }, [
        h('div', { class: 'result-head', text: `Сообщения · ${messages.length}` }),
        ...messages.map(messageResultRow),
      ]));
    }
    return nodes;
  }

  function renderChats() {
    const conversations = sortedConversations();
    if (!conversations.length) {
      return [emptyState('Пока нет чатов', 'Найдите человека во вкладке «Друзья» или создайте группу',
        h('button', { class: 'btn btn--primary btn--sm', text: 'Найти людей', onClick: () => actions.onPaneChange?.('friends') }))];
    }
    return conversations.map(conversationRow);
  }

  function renderFriends() {
    const nodes = [];
    nodes.push(h('div', { class: 'section-label', text: `Друзья · ${state.friends.length}` }));
    if (!state.friends.length) {
      nodes.push(emptyState('Список друзей пуст', 'Добавьте первого собеседника через поиск выше',
        h('button', { class: 'btn btn--primary btn--sm', text: 'Найти людей', onClick: () => actions.onOpenAddFriend?.() })));
    } else {
      const online = state.friends.filter((f) => isOnline(f.id));
      const offline = state.friends.filter((f) => !isOnline(f.id));
      for (const friend of [...online, ...offline]) nodes.push(friendRow(friend));
    }
    if (state.blocked.length) {
      nodes.push(h('div', { class: 'section-label', text: `Чёрный список · ${state.blocked.length}` }));
      for (const user of state.blocked) {
        nodes.push(userRow({ ...user, relation: 'blocked' }, {
          action: h('button', { class: 'btn btn--sm btn--ghost', text: 'Разблокировать', onClick: () => actions.onUnblock(user) }),
        }));
      }
    }
    return nodes;
  }

  function renderRequests() {
    const nodes = [];
    const { incoming, outgoing } = state.requests;
    nodes.push(h('div', { class: 'section-label', text: `Входящие · ${incoming.length}` }));
    if (!incoming.length) nodes.push(h('div', { class: 'empty', text: 'Новых заявок нет' }));
    else nodes.push(...incoming.map(requestRow));

    nodes.push(h('div', { class: 'section-label', text: `Исходящие · ${outgoing.length}` }));
    if (!outgoing.length) nodes.push(h('div', { class: 'empty', text: 'Вы никому не отправляли заявку' }));
    else nodes.push(...outgoing.map(requestRow));
    return nodes;
  }

  function render() {
    setTab(state.pane);
    clear(listEl);

    const searching = state.query.length > 0;
    const nodes = searching
      ? renderSearch()
      : state.pane === 'chats' ? renderChats()
        : state.pane === 'friends' ? renderFriends()
          : renderRequests();

    for (const node of nodes) listEl.appendChild(node);

    const total = unreadTotal();
    document.title = total > 0 ? `(${total}) mmsgs` : 'mmsgs — мессенджер';

    const requests = state.requests.incoming.length;
    badge.hidden = requests === 0;
    badge.textContent = String(requests);
  }

  return {
    render,
    setPane(pane) {
      state.pane = pane;
      render();
    },
    focusSearch() {
      searchInput.focus();
      searchInput.select();
    },
    clearSearch() {
      searchInput.value = '';
      state.query = '';
      state.searchResults = null;
      searchClear.hidden = true;
      render();
    },
  };
}
