import { h, openModal, avatar, clear, toast, toastError, debounce, formatLastSeen } from '../ui.js';
import { isOnline, lastSeen } from '../store.js';
import { api } from '../api.js';

const PALETTE = [
  '#6c8cff', '#ff7ab6', '#4fd1c5', '#f6ad55', '#a78bfa',
  '#f56565', '#48bb78', '#38bdf8', '#facc15', '#fb7185',
];

/** Универсальный список с галочками: выбор людей из предложенных. */
function memberPicker({ candidates, selectedIds, emptyText }) {
  const selected = new Set(selectedIds.map(Number));
  const list = h('div', { class: 'picker__list' });

  function render(items) {
    clear(list);
    if (!items.length) {
      list.appendChild(h('div', { class: 'picker__empty', text: emptyText }));
      return;
    }
    for (const user of items) {
      const isSelected = selected.has(user.id);
      list.appendChild(h('button', {
        class: `picker__item${isSelected ? ' is-selected' : ''}`,
        type: 'button',
        onClick: () => {
          if (selected.has(user.id)) selected.delete(user.id);
          else selected.add(user.id);
          render(items);
        },
      }, [
        h('span', { class: 'picker__check', text: '✓' }),
        avatar(user, { size: 'sm', presence: isOnline(user.id) }),
        h('div', { style: { minWidth: '0' } }, [
          h('div', { class: 'picker__name', text: user.displayName }),
          h('div', { class: 'picker__nick', text: `@${user.username}` }),
        ]),
      ]));
    }
  }

  render(candidates);
  return { node: list, render, ids: () => [...selected] };
}

/* ------------------------------ Новая группа ------------------------------- */

export function newGroupModal({ friends, onCreate }) {
  const titleInput = h('input', { class: 'input', placeholder: 'Например: Проект «Восток»', maxlength: '60' });
  const picker = memberPicker({
    candidates: friends,
    selectedIds: [],
    emptyText: 'Сначала добавьте друзей — группу можно создать минимум с одним участником',
  });

  openModal({
    title: 'Новая группа',
    wide: true,
    body: [
      h('label', { class: 'field' }, [h('span', { class: 'field__label', text: 'Название' }), titleInput]),
      h('label', { class: 'field' }, [
        h('span', { class: 'field__label', text: 'Участники' }),
        picker.node,
      ]),
    ],
    actions: [
      { label: 'Отмена' },
      {
        label: 'Создать группу',
        kind: 'primary',
        closeOnClick: false,
        onClick: async () => {
          const title = titleInput.value.trim();
          if (title.length < 2) {
            toast('Название слишком короткое', 'Минимум 2 символа', 'warning');
            return false;
          }
          const ids = picker.ids();
          if (!ids.length) {
            toast('Выберите участников', 'В группе должно быть хотя бы два человека', 'warning');
            return false;
          }
          await onCreate({ title, memberIds: ids });
          return true;
        },
      },
    ],
  });
}

/* --------------------------- Добавление участников -------------------------- */

export function addMembersModal({ conversation, candidates, onConfirm }) {
  const picker = memberPicker({
    candidates,
    selectedIds: [],
    emptyText: candidates.length ? 'Никого не осталось' : 'Все ваши друзья уже в этом чате',
  });
  openModal({
    title: `Добавить в «${conversation.title}»`,
    body: [picker.node],
    actions: [
      { label: 'Отмена' },
      {
        label: 'Добавить',
        kind: 'primary',
        closeOnClick: false,
        onClick: async () => {
          const ids = picker.ids();
          if (!ids.length) {
            toast('Никого не выбрано', '', 'warning');
            return false;
          }
          await onConfirm(ids);
          return true;
        },
      },
    ],
  });
}

/* ------------------------------ Поиск людей -------------------------------- */

export function addFriendModal({ onAdded }) {
  const input = h('input', { class: 'input', placeholder: 'Логин или имя, например anna', autocomplete: 'off' });
  const results = h('div', { class: 'picker__list', style: { maxHeight: '320px' } });
  const hint = h('div', { class: 'picker__empty', text: 'Введите логин или имя — найдём людей и покажем, можно ли их добавить' });
  results.appendChild(hint);

  const runSearch = debounce(async (query) => {
    clear(results);
    if (!query) {
      results.appendChild(h('div', { class: 'picker__empty', text: 'Начните вводить запрос' }));
      return;
    }
    results.appendChild(h('div', { class: 'picker__empty' }, [h('div', { class: 'spinner' })]));
    try {
      const data = await api.searchUsers(query, 25);
      clear(results);
      if (!data.results.length) {
        results.appendChild(h('div', { class: 'picker__empty', text: 'Никого не нашли. Проверьте логин.' }));
        return;
      }
      for (const user of data.results) {
        const relation = user.relation;
        const label = {
          none: ['Добавить', 'btn--primary', () => sendRequest(user)],
          outgoing: ['Отозвать заявку', 'btn--ghost', () => cancelRequest(user)],
          incoming: ['Принять заявку', 'btn--primary', () => acceptFrom(user)],
          friends: ['Написать', 'btn--ghost', () => writeTo(user)],
          blocked: ['Разблокировать', 'btn--ghost', () => unblock(user)],
          blocked_by: ['Недоступно', 'btn--ghost', null],
          self: ['Это вы', 'btn--ghost', null],
        }[relation] || ['Добавить', 'btn--primary', () => sendRequest(user)];

        results.appendChild(h('div', { class: 'row', style: { gridTemplateColumns: 'auto minmax(0,1fr) auto' } }, [
          avatar(user, { presence: isOnline(user.id) }),
          h('div', { class: 'row__main' }, [
            h('div', { class: 'row__title' }, [h('span', { text: user.displayName })]),
            h('div', { class: 'row__snippet', text: user.bio || `@${user.username}` }),
          ]),
          h('div', { class: 'row__actions' }, [
            h('button', {
              class: `btn btn--sm ${label[1]}`,
              text: label[0],
              disabled: !label[2],
              onClick: label[2] ? () => label[2]() : undefined,
            }),
          ]),
        ]));
      }
    } catch (err) {
      clear(results);
      results.appendChild(h('div', { class: 'picker__empty', text: err.message }));
    }
  }, 280);

  async function sendRequest(user) {
    try {
      const { request } = await api.sendRequest({ username: user.username });
      if (request.status === 'accepted') {
        toast('Заявка принята', `${user.displayName} теперь у вас в друзьях`, 'success');
      } else {
        toast('Заявка отправлена', `${user.displayName} получит уведомление`, 'success');
      }
      await onAdded?.();
      runSearch(input.value.trim());
    } catch (err) {
      toastError(err);
    }
  }

  async function cancelRequest(user) {
    try {
      const incoming = await api.requests('outgoing');
      const found = incoming.requests.find((r) => r.user.id === user.id);
      if (found) await api.declineRequest(found.id);
      toast('Заявка отозвана', '', 'info');
      await onAdded?.();
      runSearch(input.value.trim());
    } catch (err) {
      toastError(err);
    }
  }

  async function acceptFrom(user) {
    try {
      const incoming = await api.requests('incoming');
      const found = incoming.requests.find((r) => r.user.id === user.id);
      if (found) await api.acceptRequest(found.id);
      toast('Дружба установлена', user.displayName, 'success');
      await onAdded?.();
      runSearch(input.value.trim());
    } catch (err) {
      toastError(err);
    }
  }

  async function writeTo(user) {
    try {
      const { conversation } = await api.openDirect(user.id);
      onAdded?.({ openConversationId: conversation.id });
      closeModalSafe();
    } catch (err) {
      toastError(err);
    }
  }

  async function unblock(user) {
    try {
      await api.unblock(user.id);
      toast('Разблокировано', user.displayName, 'success');
      await onAdded?.();
      runSearch(input.value.trim());
    } catch (err) {
      toastError(err);
    }
  }

  function closeModalSafe() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  }

  input.addEventListener('input', () => runSearch(input.value.trim()));

  openModal({
    title: 'Добавить друга',
    body: [
      h('label', { class: 'field' }, [h('span', { class: 'field__label', text: 'Поиск по людям' }), input]),
      results,
    ],
    actions: [{ label: 'Закрыть' }],
  });
  setTimeout(() => input.focus(), 40);
}

/* ------------------------------ Профиль человека ---------------------------- */

export function userProfileModal({ user, relation, onMessage, onAddFriend, onRemoveFriend, onBlock, onUnblock }) {
  const isFriend = relation === 'friends';
  const isBlocked = relation === 'blocked';
  const actions = [
    { label: 'Написать', kind: 'primary', onClick: () => onMessage(user) },
  ];
  if (isFriend) actions.push({ label: 'Удалить из друзей', kind: 'danger', onClick: () => onRemoveFriend(user) });
  else if (relation === 'none' || relation === 'outgoing' || relation === 'incoming') {
    actions.push({ label: 'Добавить в друзья', onClick: () => onAddFriend(user) });
  }
  if (isBlocked) actions.push({ label: 'Разблокировать', onClick: () => onUnblock(user) });
  else actions.push({ label: 'Заблокировать', kind: 'danger', onClick: () => onBlock(user) });

  openModal({
    title: 'Профиль',
    body: [
      h('div', { style: { display: 'grid', justifyItems: 'center', gap: '9px', textAlign: 'center' } }, [
        avatar(user, { size: 'lg', presence: isOnline(user.id) }),
        h('div', { style: { fontSize: '18px', fontWeight: '640' }, text: user.displayName }),
        h('div', { style: { color: 'var(--text-dim)', fontSize: '13.5px' }, text: `@${user.username}` }),
        h('div', {
          style: { color: isOnline(user.id) ? 'var(--green)' : 'var(--text-mute)', fontSize: '13px' },
          text: isOnline(user.id) ? 'в сети' : formatLastSeen(lastSeen(user.id)),
        }),
        user.bio ? h('p', { style: { margin: '4px 0 0', color: 'var(--text-dim)', fontSize: '14px' }, text: user.bio }) : null,
      ]),
    ],
    actions,
  });
}

/* --------------------------------- Настройки -------------------------------- */

export function settingsModal({ me, onSaved, onLogout }) {
  const nameInput = h('input', { class: 'input', value: me.displayName, maxlength: '48' });
  const bioInput = h('textarea', { class: 'input', rows: '3', maxlength: '280', placeholder: 'Пара слов о себе' });
  bioInput.value = me.bio || '';

  let color = me.avatarColor;
  const colorRow = h('div', { class: 'color-row' });
  function renderColors() {
    clear(colorRow);
    for (const value of PALETTE) {
      colorRow.appendChild(h('button', {
        class: `color-dot${value === color ? ' is-selected' : ''}`,
        style: { background: value },
        title: value,
        type: 'button',
        onClick: () => { color = value; renderColors(); },
      }));
    }
  }
  renderColors();

  const currentPassword = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const newPassword = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });

  openModal({
    title: 'Настройки профиля',
    wide: true,
    body: [
      h('div', { style: { display: 'flex', gap: '14px', alignItems: 'center' } }, [
        avatar({ ...me, avatarColor: color }, { size: 'lg' }),
        h('div', { style: { minWidth: '0' } }, [
          h('div', { style: { fontWeight: '640' }, text: me.displayName }),
          h('div', { style: { color: 'var(--text-mute)', fontSize: '13px' }, text: `@${me.username} · логин изменить нельзя` }),
        ]),
      ]),
      h('label', { class: 'field' }, [h('span', { class: 'field__label', text: 'Отображаемое имя' }), nameInput]),
      h('label', { class: 'field' }, [h('span', { class: 'field__label', text: 'О себе' }), bioInput]),
      h('div', { class: 'field' }, [h('span', { class: 'field__label', text: 'Цвет аватара' }), colorRow]),
      h('div', { style: { borderTop: '1px solid var(--border-soft)', paddingTop: '12px', display: 'grid', gap: '10px' } }, [
        h('span', { class: 'field__label', text: 'Смена пароля' }),
        h('label', { class: 'field' }, [h('span', { class: 'field__label', text: 'Текущий пароль' }), currentPassword]),
        h('label', { class: 'field' }, [h('span', { class: 'field__label', text: 'Новый пароль' }), newPassword]),
      ]),
    ],
    actions: [
      { label: 'Выйти из аккаунта', kind: 'danger', onClick: onLogout },
      { label: 'Отмена' },
      {
        label: 'Сохранить',
        kind: 'primary',
        closeOnClick: false,
        onClick: async () => {
          const payload = {
            displayName: nameInput.value.trim(),
            bio: bioInput.value.trim(),
            avatarColor: color,
          };
          if (newPassword.value) {
            payload.currentPassword = currentPassword.value;
            payload.newPassword = newPassword.value;
          }
          await api.updateMe(payload);
          toast('Профиль обновлён', '', 'success');
          await onSaved?.();
          return true;
        },
      },
    ],
  });
}

/* --------------------------------- Лайтбокс -------------------------------- */

export function imageLightbox(attachment, token) {
  const root = document.getElementById('modal-root');
  clear(root);
  const url = `${attachment.url}${attachment.url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
  const img = h('img', {
    src: url,
    alt: attachment.filename,
    style: { maxWidth: '92vw', maxHeight: '86vh', borderRadius: '12px', boxShadow: 'var(--shadow)', display: 'block' },
  });
  const close = () => {
    root.hidden = true;
    clear(root);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (evt) => { if (evt.key === 'Escape') close(); };
  root.appendChild(h('div', {
    style: { display: 'grid', placeItems: 'center', gap: '12px', padding: '16px' },
    onClick: (evt) => { if (evt.target === root || evt.currentTarget.contains(img) === false) close(); },
  }, [
    img,
    h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, [
      h('a', { class: 'btn btn--ghost btn--sm', href: url, download: attachment.filename, text: 'Скачать' }),
      h('button', { class: 'btn btn--sm', text: 'Закрыть', onClick: close }),
    ]),
  ]));
  root.hidden = false;
  document.addEventListener('keydown', onKey);
}
