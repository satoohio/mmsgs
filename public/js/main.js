import { api, session, ApiError } from './api.js';
import { Realtime } from './rt.js';
import {
  state, applyBootstrap, upsertConversation, patchConversation,
  removeConversation, setMessages, prependMessages, addMessage, addPendingMessage,
  resolvePending, replaceMessage, markMessageDeleted, setPresence, markTyping,
  clearTyping, markRead, bumpUnread, getConversation, activeConversation,
  messagesOf, resetChatState, userById, typingIn,
} from './store.js';
import { $, h, clear, toast, toastError, avatar, confirmDialog, debounce } from './ui.js';
import { initAuth } from './views/auth.js';
import { createSidebar } from './views/sidebar.js';
import { createChat } from './views/chat.js';
import { createInfoPanel } from './views/info.js';
import {
  newGroupModal, addMembersModal, addFriendModal, userProfileModal,
  settingsModal, imageLightbox,
} from './views/modals.js';

const PAGE_SIZE = 50;

/* ============================== Контроллер ================================ */

const controller = {
  rt: null,
  sidebar: null,
  chat: null,
  info: null,
  auth: null,
  notAtLiveEdge: false,
};

function renderAll(scope = 'all') {
  controller.sidebar?.render();
  controller.chat?.render();
  controller.info?.render();
  renderMe();
  renderConnection();
  void scope;
}

function renderMe() {
  if (!state.me) return;
  $('#me-name').textContent = state.me.displayName;
  $('#me-nick').textContent = `@${state.me.username}`;
  const meAvatar = $('#me-avatar');
  const fresh = avatar(state.me, {});
  meAvatar.className = `${fresh.className} avatar--me`;
  meAvatar.style.background = fresh.style.background;
  meAvatar.textContent = fresh.textContent;
}

function renderConnection() {
  const dot = $('#conn-dot');
  const text = $('#conn-text');
  dot.className = 'dot';
  if (state.connection === 'online') {
    dot.classList.add('is-online');
    text.textContent = 'на связи';
  } else if (state.connection === 'connecting') {
    dot.classList.add('is-connecting');
    text.textContent = 'подключение…';
  } else {
    dot.classList.add('is-offline');
    text.textContent = 'нет соединения — работаем через HTTP';
  }
}

/* ============================ Открытие чата ================================ */

async function openConversation(id, { jumpToMessageId = null } = {}) {
  const conv = getConversation(id);
  if (!conv) return;
  state.activeConversationId = conv.id;
  state.replyTo = null;
  state.editingMessageId = null;
  state.chatQuery = '';
  controller.chat?.renderComposer(conv);
  $('#chat-searchbar').hidden = true;

  const box = messagesOf(conv.id);
  if (!box.list.length) {
    try {
      const data = await api.messages(conv.id, { limit: PAGE_SIZE });
      setMessages(conv.id, data.messages, data.hasMore);
      controller.notAtLiveEdge = false;
    } catch (err) {
      toastError(err);
    }
  }

  conv.unread = 0;
  renderAll();
  await markConversationRead(conv);
  controller.chat?.focusInput();
  if (jumpToMessageId) jumpToMessage(conv.id, jumpToMessageId);
}

async function markConversationRead(conv) {
  const box = messagesOf(conv.id);
  const last = box.list.filter((m) => m.id).at(-1);
  if (!last) return;
  if (Number(conv.lastReadMessageId || 0) >= Number(last.id)) return;
  conv.lastReadMessageId = last.id;
  conv.unread = 0;
  controller.rt?.read(conv.id, last.id);
  try {
    await api.markRead(conv.id, last.id);
  } catch {
    /* отметка о прочтении не критична: повторим при следующем открытии */
  }
  controller.sidebar?.render();
  controller.chat?.markReadTicks();
}

async function jumpToMessage(conversationId, messageId) {
  const box = messagesOf(conversationId);
  if (box.list.some((m) => m.id === Number(messageId))) {
    controller.chat?.scrollToMessage(messageId);
    return;
  }
  try {
    const data = await api.messages(conversationId, { before: Number(messageId) + 1, limit: PAGE_SIZE });
    setMessages(conversationId, data.messages, data.hasMore);
    controller.notAtLiveEdge = true;
    controller.chat?.renderMessages();
    controller.chat?.scrollToMessage(messageId);
    showLiveEdgeButton(conversationId);
  } catch (err) {
    toastError(err);
  }
}

/** Кнопка возврата к «живому» краю ленты после прыжка в историю. */
function showLiveEdgeButton(conversationId) {
  document.getElementById('live-edge')?.remove();
  if (!controller.notAtLiveEdge) return;
  const button = h('button', {
    id: 'live-edge',
    class: 'load-more',
    text: '↓ К последним сообщениям',
    style: { position: 'absolute', bottom: '96px', right: '24px', zIndex: '30', boxShadow: 'var(--shadow-sm)' },
    onClick: async () => {
      const data = await api.messages(conversationId, { limit: PAGE_SIZE });
      setMessages(conversationId, data.messages, data.hasMore);
      controller.notAtLiveEdge = false;
      button.remove();
      controller.chat?.renderMessages();
      controller.chat?.scrollBottom(true);
      markConversationRead(getConversation(conversationId));
    },
  });
  document.getElementById('chat').appendChild(button);
}

/* =============================== Отправка ================================== */

function tempId() {
  return `tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function sendPayload({ body, replyToId, attachments }) {
  // Режим редактирования: вместо отправки нового — правим существующее
  if (state.editingMessageId) {
    const id = state.editingMessageId;
    try {
      const { message } = await api.edit(id, body);
      const replaced = replaceMessage(message);
      if (replaced) controller.chat?.refreshMessage(replaced);
      state.editingMessageId = null;
      controller.chat?.setEditing(null);
    } catch (err) {
      toastError(err);
    }
    return;
  }

  const conv = activeConversation();
  if (!conv) return;

  const files = attachments || [];
  if (!body && !files.length) return;

  // Один клиентский id на «пачку», чтобы оптимистичные пузырьки совместились
  const clientId = tempId();
  const optimistic = {
    id: null,
    clientId,
    conversationId: conv.id,
    sender: state.me,
    body,
    replyTo: replyToId || null,
    attachment: null,
    createdAt: Date.now(),
    reactions: {},
    status: 'pending',
  };
  addPendingMessage(optimistic);
  patchConversation(conv.id, {
    lastMessage: { ...optimistic, id: null },
    lastMessageAt: optimistic.createdAt,
  });
  controller.chat?.appendMessage(optimistic);
  controller.sidebar?.render();
  controller.chat?.scrollBottom(true);

  try {
    let uploaded = [];
    if (files.length) {
      // state.attachments хранит {file, ...}, а в тестах может прийти уже File
      uploaded = await Promise.all(files.map((item) => api.upload(item.file || item)));
    }

    const first = uploaded[0] || null;
    const viaSocket = controller.rt?.isOpen && !replyToId && uploaded.length <= 1;

    if (viaSocket) {
      // Быстрый путь: один кадр в сокет, подтверждение придёт message:sent
      controller.rt.sendMessage({
        conversationId: conv.id, body, replyToId: replyToId || undefined,
        attachmentId: first?.id, clientId,
      });
    } else {
      const created = await api.send(conv.id, { body, replyToId, attachmentId: first?.id });
      resolvePending(clientId, { messageId: created.message.id });
      const { message } = addMessage(created.message, { clientId });
      patchConversation(conv.id, { lastMessage: message, lastMessageAt: message.createdAt });
      controller.chat?.renderMessages();
      controller.chat?.scrollBottom(true);
      controller.sidebar?.render();
    }

    // Остальные файлы — отдельными сообщениями, чтобы не терять их
    for (const extra of uploaded.slice(1)) {
      const extraClient = tempId();
      addPendingMessage({ ...optimistic, id: null, clientId: extraClient, body: '', attachment: extra });
      const created = await api.send(conv.id, { body: '', attachmentId: extra.id });
      resolvePending(extraClient, { messageId: created.message.id });
      addMessage(created.message, { clientId: extraClient });
    }
    if (uploaded.length > 1) {
      controller.chat?.renderMessages();
      controller.chat?.scrollBottom(true);
    }

    state.replyTo = null;
    state.attachments = [];
    controller.chat?.renderReply();
    controller.chat?.renderAttachments();
  } catch (err) {
    resolvePending(clientId, { error: err.message });
    controller.chat?.renderMessages();
    toastError(err);
  }
}

/* ============================ Обработка событий WS ========================== */

function handleEvent(msg) {
  switch (msg.type) {
    case 'ready':
      applyBootstrap(msg);
      renderAll();
      break;

    case 'unauthorized':
      logout(true);
      break;

    case 'presence':
      setPresence(msg.userId, msg.online, msg.lastSeenAt);
      controller.sidebar?.render();
      if (activeConversation()?.memberIds?.includes(Number(msg.userId))) controller.chat?.renderHeader(activeConversation());
      break;

    case 'message:new': {
      const conv = getConversation(msg.conversationId);
      // Сохраняем clientId внутри сообщения, чтобы лента могла заменить оптимистичный пузырёк, а не дублировать
      if (msg.clientId && !msg.message.clientId) msg.message.clientId = msg.clientId;
      const { message, replaced } = addMessage(msg.message, { clientId: msg.clientId });
      if (!replaced && msg.clientId) {
        const pending = resolvePending(msg.clientId, { messageId: message.id });
        void pending;
      }
      if (conv) {
        patchConversation(conv.id, { lastMessage: message, lastMessageAt: message.createdAt });
        bumpUnread(conv, message);
      }
      const isActive = Number(state.activeConversationId) === Number(msg.conversationId);
      if (isActive) {
        controller.chat?.appendMessage(message);
        controller.chat?.renderHeader(activeConversation());
        clearTyping(msg.conversationId, message.sender?.id);
        controller.chat?.renderTyping();
        if (!document.hidden) markConversationRead(getConversation(msg.conversationId));
      } else if (message.sender?.id !== state.me?.id) {
        notifyAboutMessage(message, conv);
      }
      controller.sidebar?.render();
      break;
    }

    case 'message:sent': {
      const resolved = resolvePending(msg.clientId, { messageId: msg.messageId });
      if (resolved) {
        resolved.conversationId = msg.conversationId;
        resolved.createdAt = msg.createdAt || resolved.createdAt;
        controller.chat?.refreshMessage(resolved);
      }
      break;
    }

    case 'message:updated': {
      const updated = replaceMessage(msg.message);
      if (updated) {
        const conv = getConversation(msg.conversationId);
        if (conv?.lastMessage?.id === msg.message.id) patchConversation(conv.id, { lastMessage: updated });
        controller.chat?.refreshMessage(updated);
        controller.sidebar?.render();
      }
      break;
    }

    case 'message:deleted': {
      markMessageDeleted(msg.conversationId, msg.messageId);
      controller.chat?.removeMessageNode(msg.messageId);
      if (msg.patch) patchConversation(msg.patch.id, msg.patch);
      controller.sidebar?.render();
      break;
    }

    case 'conversation:patch':
      patchConversation(msg.patch.id, msg.patch);
      controller.sidebar?.render();
      break;

    case 'conversation:new':
      upsertConversation(msg.conversation);
      controller.sidebar?.render();
      if (msg.conversation.type === 'group') {
        toast('Новая группа', msg.conversation.title, 'info');
      }
      break;

    case 'conversation:updated':
      upsertConversation(msg.conversation);
      controller.sidebar?.render();
      if (Number(state.activeConversationId) === Number(msg.conversation.id)) {
        controller.chat?.renderHeader(msg.conversation);
        controller.info?.render();
      }
      break;

    case 'conversation:removed':
      removeConversation(msg.conversationId);
      renderAll();
      toast(msg.left ? 'Вы покинули чат' : 'Вас удалили из чата', '', 'info');
      break;

    case 'typing': {
      markTyping(msg.conversationId, msg.userId, 5000);
      controller.chat?.scheduleTypingRefresh();
      if (Number(state.activeConversationId) === Number(msg.conversationId)) {
        controller.chat?.renderTyping();
        controller.chat?.renderHeader(activeConversation());
      }
      break;
    }

    case 'read': {
      const conv = getConversation(msg.conversationId);
      if (conv) markRead(conv.id, msg.messageId);
      controller.chat?.markReadTicks();
      break;
    }

    case 'friend:request':
      state.requests.incoming = [msg.request, ...state.requests.incoming.filter((r) => r.id !== msg.request.id)];
      controller.sidebar?.render();
      toast('Заявка в друзья', `${msg.request.user.displayName}: ${msg.request.message || 'хочет добавить вас'}`, 'info', 6500);
      break;

    case 'friend:accepted': {
      const friend = msg.request.user.id === state.me?.id ? msg.request.otherUser : msg.request.user;
      if (friend && !state.friends.some((f) => f.id === friend.id)) state.friends.push(friend);
      state.requests.incoming = state.requests.incoming.filter((r) => r.user.id !== friend?.id);
      state.requests.outgoing = state.requests.outgoing.filter((r) => r.user.id !== friend?.id);
      controller.sidebar?.render();
      toast('Новый друг', friend?.displayName || '', 'success');
      break;
    }

    case 'friend:removed':
      state.friends = state.friends.filter((f) => f.id !== Number(msg.friendId));
      controller.sidebar?.render();
      break;

    case 'user:updated':
      if (msg.user) {
        state.users.set(msg.user.id, msg.user);
        if (msg.self && state.me) state.me = { ...state.me, ...msg.user };
        for (const conv of state.conversations) {
          const member = (conv.members || []).find((m) => m.id === msg.user.id);
          if (member) Object.assign(member, msg.user);
          if (conv.peer?.id === msg.user.id) Object.assign(conv.peer, msg.user);
          if (conv.type === 'direct' && conv.peer?.id === msg.user.id) conv.title = msg.user.displayName;
        }
        const index = state.friends.findIndex((f) => f.id === msg.user.id);
        if (index !== -1) state.friends[index] = { ...state.friends[index], ...msg.user };
        renderMe();
        controller.sidebar?.render();
        controller.chat?.renderHeader(activeConversation());
      }
      break;

    case 'error':
      if (msg.refId) resolvePending(msg.refId, { error: msg.error });
      controller.chat?.renderMessages();
      toast(msg.error || 'Ошибка', msg.ref ? `(${msg.ref})` : '', 'error');
      break;

    default:
      break;
  }
}

function notifyAboutMessage(message, conv) {
  const title = conv?.title || 'Новое сообщение';
  toast(`${title}: ${message.sender?.displayName || ''}`, message.body || '📎 вложение', 'info', 5000);
}

/* ================================ Действия ================================= */

const actions = {
  token: () => session.token,

  onPaneChange: (pane) => {
    if (pane) state.pane = pane;
    renderAll();
  },

  onOpenConversation: (id) => openConversation(id),

  async onOpenFriend(userId) {
    const friend = state.friends.find((f) => f.id === Number(userId)) || userById(userId);
    if (friend?.conversationId) {
      await openConversation(friend.conversationId);
      return;
    }
    try {
      const { conversation } = await api.openDirect(userId);
      upsertConversation(conversation);
      await openConversation(conversation.id);
    } catch (err) {
      toastError(err);
    }
  },

  onBack() {
    state.activeConversationId = null;
    document.getElementById('app').classList.remove('chat-open');
    renderAll();
  },

  onToggleInfo() {
    state.infoOpen = !state.infoOpen;
    controller.info?.render();
  },

  onSend: (payload) => sendPayload(payload),

  onTyping: (conversationId) => controller.rt?.typing(conversationId),

  onReply(message) {
    state.replyTo = message;
    state.editingMessageId = null;
    controller.chat?.renderReply();
    controller.chat?.focusInput();
  },

  onCancelReply() {
    state.replyTo = null;
    controller.chat?.renderReply();
  },

  onEditRequest(message) {
    state.editingMessageId = message.id;
    state.replyTo = null;
    controller.chat?.renderReply();
    controller.chat?.setEditing(message);
  },

  onCancelEdit() {
    state.editingMessageId = null;
    controller.chat?.setEditing(null);
  },

  async onDelete(message) {
    const own = message.sender?.id === state.me?.id;
    const ok = await confirmDialog({
      title: own ? 'Удалить сообщение?' : 'Удалить сообщение участника?',
      text: own
        ? 'Сообщение исчезнет у всех участников чата. Отменить удаление нельзя.'
        : 'Как владелец группы вы можете удалить это сообщение у всех участников.',
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    try {
      await api.remove(message.id);
      markMessageDeleted(message.conversationId, message.id);
      controller.chat?.removeMessageNode(message.id);
      controller.sidebar?.render();
    } catch (err) {
      toastError(err);
    }
  },

  async onReact(message, emoji, remove) {
    try {
      const { message: updated } = await api.react(message.id, emoji, remove);
      const replaced = replaceMessage(updated);
      if (replaced) controller.chat?.refreshMessage(replaced);
    } catch (err) {
      toastError(err);
    }
  },

  async onLoadOlder(conversationId) {
    const box = messagesOf(conversationId);
    const oldest = box.list.find((m) => m.id);
    if (!oldest) return Promise.resolve();
    try {
      const data = await api.messages(conversationId, { before: oldest.id, limit: PAGE_SIZE });
      prependMessages(conversationId, data.messages);
      box.hasMore = data.hasMore;
      controller.chat?.renderMessages();
      if (!data.hasMore) showLiveEdgeButton(conversationId);
    } catch (err) {
      toastError(err);
    }
    return undefined;
  },

  onViewedBottom(conversationId) {
    if (controller.notAtLiveEdge) return;
    const conv = getConversation(conversationId);
    if (conv && document.hidden === false) markConversationRead(conv);
  },

  onSearch: debounce(async (query) => {
    if (!query) {
      state.searchResults = null;
      state.searchLoading = false;
      controller.sidebar?.render();
      return;
    }
    state.searchLoading = true;
    controller.sidebar?.render();
    try {
      const data = await api.search(query);
      state.searchResults = data;
    } catch (err) {
      toastError(err);
      state.searchResults = null;
    } finally {
      state.searchLoading = false;
      controller.sidebar?.render();
    }
  }, 280),

  async onSearchInChat(query) {
    state.chatQuery = query;
    const conv = activeConversation();
    if (!conv) return;
    if (!query) {
      state.chatSearchResults = null;
      controller.chat?.renderMessages();
      return;
    }
    try {
      const data = await api.search(query, conv.id);
      state.chatSearchResults = data.messages;
      renderChatSearchResults(conv, data.messages, query);
    } catch (err) {
      toastError(err);
    }
  },

  onOpenMessage: (conversationId, messageId) => openConversation(conversationId, { jumpToMessageId: messageId }),
  onJumpToMessage: (messageId) => {
    const conv = activeConversation();
    if (conv) jumpToMessage(conv.id, messageId);
  },

  onOpenAttachment(attachment) {
    imageLightbox(attachment, session.token);
  },

  async onOpenUser(userId) {
    if (!userId) return;
    try {
      const { user, relation, conversationId } = await api.getUser(userId);
      state.users.set(user.id, user);
      userProfileModal({
        user,
        relation,
        onMessage: async () => {
          if (conversationId) await openConversation(conversationId);
          else actions.onOpenFriend(user.id);
        },
        onAddFriend: async () => {
          try {
            await api.sendRequest({ userId: user.id });
            toast('Заявка отправлена', user.displayName, 'success');
            await refreshSocial();
          } catch (err) {
            toastError(err);
          }
        },
        onRemoveFriend: async () => actions.onRemoveFriend(user),
        onBlock: async () => actions.onBlock(user),
        onUnblock: async () => actions.onUnblock(user),
      });
    } catch (err) {
      toastError(err);
    }
  },

  async onAddFriend(user) {
    if (!user) return;
    try {
      const { request } = await api.sendRequest({ userId: user.id });
      toast(request.status === 'accepted' ? 'Дружба установлена' : 'Заявка отправлена', user.displayName, 'success');
      await refreshSocial();
    } catch (err) {
      toastError(err);
    }
  },

  async onAcceptFromSearch(user) {
    const found = state.requests.incoming.find((r) => r.user.id === user.id);
    if (found) await acceptRequest(found);
  },

  async onCancelFromSearch(user) {
    const found = state.requests.outgoing.find((r) => r.user.id === user.id);
    if (found) await declineRequest(found);
  },

  async onAcceptRequest(request) {
    await acceptRequest(request);
  },

  async onDeclineRequest(request) {
    await declineRequest(request);
  },

  async onRemoveFriend(friend) {
    if (!friend) return;
    const ok = await confirmDialog({
      title: 'Удалить из друзей?',
      text: `${friend.displayName} перестанет быть вашим другом. История переписки сохранится.`,
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    try {
      await api.removeFriend(friend.id);
      state.friends = state.friends.filter((f) => f.id !== friend.id);
      renderAll();
      toast('Удалено из друзей', friend.displayName, 'info');
    } catch (err) {
      toastError(err);
    }
  },

  async onBlock(user) {
    if (!user) return;
    const ok = await confirmDialog({
      title: 'Заблокировать?',
      text: `${user.displayName} не сможет писать вам и добавлять в друзья.`,
      confirmLabel: 'Заблокировать',
    });
    if (!ok) return;
    try {
      await api.block(user.id);
      await refreshSocial();
      toast('Заблокировано', user.displayName, 'info');
    } catch (err) {
      toastError(err);
    }
  },

  async onUnblock(user) {
    try {
      await api.unblock(user.id);
      await refreshSocial();
      toast('Разблокировано', user.displayName, 'success');
    } catch (err) {
      toastError(err);
    }
  },

  onOpenAddFriend() {
    addFriendModal({
      onAdded: async ({ openConversationId } = {}) => {
        await refreshSocial();
        if (openConversationId) await openConversation(openConversationId);
      },
    });
  },

  onNewGroup() {
    newGroupModal({
      friends: state.friends,
      onCreate: async ({ title, memberIds }) => {
        try {
          const { conversation } = await api.createGroup(title, memberIds);
          upsertConversation(conversation);
          await openConversation(conversation.id);
          toast('Группа создана', conversation.title, 'success');
        } catch (err) {
          toastError(err);
          throw err;
        }
      },
    });
  },

  onAddMembers(conv) {
    const candidates = state.friends.filter((f) => !conv.memberIds.includes(f.id));
    addMembersModal({
      conversation: conv,
      candidates,
      onConfirm: async (ids) => {
        try {
          const { conversation } = await api.addMembers(conv.id, ids);
          upsertConversation(conversation);
          renderAll();
          toast('Участники добавлены', `${ids.length}`, 'success');
        } catch (err) {
          toastError(err);
          throw err;
        }
      },
    });
  },

  async onRemoveMember(conv, member) {
    const ok = await confirmDialog({
      title: 'Исключить участника?',
      text: `${member.displayName} потеряет доступ к чату.`,
      confirmLabel: 'Исключить',
    });
    if (!ok) return;
    try {
      await api.removeMember(conv.id, member.id);
      const fresh = await api.conversation(conv.id);
      upsertConversation(fresh.conversation);
      renderAll();
    } catch (err) {
      toastError(err);
    }
  },

  async onLeave(conv) {
    const ok = await confirmDialog({
      title: 'Покинуть группу?',
      text: `Вы перестанете получать сообщения из «${conv.title}». Вернуться можно будет только по приглашению.`,
      confirmLabel: 'Покинуть',
    });
    if (!ok) return;
    try {
      await api.removeMember(conv.id, state.me.id);
      removeConversation(conv.id);
      renderAll();
      toast('Вы покинули группу', conv.title, 'info');
    } catch (err) {
      toastError(err);
    }
  },

  async onRename(conv) {
    const { promptDialog } = await import('./ui.js');
    const title = await promptDialog({
      title: 'Новое название группы',
      label: 'Название',
      value: conv.title,
      validate: (v) => (v.length < 2 ? 'Минимум 2 символа' : null),
    });
    if (!title) return;
    try {
      const { conversation } = await api.updateConversation(conv.id, { title });
      upsertConversation(conversation);
      renderAll();
    } catch (err) {
      toastError(err);
    }
  },

  async onSetTopic(conv) {
    const { promptDialog } = await import('./ui.js');
    const topic = await promptDialog({
      title: 'Описание группы',
      label: 'Описание',
      value: conv.topic || '',
      placeholder: 'О чём этот чат',
    });
    if (topic === null) return;
    try {
      const { conversation } = await api.updateConversation(conv.id, { topic });
      upsertConversation(conversation);
      renderAll();
    } catch (err) {
      toastError(err);
    }
  },

  async onAttachFiles(files) {
    const conv = activeConversation();
    if (!conv) {
      toast('Сначала выберите чат', '', 'warning');
      return;
    }
    const accepted = [];
    for (const file of files) {
      if (file.size > 8 * 1024 * 1024) {
        toast('Файл слишком большой', `${file.name}: максимум 8 МБ`, 'error');
        continue;
      }
      accepted.push({
        file,
        filename: file.name,
        size: file.size,
        mime: file.type,
        isImage: file.type.startsWith('image/'),
        localPreview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        uploading: true,
      });
    }
    if (!accepted.length) return;
    state.attachments.push(...accepted);
    controller.chat?.renderAttachments();
  },

  onRemoveAttachment(item) {
    state.attachments = state.attachments.filter((a) => a !== item);
    if (item.localPreview) URL.revokeObjectURL(item.localPreview);
    controller.chat?.renderAttachments();
  },

  onSettings() {
    settingsModal({
      me: state.me,
      onSaved: async () => {
        const { user } = await api.me();
        state.me = user;
        renderMe();
        renderAll();
      },
      onLogout: () => logout(),
    });
  },

  onLogout: () => logout(),
};

/* --------------------------- Вспомогательные ------------------------------- */

async function acceptRequest(request) {
  try {
    const { conversation } = await api.acceptRequest(request.id);
    if (conversation) upsertConversation(conversation);
    await refreshSocial();
    toast('Дружба установлена', request.user.displayName, 'success');
  } catch (err) {
    toastError(err);
  }
}

async function declineRequest(request) {
  try {
    await api.declineRequest(request.id);
    await refreshSocial();
  } catch (err) {
    toastError(err);
  }
}

async function refreshSocial() {
  const [friends, incoming, outgoing, blocked] = await Promise.all([
    api.friends(), api.requests('incoming'), api.requests('outgoing'), api.blocked(),
  ]);
  state.friends = friends.friends;
  state.requests = { incoming: incoming.requests, outgoing: outgoing.requests };
  state.blocked = blocked.blocked;
  for (const friend of state.friends) state.users.set(friend.id, friend);
  renderAll();
}

/** Результаты поиска внутри чата рисуем прямо в ленте. */
function renderChatSearchResults(conv, hits, query) {
  const messagesEl = document.getElementById('messages');
  clear(messagesEl);
  if (!hits.length) {
    messagesEl.appendChild(h('div', { class: 'empty' }, [
      h('strong', { text: 'В этом чате ничего не найдено' }),
      h('span', { text: `По запросу «${query}» совпадений нет` }),
    ]));
    return;
  }
  messagesEl.appendChild(h('div', { class: 'day-sep' }, [h('span', { text: `Найдено: ${hits.length}` })]));
  for (const hit of hits) {
    const message = hit.message;
    const node = h('div', { class: 'msg', style: { cursor: 'pointer' }, onClick: () => {
      state.chatQuery = '';
      state.chatSearchResults = null;
      document.getElementById('chat-searchbar').hidden = true;
      document.getElementById('chat-search-input').value = '';
      jumpToMessage(conv.id, message.id);
    } }, [
      h('div', { class: 'msg__avatar' }, [avatar(message.sender, {})]),
      h('div', { class: 'msg__col' }, [
        h('div', { class: 'bubble' }, [
          h('div', { class: 'bubble__head' }, [
            h('span', { class: 'bubble__author', text: message.sender?.displayName || '' }),
            h('span', { class: 'bubble__time', text: new Date(message.createdAt).toLocaleString('ru-RU') }),
          ]),
          h('div', { class: 'bubble__text' }, [(message.matches || []).some((p) => p.hit)
            ? message.matches.map((part) => (part.hit ? h('mark', { text: part.text }) : document.createTextNode(part.text)))
            : message.body]),
        ]),
      ]),
    ]);
    messagesEl.appendChild(node);
  }
}

/* ============================== Жизненный цикл ============================= */

async function startSession(token) {
  session.token = token;
  controller.rt = new Realtime({
    getToken: () => session.token,
    onEvent: handleEvent,
    onStateChange: (connection) => {
      state.connection = connection;
      renderConnection();
    },
  });

  // Сначала HTTP-снимок (быстрая отрисовка), затем сокет дополнит его
  try {
    const data = await api.bootstrap();
    applyBootstrap(data);
    renderAll();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      await logout(true);
      return;
    }
    toastError(err);
  }

  controller.rt.connect();
}

async function logout(silent = false) {
  try {
    if (!silent) await api.logout();
  } catch {
    /* выход важнее ошибки */
  }
  controller.rt?.disconnect();
  controller.rt = null;
  session.clear();
  resetChatState();
  document.getElementById('app').classList.add('hidden');
  document.getElementById('app').classList.remove('chat-open', 'info-open');
  controller.auth?.show();
}

function bindGlobalUi() {
  $('#btn-new-group').addEventListener('click', () => actions.onNewGroup());
  $('#btn-settings').addEventListener('click', () => actions.onSettings());
  $('#btn-logout').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Выйти из mmsgs?',
      text: 'Придётся снова ввести логин и пароль.',
      confirmLabel: 'Выйти',
      danger: false,
    });
    if (ok) logout();
  });
  $('#me-avatar').addEventListener('click', () => actions.onSettings());

  document.addEventListener('keydown', (evt) => {
    const typingInInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 'k') {
      evt.preventDefault();
      controller.sidebar?.focusSearch();
    }
    if (evt.key === 'Escape' && !typingInInput && state.activeConversationId && window.innerWidth <= 760) {
      actions.onBack();
    }
  });

  // Вкладка стала видимой — перечитаем активный чат
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    const conv = activeConversation();
    if (conv) markConversationRead(conv);
  });

  window.addEventListener('mmsgs:unauthorized', () => logout(true));

  // Периодически чистим устаревшие индикаторы «печатает»
  const typingTicker = setInterval(() => {
    let changed = false;
    for (const [conversationId] of state.typing) {
      const before = typingIn(conversationId).length;
      typingIn(conversationId);
      if (before !== typingIn(conversationId).length) changed = true;
    }
    if (changed) {
      controller.chat?.renderTyping();
      if (activeConversation()) controller.chat?.renderHeader(activeConversation());
    }
  }, 1500);
  // В Node (тесты интерфейса) таймер не должен удерживать процесс
  if (typeof typingTicker === 'object' && typeof typingTicker.unref === 'function') typingTicker.unref();
}

async function boot() {
  controller.auth = initAuth({
    onSuccess: async ({ token }) => {
      document.getElementById('app').classList.remove('hidden');
      await startSession(token);
    },
  });

  controller.sidebar = createSidebar(actions);
  controller.chat = createChat(actions);
  controller.info = createInfoPanel(actions);

  bindGlobalUi();

  if (session.token) {
    document.getElementById('app').classList.remove('hidden');
    await startSession(session.token);
  } else {
    controller.auth.show();
  }
}

boot().catch((err) => {
  console.error('[mmsgs] boot failed', err);
  toastError(err);
});
