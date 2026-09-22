import { state, activeConversation, isOnline, lastSeen } from '../store.js';
import { h, clear, avatar, $, formatLastSeen, plural } from '../ui.js';

/** Правая панель: сведения о чате, участники и действия над ними. */
export function createInfoPanel(actions) {
  const panel = $('#info-panel');

  function render() {
    const conv = activeConversation();
    clear(panel);
    if (!conv || !state.infoOpen) {
      panel.hidden = true;
      document.getElementById('app').classList.remove('info-open');
      return;
    }
    panel.hidden = false;
    document.getElementById('app').classList.add('info-open');

    panel.appendChild(h('div', { class: 'info__head' }, [
      avatar(conv.type === 'group' ? { title: conv.title, avatarColor: conv.avatarColor } : conv.peer, {
        size: 'lg', group: conv.type === 'group',
        presence: conv.type === 'direct' ? isOnline(conv.peer?.id) : null,
      }),
      h('div', { class: 'info__title', text: conv.title }),
      h('div', {
        class: 'info__sub',
        text: conv.type === 'group'
          ? `${conv.members.length} ${plural(conv.members.length, ['участник', 'участника', 'участников'])}`
          : (isOnline(conv.peer?.id) ? 'в сети' : formatLastSeen(lastSeen(conv.peer?.id))),
      }),
      conv.type === 'direct'
        ? h('div', { class: 'info__sub', text: `@${conv.peer?.username || ''}` })
        : conv.topic ? h('div', { class: 'info__sub', text: conv.topic }) : null,
    ]));

    if (conv.type === 'group') {
      const owner = conv.members.find((m) => m.role === 'owner');
      const canManage = owner?.id === state.me?.id;

      panel.appendChild(h('div', { class: 'info__section' }, [
        h('div', { class: 'info__section-head' }, [
          h('span', { text: 'Участники' }),
          canManage
            ? h('button', { class: 'btn btn--sm btn--ghost', text: '+ Добавить', onClick: () => actions.onAddMembers(conv) })
            : h('button', { class: 'btn btn--sm btn--ghost', text: '+ Пригласить друга', onClick: () => actions.onAddMembers(conv) }),
        ]),
        ...conv.members
          .slice()
          .sort((a, b) => Number(b.id === state.me?.id) - Number(a.id === state.me?.id) || a.displayName.localeCompare(b.displayName, 'ru'))
          .map((member) => h('div', { class: 'info__row' }, [
            h('button', {
              style: { padding: '0', background: 'none' },
              onClick: () => actions.onOpenUser(member.id),
            }, [avatar(member, { size: 'sm', presence: isOnline(member.id) })]),
            h('div', { class: 'info__row-main', style: { cursor: 'pointer' }, onClick: () => actions.onOpenUser(member.id) }, [
              h('div', { class: 'info__row-name', text: member.id === state.me?.id ? `${member.displayName} (вы)` : member.displayName }),
              h('div', {
                class: 'info__row-sub',
                text: isOnline(member.id)
                  ? 'в сети'
                  : `${member.role === 'owner' ? 'владелец · ' : ''}${formatLastSeen(lastSeen(member.id))}`,
                style: isOnline(member.id) ? { color: 'var(--green)' } : undefined,
              }),
            ]),
            member.role === 'owner'
              ? h('span', { class: 'tag', text: 'владелец' })
              : canManage && member.id !== state.me?.id
                ? h('button', {
                  class: 'icon-btn icon-btn--sm', title: 'Исключить', text: '✕',
                  onClick: () => actions.onRemoveMember(conv, member),
                })
                : null,
          ])),
      ]));

      const management = [];
      if (canManage) {
        management.push(h('button', { class: 'btn btn--ghost', text: 'Переименовать группу', onClick: () => actions.onRename(conv) }));
        management.push(h('button', { class: 'btn btn--ghost', text: 'Изменить описание', onClick: () => actions.onSetTopic(conv) }));
      }
      management.push(h('button', { class: 'btn btn--danger', text: 'Покинуть группу', onClick: () => actions.onLeave(conv) }));
      panel.appendChild(h('div', { class: 'info__actions' }, management));
    } else {
      const peer = conv.peer;
      panel.appendChild(h('div', { class: 'info__section' }, [
        h('div', { class: 'info__section-head' }, [h('span', { text: 'О собеседнике' })]),
        h('div', { class: 'info__row' }, [
          h('div', { class: 'info__row-main' }, [
            h('div', { class: 'info__row-name', text: peer?.bio || 'Описание не заполнено' }),
            h('div', { class: 'info__row-sub', text: `В mmsgs с ${new Date(peer?.createdAt || Date.now()).getFullYear()} года` }),
          ]),
        ]),
      ]));

      const isFriend = state.friends.some((f) => f.id === peer?.id);
      const isBlocked = state.blocked.some((b) => b.id === peer?.id);
      panel.appendChild(h('div', { class: 'info__actions' }, [
        h('button', { class: 'btn btn--ghost', text: 'Показать профиль', onClick: () => actions.onOpenUser(peer?.id) }),
        isFriend
          ? h('button', { class: 'btn btn--ghost', text: 'Удалить из друзей', onClick: () => actions.onRemoveFriend(peer) })
          : h('button', { class: 'btn btn--ghost', text: 'Добавить в друзья', onClick: () => actions.onAddFriend(peer) }),
        isBlocked
          ? h('button', { class: 'btn btn--ghost', text: 'Разблокировать', onClick: () => actions.onUnblock(peer) })
          : h('button', { class: 'btn btn--danger', text: 'Заблокировать', onClick: () => actions.onBlock(peer) }),
      ]));
    }
  }

  return { render, panel };
}
