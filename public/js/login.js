/**
 * Вход в панель.
 *
 * Жил встроенным в login.html, вынесен ради строгой политики безопасности:
 * пока на странице есть <script> с кодом внутри, CSP приходится разрешать
 * inline-скрипты — а это ровно та лазейка, от которой политика и защищает.
 */
const form = document.getElementById('form');
const submit = document.getElementById('submit');
const errorBox = document.getElementById('error');
const errorText = document.getElementById('error-text');

const nextUrl = new URLSearchParams(location.search).get('next') || '/';

function showError(message) {
  errorText.textContent = message;
  errorBox.hidden = false;
}

// Токен можно передать ссылкой: владелец отправляет её сотруднику, тот
// переходит и сразу внутри. Из адреса токен убираем, чтобы он не осел
// в истории браузера и в журнале прокси.
const fromLink = new URLSearchParams(location.search).get('token');
if (fromLink) {
  history.replaceState(null, '', location.pathname);
  enter(fromLink);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  enter(form.token.value.trim());
});

async function enter(token) {
  errorBox.hidden = true;
  if (!token) {
    showError('Введите токен');
    return;
  }
  submit.disabled = true;
  submit.textContent = 'Проверяю…';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Не удалось войти');
      form.token.value = '';
      form.token.focus();
      return;
    }
    // Открытый редирект недопустим: возвращаемся только внутрь панели.
    location.href = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : '/';
  } catch {
    showError('Сервер не отвечает. Проверьте связь и повторите');
  } finally {
    submit.disabled = false;
    submit.textContent = 'Войти';
  }
}
