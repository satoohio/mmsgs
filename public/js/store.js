/**
 * Централизованное состояние + мутации.
 * Представления подписываются на изменения и перерисовывают свои области;
 * сообщения при этом дописываются инкрементально, чтобы не сбивать скролл.
 */

const listeners = new Set();

export const state = {
  ready: false,
  me: null,
  connection: 'offline',

  friends: [],
  blocked: [],
  requests: { incoming: [], outgoing: [] },

  conversations: [],
  messages: new Map(), // conversationId -> { list, hasMore, loading }
  activeConversationId: null,

  presence: new Map(), // userId -> { online, lastSeenAt }
  users: new Map(),    // userId -> user (кэш профилей)
  typing: new Map(),   // conversationId -> Map<userId, expiresAt>

  pane: 'chats',
  query: '',
  searchResults: null,
  searchLoading: false,
  chatQuery: '',
  chatSearchResults: null,

  replyTo: null,
  editingMessageId: null,
  attachments: [], // { id, filename, mime, size, isImage, url, localPreview?, uploading? }
  infoOpen: false,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(scope = 'all') {
  for (const fn of listeners) fn(scope);
}

/* ------------------------------- Селекторы -------------------------------- */

export function getConversation(id) {
  if (id == null) return null;
  return state.conversations.find((c) => c.id === Number(id)) || null;
}

export function activeConversation() {
  return getConversation(state.activeConversationId);
}

export function messagesOf(id) {
  if (!state.messages.has(id)) state.messages.set(id, { list: [], hasMore: false, loading: false });
  return state.messages.get(id);
}

export function sortedConversations() {
  return [...state.conversations].sort((a, b) => {
    const at = a.lastMessageAt || a.createdAt || 0;
    const bt = b.lastMessageAt || b.createdAt || 0;
    return bt - at;
  });
}

export function unreadTotal() {
  return state.conversations.reduce((sum, c) => sum + (c.unread || 0), 0);
}

export function requestsTotal() {
  return state.requests.incoming.length + state.requests.outgoing.length;
}

export function userById(id) {
  const num = Number(id);
  for (const conv of state.conversations) {
    const found = (conv.members || []).find((m) => m.id === num);
    if (found) return found;
  }
  return state.users.get(num) || state.friends.find((f) => f.id === num) || null;
}

export function isOnline(userId) {
  const entry = state.presence.get(Number(userId));
  if (entry) return entry.online;
  const user = userById(userId);
  return Boolean(user?.online);
}

export function lastSeen(userId) {
  const entry = state.presence.get(Number(userId));
  const user = userById(userId);
  return entry?.lastSeenAt ?? user?.lastSeenAt ?? null;
}

/** Кто печатает в чате прямо сейчас (с учётом истечения). */
export function typingIn(conversationId) {
  const map = state.typing.get(conversationId);
  if (!map) return [];
  const now = Date.now();
  const active = [];
  for (const [userId, expiresAt] of map) {
    if (expiresAt > now) active.push(Number(userId));
    else map.delete(userId);
  }
  return active;
}

/* -------------------------------- Мутации --------------------------------- */

export function applyBootstrap(data) {
  state.me = data.me;
  state.friends = data.friends || [];
  state.blocked = data.blocked || [];
  state.requests = {
    incoming: data.incomingRequests || [],
    outgoing: data.outgoingRequests || [],
  };
  state.conversations = data.conversations || [];
  for (const conv of state.conversations) {
    for (const member of conv.members || []) state.users.set(member.id, member);
  }
  for (const friend of state.friends) state.users.set(friend.id, friend);
  for (const id of data.online || []) state.presence.set(Number(id), { online: true, lastSeenAt: Date.now() });
  state.ready = true;
}

export function upsertConversation(conv) {
  const index = state.conversations.findIndex((c) => c.id === conv.id);
  for (const member of conv.members || []) state.users.set(member.id, member);
  if (index === -1) state.conversations.unshift(conv);
  else state.conversations[index] = { ...state.conversations[index], ...conv };
}

export function patchConversation(id, patch) {
  const conv = getConversation(id);
  if (!conv) return null;
  Object.assign(conv, patch);
  return conv;
}

export function removeConversation(id) {
  state.conversations = state.conversations.filter((c) => c.id !== Number(id));
  state.messages.delete(Number(id));
  if (Number(state.activeConversationId) === Number(id)) state.activeConversationId = null;
}

export function setMessages(id, list, hasMore) {
  state.messages.set(Number(id), { list, hasMore, loading: false });
}

export function prependMessages(id, older) {
  const box = messagesOf(Number(id));
  const seen = new Set(box.list.map((m) => m.id));
  box.list = [...older.filter((m) => !seen.has(m.id)), ...box.list];
}

export function addMessage(message, { clientId } = {}) {
  const id = Number(message.conversationId);
  const box = messagesOf(id);
  // Оптимистичное сообщение уже в списке — заменяем его настоящим
  if (clientId) {
    const index = box.list.findIndex((m) => m.clientId === clientId);
    if (index !== -1) {
      box.list[index] = { ...message, status: 'sent' };
      return { message: box.list[index], replaced: true };
    }
  }
  if (box.list.some((m) => m.id === message.id)) return { message, replaced: true };
  box.list.push({ ...message, status: message.sender?.id === state.me?.id ? 'sent' : 'received' });
  return { message: box.list[box.list.length - 1], replaced: false };
}

export function addPendingMessage(tempMessage) {
  const box = messagesOf(Number(tempMessage.conversationId));
  box.list.push(tempMessage);
}

export function resolvePending(clientId, { messageId, error } = {}) {
  for (const box of state.messages.values()) {
    const index = box.list.findIndex((m) => m.clientId === clientId);
    if (index === -1) continue;
    if (error) {
      box.list[index] = { ...box.list[index], status: 'failed', error };
    } else if (messageId) {
      box.list[index] = { ...box.list[index], id: messageId, status: 'sent' };
    }
    return box.list[index];
  }
  return null;
}

export function replaceMessage(message) {
  const box = messagesOf(Number(message.conversationId));
  const index = box.list.findIndex((m) => m.id === message.id);
  if (index === -1) return null;
  box.list[index] = { ...box.list[index], ...message };
  return box.list[index];
}

export function markMessageDeleted(conversationId, messageId) {
  const box = messagesOf(Number(conversationId));
  const index = box.list.findIndex((m) => m.id === Number(messageId));
  if (index === -1) return null;
  box.list[index] = { ...box.list[index], deleted: true, body: '', reactions: {}, attachment: null };
  return box.list[index];
}

export function setPresence(userId, online, lastSeenAt) {
  state.presence.set(Number(userId), { online: Boolean(online), lastSeenAt: lastSeenAt || Date.now() });
  for (const conv of state.conversations) {
    for (const member of conv.members || []) {
      if (member.id === Number(userId)) member.online = Boolean(online);
    }
    if (conv.peer?.id === Number(userId)) conv.peer.online = Boolean(online);
  }
  const friend = state.friends.find((f) => f.id === Number(userId));
  if (friend) friend.online = Boolean(online);
  const cached = state.users.get(Number(userId));
  if (cached) cached.online = Boolean(online);
}

export function markTyping(conversationId, userId, ttl = 5000) {
  const id = Number(conversationId);
  if (!state.typing.has(id)) state.typing.set(id, new Map());
  state.typing.get(id).set(Number(userId), Date.now() + ttl);
}

export function clearTyping(conversationId, userId) {
  const map = state.typing.get(Number(conversationId));
  if (map) map.delete(Number(userId));
}

export function markRead(conversationId, messageId) {
  const conv = getConversation(conversationId);
  if (!conv) return;
  if (messageId && Number(messageId) > Number(conv.lastReadMessageId || 0)) {
    conv.lastReadMessageId = Number(messageId);
  }
  if (Number(conv.lastReadMessageId || 0) >= Number(messageId || 0)) conv.unread = 0;
}

export function bumpUnread(conversation, message) {
  if (Number(state.activeConversationId) === Number(conversation.id)) return;
  if (message.sender?.id === state.me?.id) return;
  conversation.unread = (conversation.unread || 0) + 1;
}

export function resetChatState() {
  state.conversations = [];
  state.messages = new Map();
  state.friends = [];
  state.blocked = [];
  state.requests = { incoming: [], outgoing: [] };
  state.presence = new Map();
  state.users = new Map();
  state.typing = new Map();
  state.activeConversationId = null;
  state.query = '';
  state.searchResults = null;
  state.chatQuery = '';
  state.chatSearchResults = null;
  state.replyTo = null;
  state.editingMessageId = null;
  state.attachments = [];
  state.infoOpen = false;
  state.ready = false;
  state.me = null;
}
