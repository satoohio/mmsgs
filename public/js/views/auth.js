import { api, session } from '../api.js';
import { $, h, clear } from '../ui.js';

/**
 * Экран входа/регистрации. Держит свою локальную вкладку и валидацию,
 * наружу отдаёт только успешную авторизацию.
 */
export function initAuth({ onSuccess }) {
  const screen = $('#auth-screen');
  const form = $('#auth-form');
  const errorBox = $('#auth-error');
  const submit = $('#auth-submit');
  const tabs = [...document.querySelectorAll('.auth__tab')];
  let mode = 'login';

  function setMode(next) {
    mode = next;
    for (const tab of tabs) {
      const active = tab.dataset.tab === mode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    document.querySelector('[data-only="register"]').classList.toggle('hidden', mode !== 'register');
    submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    form.querySelector('[name="password"]').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    showError(null);
  }

  function showError(message, details) {
    if (!message) {
      errorBox.hidden = true;
      clear(errorBox);
      return;
    }
    clear(errorBox);
    errorBox.appendChild(document.createTextNode(message));
    if (Array.isArray(details) && details.length) {
      errorBox.appendChild(h('ul', {}, details.map((d) => h('li', { text: d }))));
    }
    errorBox.hidden = false;
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.tab)));

  document.querySelectorAll('[data-demo]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const [username, password] = chip.dataset.demo.split(':');
      setMode('login');
      form.querySelector('[name="username"]').value = username;
      form.querySelector('[name="password"]').value = password;
      showError(null);
      form.querySelector('[name="password"]').focus();
    });
  });

  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    showError(null);

    const data = new FormData(form);
    const username = String(data.get('username') || '').trim();
    const password = String(data.get('password') || '');
    const displayName = String(data.get('displayName') || '').trim();

    if (!username || !password) {
      showError('Заполните логин и пароль');
      return;
    }
    if (mode === 'register' && password.length < 6) {
      showError('Пароль должен быть не короче 6 символов');
      return;
    }

    submit.disabled = true;
    submit.textContent = mode === 'login' ? 'Входим…' : 'Создаём…';
    try {
      const result = mode === 'login'
        ? await api.login({ username, password })
        : await api.register({ username, password, displayName: displayName || username });
      session.token = result.token;
      session.cachedUser = result.user;
      screen.classList.add('hidden');
      await onSuccess(result);
    } catch (err) {
      showError(err.message || 'Не удалось выполнить вход', err.details);
    } finally {
      submit.disabled = false;
      submit.textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
    }
  });

  setMode('login');

  return {
    show() {
      screen.classList.remove('hidden');
      form.reset();
      showError(null);
      setTimeout(() => form.querySelector('[name="username"]')?.focus(), 60);
    },
    hide() {
      screen.classList.add('hidden');
    },
  };
}
