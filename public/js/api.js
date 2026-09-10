/**
 * Обёртка над API. Одна на всё приложение, чтобы истёкшая сессия и упавший
 * сервер обрабатывались одинаково везде, а не по-своему в каждом экране.
 */

class ApiError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

async function request(path, { method = 'GET', body, raw } = {}) {
  const init = { method, headers: {} };
  if (raw) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('Сервер не отвечает');
  }

  // Сессия кончилась — возвращаем на вход, запомнив, куда человек шёл.
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
    throw new ApiError('Не выполнен вход', { status: 401 });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Ошибка ${res.status}`, { status: res.status, data });
  return data;
}

export const api = {
  me: () => request('/api/me'),
  logout: () => request('/api/logout', { method: 'POST' }),
  changePassword: (current, next) => request('/api/password', { method: 'POST', body: { current, next } }),

  specs: () => request('/api/specs'),
  status: () => request('/api/status'),
  checkPlatform: (id) => request(`/api/platforms/${id}/check`, { method: 'POST' }),

  posts: (from, to) => request(`/api/posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  post: (id) => request(`/api/posts/${id}`),
  createPost: (body) => request('/api/posts', { method: 'POST', body }),
  updatePost: (id, body) => request(`/api/posts/${id}`, { method: 'PUT', body }),
  deletePost: (id) => request(`/api/posts/${id}`, { method: 'DELETE' }),
  schedule: (id) => request(`/api/posts/${id}/schedule`, { method: 'POST' }),
  unschedule: (id) => request(`/api/posts/${id}/unschedule`, { method: 'POST' }),
  publishNow: (id) => request(`/api/posts/${id}/publish-now`, { method: 'POST' }),

  uploadMedia: (postId, files) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    return request(`/api/posts/${postId}/media`, { method: 'POST', raw: form });
  },
  setFocus: (mediaId, x, y) =>
    request(`/api/media/${mediaId}/focus`, { method: 'PUT', body: { focus_x: x, focus_y: y } }),
  deleteMedia: (mediaId) => request(`/api/media/${mediaId}`, { method: 'DELETE' }),

  journal: (limit = 200) => request(`/api/log?limit=${limit}`),
};

export { ApiError };
