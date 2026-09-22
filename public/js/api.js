/**
 * Тонкий REST-клиент: токен в localStorage, единая обработка ошибок.
 * 401 anywhere → событие mmsgs:unauthorized, приложение показывает вход.
 */

const TOKEN_KEY = 'mmsgs.token';
const USER_KEY = 'mmsgs.user';

export const session = {
  get token() {
    return localStorage.getItem(TOKEN_KEY);
  },
  set token(value) {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  },
  get cachedUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch {
      return null;
    }
  },
  set cachedUser(user) {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, url, { body, headers = {}, raw = false } = {}) {
  const opts = { method, headers: { ...headers } };
  const token = session.token;
  if (token) opts.headers.Authorization = `Bearer ${token}`;

  if (body !== undefined) {
    if (body instanceof Blob || body instanceof File) {
      opts.body = body;
      if (body.type) opts.headers['Content-Type'] = body.type;
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new ApiError(0, 'Нет связи с сервером');
  }

  if (res.status === 401 && !url.includes('/auth/login')) {
    window.dispatchEvent(new CustomEvent('mmsgs:unauthorized'));
  }

  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = raw ? await res.blob() : isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = (data && data.error) || `Ошибка ${res.status}`;
    throw new ApiError(res.status, message, data && data.details);
  }
  return data;
}

const qs = (params) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
};

export const api = {
  /* --- авторизация --- */
  register: (payload) => request('POST', '/api/auth/register', { body: payload }),
  login: (payload) => request('POST', '/api/auth/login', { body: payload }),
  logout: () => request('POST', '/api/auth/logout'),
  me: () => request('GET', '/api/auth/me'),
  updateMe: (payload) => request('PATCH', '/api/auth/me', { body: payload }),
  bootstrap: () => request('GET', '/api/bootstrap'),

  /* --- люди и друзья --- */
  searchUsers: (q, limit = 20) => request('GET', `/api/users/search${qs({ q, limit })}`),
  getUser: (id) => request('GET', `/api/users/${id}`),
  friends: () => request('GET', '/api/friends'),
  requests: (direction = 'incoming') => request('GET', `/api/friends/requests${qs({ direction })}`),
  sendRequest: (payload) => request('POST', '/api/friends/requests', { body: payload }),
  acceptRequest: (id) => request('POST', `/api/friends/requests/${id}/accept`),
  declineRequest: (id) => request('POST', `/api/friends/requests/${id}/decline`),
  removeFriend: (id) => request('DELETE', `/api/friends/${id}`),
  block: (id) => request('POST', `/api/users/${id}/block`),
  unblock: (id) => request('DELETE', `/api/users/${id}/block`),
  blocked: () => request('GET', '/api/blocks'),

  /* --- чаты --- */
  conversations: () => request('GET', '/api/conversations'),
  conversation: (id) => request('GET', `/api/conversations/${id}`),
  openDirect: (userId) => request('POST', '/api/conversations/direct', { body: { userId } }),
  createGroup: (title, memberIds) => request('POST', '/api/conversations/group', { body: { title, memberIds } }),
  updateConversation: (id, patch) => request('PATCH', `/api/conversations/${id}`, { body: patch }),
  addMembers: (id, memberIds) => request('POST', `/api/conversations/${id}/members`, { body: { memberIds } }),
  removeMember: (id, userId) => request('DELETE', `/api/conversations/${id}/members/${userId}`),
  markRead: (id, messageId) => request('POST', `/api/conversations/${id}/read`, { body: { messageId } }),

  /* --- сообщения --- */
  messages: (id, { before, limit = 50, after } = {}) =>
    request('GET', `/api/conversations/${id}/messages${qs({ before, limit, after })}`),
  send: (id, payload) => request('POST', `/api/conversations/${id}/messages`, { body: payload }),
  edit: (messageId, body) => request('PATCH', `/api/messages/${messageId}`, { body: { body } }),
  remove: (messageId) => request('DELETE', `/api/messages/${messageId}`),
  react: (messageId, emoji, remove = false) =>
    request('POST', `/api/messages/${messageId}/reactions`, { body: { emoji, remove } }),

  /* --- поиск --- */
  search: (q, conversationId) => request('GET', `/api/search${qs({ q, conversationId })}`),

  /* --- вложения --- */
  async upload(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const data = await request('POST', '/api/attachments', {
      body: buf,
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        // Имя файла может быть кириллическим — заголовок допускает только Latin-1
        'x-filename': encodeURIComponent(file.name),
      },
    });
    return data.attachment;
  },
};

export default api;
