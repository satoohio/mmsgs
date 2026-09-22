import {
  state, activeConversation, messagesOf, isOnline, lastSeen, typingIn, userById,
} from '../store.js';
import {
  h, clear, avatar, $, formatTime, formatDay, dayKey, formatLastSeen, formatBytes,
  renderText, renderHighlighted, stickToBottom, plural,
} from '../ui.js';

const EMOJI = ['👍', '❤️', '😂', '🔥', '🎉', '😮', '😢', '🙏', '👌', '🤝', '😎', '🤔', '👀', '✅', '💯', '🚀'];
const REACTION_EMOJI = ['👍', '❤️', '😂', '🔥', '🎉', '😮'];

/**
 * Область чата: шапка, лента сообщений, индикатор печати, композер.
 *
 * Лента рисуется целиком при смене диалога, а новые сообщения дописываются
 * узлами — иначе скролл прыгает и теряется место чтения.
 */
export function createChat(actions) {
  const chatEl = $('#chat');
  const emptyEl = $('#chat-empty');
  const headerEl = $('#chat-header');
  const messagesEl = $('#messages');
  const composerEl = $('#composer');
  const inputEl = $('#composer-input');
  const sendBtn = $('#btn-send');
  const typingEl = $('#typing-indicator');
  const infoBtn = $('#btn-info');
  const searchBtn = $('#btn-search-in-chat');
  const searchBar = $('#chat-searchbar');
  const searchInput = $('#chat-search-input');
  const searchClose = $('#chat-search-close');
  const replyPreview = $('#reply-preview');
  const attachPreview = $('#attach-preview');
  const fileInput = $('#file-input');
  const emojiBtn = $('#btn-emoji');
  const emojiPicker = $('#emoji-picker');

  const nodes = new Map(); // messageId -> DOM-узел
  let renderedConversationId = null;
  let loadingOlder = false;
  let typingTimer = null;

  /* ------------------------------ Шапка чата ------------------------------- */

  function renderHeader(conv) {
    headerEl.hidden = false;
    emptyEl.classList.add('hidden');

    const avatarEl = $('#chat-avatar');
    clear(avatarEl);
    const fresh = avatar(conv.type === 'group'
      ? { title: conv.title, avatarColor: conv.avatarColor }
      : conv.peer, { group: conv.type === 'group' });
    avatarEl.className = fresh.className;
    avatarEl.style.background = fresh.style.background;
    avatarEl.textContent = fresh.textContent;
    if (conv.type === 'direct') {
      avatarEl.appendChild(h('span', { class: `avatar__presence${isOnline(conv.peer?.id) ? ' is-online' : ''}` }));
    }

    $('#chat-title').textContent = conv.title;

    const subtitle = $('#chat-subtitle');
    const typers = typingIn(conv.id).filter((id) => id !== state.me?.id);
    if (typers.length) {
      subtitle.textContent = conv.type === 'group'
        ? `${typers.map((id) => userById(id)?.displayName?.split(' ')[0] || 'кто-то').join(', ')} печатает…`
        : 'печатает…';
      subtitle.classList.add('is-online');
    } else if (conv.type === 'group') {
      const onlineCount = conv.members.filter((m) => isOnline(m.id)).length;
      subtitle.textContent = `${conv.members.length} ${plural(conv.members.length, ['участник', 'участника', 'участников'])}`
        + (onlineCount ? ` · ${onlineCount} в сети` : '');
      subtitle.classList.remove('is-online');
    } else if (conv.peer) {
      subtitle.textContent = isOnline(conv.peer.id) ? 'в сети' : formatLastSeen(lastSeen(conv.peer.id));
      subtitle.classList.toggle('is-online', isOnline(conv.peer.id));
    }
  }

  /* ------------------------------- Сообщения ------------------------------- */

  const TICK_SENT = 'M4 12l5 5L20 6';
  const TICK_READ = 'M1 12l5 5L18 5M9 14l2 2L23 4';

  function tickSvg(read) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `tick${read ? ' is-read' : ''}`);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', read ? TICK_READ : TICK_SENT);
    svg.appendChild(path);
    return svg;
  }

  function statusTicks(message) {
    if (message.status === 'pending') return h('span', { class: 'bubble__time', text: '…' });
    if (message.status === 'failed') {
      return h('span', { class: 'bubble__time', style: { color: 'var(--red)' }, text: 'не доставлено' });
    }
    const conv = activeConversation();
    const readByOther = Boolean(conv && conv.type === 'direct'
      && Number(conv.lastReadMessageId || 0) >= Number(message.id || 0));
    return h('span', { class: 'bubble__status' }, [tickSvg(readByOther)]);
  }

  function attachmentNode(attachment, token) {
    if (!attachment) return null;
    if (attachment.isImage) {
      const img = h('img', {
        src: token ? `${attachment.url}?token=${encodeURIComponent(token)}` : attachment.url,
        alt: attachment.filename,
        loading: 'lazy',
      });
      img.addEventListener('click', () => actions.onOpenAttachment?.(attachment));
      return h('div', { class: 'attach' }, [img]);
    }
    const link = h('a', {
      class: 'attach__file',
      href: token ? `${attachment.url}?token=${encodeURIComponent(token)}` : attachment.url,
      target: '_blank',
      rel: 'noopener',
      download: attachment.filename,
    }, [
      h('span', { class: 'attach__icon', text: '📎' }),
      h('span', {}, [
        h('span', { class: 'attach__name', text: attachment.filename }),
        h('span', { class: 'attach__size', text: formatBytes(attachment.size) }),
      ]),
    ]);
    return h('div', { class: 'attach' }, [link]);
  }

  function reactionsNode(message) {
    const entries = Object.entries(message.reactions || {});
    if (!entries.length) return null;
    return h('div', { class: 'reactions' }, entries.map(([emoji, users]) => h('button', {
      class: `reaction${users.includes(state.me?.id) ? ' is-mine' : ''}`,
      title: users.map((id) => userById(id)?.displayName || 'кто-то').join(', '),
      onClick: () => actions.onReact(message, emoji, users.includes(state.me?.id)),
    }, [
      h('span', { text: emoji }),
      h('span', { class: 'reaction__count', text: String(users.length) }),
    ])));
  }

  function quoteNode(message) {
    if (!message.replyTo) return null;
    const box = messagesOf(message.conversationId);
    const original = box.list.find((m) => m.id === Number(message.replyTo));
    return h('div', {
      class: 'quote',
      onClick: () => original && actions.onJumpToMessage?.(original.id),
    }, [
      h('span', { class: 'quote__name', text: original?.sender?.displayName || 'Ответ' }),
      h('span', { class: 'quote__text', text: original ? (original.deleted ? 'сообщение удалено' : original.body || '📎 вложение') : '…' }),
    ]);
  }

  function messageNode(message, { showAuthor, highlight = false } = {}) {
    const own = message.sender?.id === state.me?.id;
    const classes = ['msg'];
    if (own) classes.push('is-own');
    if (message.status === 'pending') classes.push('is-pending');
    if (message.status === 'failed') classes.push('is-failed');
    if (message.deleted) classes.push('is-deleted');
    if (highlight) classes.push('is-highlight');

    const textNode = message.deleted
      ? h('div', { class: 'bubble__text', text: 'Сообщение удалено' })
      : h('div', { class: 'bubble__text' }, [message.matches ? renderHighlighted(message.matches) : renderText(message.body)]);

    const bubble = h('div', { class: 'bubble' }, [
      showAuthor && !own
        ? h('div', { class: 'bubble__head' }, [
          h('span', {
            class: 'bubble__author',
            text: message.sender?.displayName || 'Неизвестный',
            style: { cursor: 'pointer' },
            onClick: () => message.sender && actions.onOpenUser?.(message.sender.id),
          }),
        ])
        : null,
      message.replyTo ? quoteNode(message) : null,
      message.attachment && !message.deleted ? attachmentNode(message.attachment, actions.token?.()) : null,
      textNode,
      h('div', { class: 'bubble__foot' }, [
        message.editedAt ? h('span', { class: 'bubble__edited', text: 'изменено' }) : null,
        h('span', { class: 'bubble__time', text: message.createdAt ? formatTime(message.createdAt) : '' }),
        own ? statusTicks(message) : null,
      ]),
      reactionsNode(message),
    ]);

    const tools = [];
    if (!message.deleted && message.id) {
      tools.push(h('button', {
        class: 'msg__tool', title: 'Отреагировать', text: '🙂',
        onClick: (evt) => openReactionPicker(evt.currentTarget, message),
      }));
      tools.push(h('button', { class: 'msg__tool', title: 'Ответить', text: '↩', onClick: () => actions.onReply(message) }));
      if (own) tools.push(h('button', { class: 'msg__tool', title: 'Изменить', text: '✎', onClick: () => actions.onEditRequest(message) }));
      tools.push(h('button', {
        class: 'msg__tool', title: 'Удалить', text: '🗑',
        onClick: () => actions.onDelete(message),
      }));
    }

    const node = h('div', { class: classes.join(' '), dataset: { id: String(message.id || message.clientId) } }, [
      own
        ? h('div', { class: 'msg__tools' }, tools)
        : showAuthor
          ? h('div', { class: 'msg__avatar' }, [
            h('button', { style: { padding: '0', background: 'none' }, onClick: () => actions.onOpenUser?.(message.sender?.id) }, [
              avatar(message.sender, { size: '' }),
            ]),
          ])
          : h('div', { class: 'msg__avatar-spacer' }),
      h('div', { class: 'msg__col' }, [bubble]),
      own ? null : h('div', { class: 'msg__tools' }, tools),
    ]);

    registerNode(message, node);
    return node;
  }

  /**
   * Узел регистрируем и по настоящему id, и по временному clientId: оптимистичный
   * пузырёк создаётся до ответа сервера, а потом заменяется, а не дублируется.
   */
  function registerNode(message, node) {
    if (message.id) nodes.set(`id:${message.id}`, node);
    if (message.clientId) nodes.set(`tmp:${message.clientId}`, node);
  }

  function nodeFor(message) {
    if (message.id) {
      const byId = nodes.get(`id:${message.id}`);
      if (byId) return byId;
    }
    if (message.clientId) return nodes.get(`tmp:${message.clientId}`) || null;
    return null;
  }

  function openReactionPicker(anchor, message) {
    const existing = document.getElementById('reaction-popover');
    existing?.remove();
    const popover = h('div', {
      id: 'reaction-popover',
      class: 'reactions',
      style: {
        position: 'absolute', zIndex: '50', background: 'var(--panel-2)',
        border: '1px solid var(--border)', borderRadius: '999px', padding: '4px 7px',
        boxShadow: 'var(--shadow-sm)', gap: '2px',
      },
    }, REACTION_EMOJI.map((emoji) => h('button', {
      class: 'msg__tool', text: emoji, style: { width: '30px', height: '30px', fontSize: '16px' },
      onClick: () => { popover.remove(); actions.onReact(message, emoji, false); },
    })));
    document.body.appendChild(popover);
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${rect.top + window.scrollY - 42}px`;
    popover.style.left = `${Math.min(rect.left + window.scrollX - 60, window.innerWidth - popover.offsetWidth - 12)}px`;
    setTimeout(() => {
      const close = (evt) => {
        if (!popover.contains(evt.target)) {
          popover.remove();
          document.removeEventListener('mousedown', close);
        }
      };
      document.addEventListener('mousedown', close);
    }, 0);
  }

  /** Лента целиком: группировка по дням и по автору подряд. */
  function renderMessages() {
    const conv = activeConversation();
    nodes.clear();
    clear(messagesEl);
    if (!conv) return;

    const box = messagesOf(conv.id);
    if (box.hasMore) {
      messagesEl.appendChild(h('button', {
        class: 'load-more', text: 'Загрузить более старые',
        onClick: () => actions.onLoadOlder(conv.id),
      }));
    }
    if (!box.list.length) {
      messagesEl.appendChild(h('div', { class: 'empty' }, [
        h('strong', { text: 'Сообщений пока нет' }),
        h('span', { text: conv.type === 'group' ? 'Напишите первое сообщение в группу' : 'Напишите первым — собеседник получит сообщение сразу' }),
      ]));
      return;
    }

    let lastDay = null;
    let lastAuthor = null;
    let lastTime = 0;
    for (const message of box.list) {
      const day = dayKey(message.createdAt);
      if (day !== lastDay) {
        messagesEl.appendChild(h('div', { class: 'day-sep' }, [h('span', { text: formatDay(message.createdAt) })]));
        lastDay = day;
        lastAuthor = null;
      }
      const showAuthor = conv.type === 'group'
        && (message.sender?.id !== lastAuthor || message.createdAt - lastTime > 5 * 60_000);
      messagesEl.appendChild(messageNode(message, { showAuthor }));
      lastAuthor = message.sender?.id;
      lastTime = message.createdAt;
    }
  }

  /* -------------------------------- Композер ------------------------------- */

  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 168)}px`;
    sendBtn.disabled = !inputEl.value.trim() && !state.attachments.length;
  }

  function renderReply() {
    if (!state.replyTo) {
      replyPreview.hidden = true;
      return;
    }
    replyPreview.hidden = false;
    $('#reply-name').textContent = state.replyTo.sender?.displayName || 'Ответ';
    $('#reply-text').textContent = state.replyTo.deleted ? 'сообщение удалено' : (state.replyTo.body || '📎 вложение');
  }

  function renderAttachments() {
    clear(attachPreview);
    attachPreview.hidden = state.attachments.length === 0;
    for (const item of state.attachments) {
      attachPreview.appendChild(h('div', { class: `attach-chip${item.uploading ? ' is-uploading' : ''}` }, [
        item.localPreview && item.isImage
          ? h('img', { src: item.localPreview, alt: '' })
          : h('span', { class: 'attach__icon', text: '📎' }),
        h('div', { style: { minWidth: '0' } }, [
          h('div', { class: 'attach-chip__name', text: item.filename }),
          h('div', { class: 'attach__size', text: item.uploading ? 'загрузка…' : formatBytes(item.size) }),
        ]),
        h('button', {
          class: 'attach-chip__remove', text: '×', title: 'Убрать',
          onClick: () => actions.onRemoveAttachment(item),
        }),
      ]));
    }
    autosize();
  }

  function renderEmojiPicker() {
    clear(emojiPicker);
    for (const emoji of EMOJI) {
      emojiPicker.appendChild(h('button', {
        text: emoji,
        onClick: () => {
          inputEl.value += emoji;
          emojiPicker.hidden = true;
          autosize();
          inputEl.focus();
        },
      }));
    }
  }

  function renderComposer(conv) {
    composerEl.hidden = !conv;
    inputEl.placeholder = state.editingMessageId ? 'Измените сообщение… (Esc — отмена)' : 'Сообщение…';
    renderReply();
    renderAttachments();
    autosize();
  }

  inputEl.addEventListener('input', () => {
    autosize();
    const conv = activeConversation();
    if (conv && inputEl.value.trim()) actions.onTyping(conv.id);
  });

  inputEl.addEventListener('keydown', (evt) => {
    if (evt.key === 'Enter' && !evt.shiftKey) {
      evt.preventDefault();
      submit();
      return;
    }
    if (evt.key === 'Escape') {
      if (state.editingMessageId) actions.onCancelEdit();
      if (state.replyTo) actions.onCancelReply();
      emojiPicker.hidden = true;
    }
  });

  sendBtn.addEventListener('click', submit);

  function submit() {
    const body = inputEl.value.trim();
    if (!body && !state.attachments.length) return;
    actions.onSend({ body, replyToId: state.replyTo?.id, attachments: [...state.attachments] });
    inputEl.value = '';
    autosize();
  }

  emojiBtn.addEventListener('click', (evt) => {
    evt.stopPropagation();
    emojiPicker.hidden = !emojiPicker.hidden;
    if (!emojiPicker.childElementCount) renderEmojiPicker();
  });
  document.addEventListener('click', (evt) => {
    if (!emojiPicker.hidden && !emojiPicker.contains(evt.target) && evt.target !== emojiBtn) emojiPicker.hidden = true;
  });

  $('#btn-attach').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) actions.onAttachFiles(files);
  });

  $('#reply-cancel').addEventListener('click', () => actions.onCancelReply());
  $('#btn-back').addEventListener('click', () => actions.onBack());
  infoBtn.addEventListener('click', () => actions.onToggleInfo());

  /* ---------------------------- Поиск внутри чата -------------------------- */

  searchBtn.addEventListener('click', () => {
    searchBar.hidden = !searchBar.hidden;
    if (!searchBar.hidden) searchInput.focus();
    else actions.onSearchInChat('');
  });
  searchInput.addEventListener('input', () => actions.onSearchInChat(searchInput.value.trim()));
  searchClose.addEventListener('click', () => {
    searchBar.hidden = true;
    searchInput.value = '';
    actions.onSearchInChat('');
  });

  /* --------------------------------- Скролл -------------------------------- */

  messagesEl.addEventListener('scroll', () => {
    if (loadingOlder) return;
    const conv = activeConversation();
    if (!conv) return;
    const box = messagesOf(conv.id);
    if (box.hasMore && messagesEl.scrollTop < 90) {
      loadingOlder = true;
      const prevHeight = messagesEl.scrollHeight;
      const prevTop = messagesEl.scrollTop;
      Promise.resolve(actions.onLoadOlder(conv.id)).finally(() => {
        requestAnimationFrame(() => {
          messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevHeight);
          loadingOlder = false;
        });
      });
    }
    if (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60) {
      actions.onViewedBottom?.(conv.id);
    }
  });

  // Drag-and-drop файлов прямо в ленту
  for (const eventName of ['dragover', 'dragenter']) {
    messagesEl.addEventListener(eventName, (evt) => {
      evt.preventDefault();
      messagesEl.style.outline = '2px dashed var(--accent)';
      messagesEl.style.outlineOffset = '-6px';
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    messagesEl.addEventListener(eventName, (evt) => {
      evt.preventDefault();
      messagesEl.style.outline = '';
      if (eventName === 'drop' && evt.dataTransfer?.files?.length) {
        actions.onAttachFiles([...evt.dataTransfer.files]);
      }
    });
  }

  // Вставка изображения из буфера обмена
  document.addEventListener('paste', (evt) => {
    if (document.getElementById('app').classList.contains('hidden')) return;
    const files = [...(evt.clipboardData?.files || [])];
    if (files.length) {
      evt.preventDefault();
      actions.onAttachFiles(files);
    }
  });

  /* ------------------------------ Публичное API ---------------------------- */

  function render() {
    const conv = activeConversation();
    if (!conv) {
      headerEl.hidden = true;
      composerEl.hidden = true;
      emptyEl.classList.remove('hidden');
      clear(messagesEl);
      nodes.clear();
      renderedConversationId = null;
      document.getElementById('app').classList.remove('chat-open');
      return;
    }
    document.getElementById('app').classList.add('chat-open');
    renderHeader(conv);
    if (renderedConversationId !== conv.id) {
      renderedConversationId = conv.id;
      renderMessages();
      stickToBottom(messagesEl, true);
      renderComposer(conv);
    } else {
      renderHeader(conv);
    }
    renderTyping();
  }

  function renderTyping() {
    const conv = activeConversation();
    const typers = conv ? typingIn(conv.id).filter((id) => id !== state.me?.id) : [];
    if (!typers.length) {
      typingEl.hidden = true;
      clear(typingEl);
      return;
    }
    typingEl.hidden = false;
    clear(typingEl);
    const names = typers.map((id) => userById(id)?.displayName?.split(' ')[0] || 'кто-то');
    typingEl.appendChild(h('span', { class: 'typing-dots' }, [h('i'), h('i'), h('i')]));
    typingEl.appendChild(h('span', { text: `${names.join(', ')} печатает…` }));
  }

  function appendMessage(message) {
    const conv = activeConversation();
    if (!conv || Number(conv.id) !== Number(message.conversationId)) return;
    const box = messagesOf(conv.id);
    const index = box.list.findIndex((m) => (m.id && m.id === message.id) || (m.clientId && m.clientId === message.clientId));
    if (index === -1) return;

    const prev = box.list[index - 1];
    const newDay = !prev || dayKey(prev.createdAt) !== dayKey(message.createdAt);
    const showAuthor = conv.type === 'group' && (!prev || prev.sender?.id !== message.sender?.id || message.createdAt - prev.createdAt > 5 * 60_000);

    // Удаляем все старые узлы, которые соответствуют этому сообщению (по id или по временному clientId),
    // чтобы оптимистичный пузырёк не дублировался после подтверждения сервера
    const toRemove = [];
    if (message.id) {
      const byId = nodes.get(`id:${message.id}`);
      if (byId) toRemove.push(byId);
    }
    if (message.clientId) {
      const byTmp = nodes.get(`tmp:${message.clientId}`);
      if (byTmp) toRemove.push(byTmp);
    }
    const seen = new Set();
    for (const n of toRemove) {
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (n.parentNode) n.remove();
    }

    const fresh = messageNode(message, { showAuthor });
    if (newDay && !messagesEl.querySelector(`[data-day=\"${dayKey(message.createdAt)}\"]`)) {
      // Простая эвристика: если день ещё не показан, добавим разделитель
      const lastSep = [...messagesEl.querySelectorAll('.day-sep')].at(-1);
      if (!lastSep || lastSep.textContent !== formatDay(message.createdAt)) {
        messagesEl.appendChild(h('div', { class: 'day-sep' }, [h('span', { text: formatDay(message.createdAt) })]));
      }
    }
    messagesEl.appendChild(fresh);
    stickToBottom(messagesEl, message.sender?.id === state.me?.id);
  }

  function refreshMessage(message) {
    const node = nodeFor(message);
    if (!node || !node.parentNode) return;
    const conv = activeConversation();
    const showAuthor = conv?.type === 'group';
    node.replaceWith(messageNode(message, { showAuthor }));
  }

  function removeMessageNode(messageId) {
    const node = nodes.get(`id:${Number(messageId)}`);
    if (node?.parentNode) {
      node.classList.add('is-deleted');
      const text = node.querySelector('.bubble__text');
      if (text) {
        clear(text);
        text.textContent = 'Сообщение удалено';
      }
      node.querySelector('.reactions')?.remove();
      node.querySelector('.attach')?.remove();
    }
  }

  function scrollToMessage(messageId) {
    const node = nodes.get(`id:${Number(messageId)}`);
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('is-highlight');
    setTimeout(() => node.classList.remove('is-highlight'), 1600);
  }

  function setEditing(message) {
    state.editingMessageId = message ? message.id : null;
    if (message) {
      inputEl.value = message.body;
      inputEl.focus();
      inputEl.setSelectionRange(message.body.length, message.body.length);
    } else {
      inputEl.value = '';
    }
    renderComposer(activeConversation());
  }

  function markReadTicks() {
    // Обновляем галочки «прочитано» у своих сообщений без полной перерисовки
    const conv = activeConversation();
    if (!conv) return;
    for (const message of messagesOf(conv.id).list) {
      if (message.sender?.id !== state.me?.id) continue;
      const node = nodes.get(`id:${message.id}`);
      const tick = node?.querySelector('.tick');
      if (!tick) continue;
      const read = Number(conv.lastReadMessageId || 0) >= Number(message.id);
      tick.classList.toggle('is-read', read);
      const path = tick.querySelector('path');
      if (path) path.setAttribute('d', read ? 'M1 12l5 5L18 5M9 14l2 2L23 4' : 'M4 12l5 5L20 6');
    }
  }

  return {
    render,
    renderHeader,
    renderMessages,
    renderTyping,
    appendMessage,
    refreshMessage,
    removeMessageNode,
    scrollToMessage,
    markReadTicks,
    setEditing,
    renderAttachments,
    renderReply,
    renderComposer,
    focusInput: () => inputEl.focus(),
    scheduleTypingRefresh() {
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => { renderTyping(); renderHeader(activeConversation()); }, 900);
    },
    scrollBottom: (force) => stickToBottom(messagesEl, force),
    get input() { return inputEl; },
  };
}
