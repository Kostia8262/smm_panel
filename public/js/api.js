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
  myToken: () => request('/api/me/token'),
  reissueMyToken: () => request('/api/me/token', { method: 'POST' }),

  staff: () => request('/api/staff'),
  createStaff: (body) => request('/api/staff', { method: 'POST', body }),
  updateStaff: (id, body) => request(`/api/staff/${id}`, { method: 'PUT', body }),
  reissueStaffToken: (id) => request(`/api/staff/${id}/token`, { method: 'POST' }),
  deleteStaff: (id) => request(`/api/staff/${id}`, { method: 'DELETE' }),

  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  plan: (status) => request(`/api/plan${status ? `?status=${status}` : ''}`),
  createPlan: (body) => request('/api/plan', { method: 'POST', body }),
  updatePlan: (id, body) => request(`/api/plan/${id}`, { method: 'PUT', body }),
  approvePlan: (id) => request(`/api/plan/${id}/approve`, { method: 'POST' }),
  planToPost: (id) => request(`/api/plan/${id}/to-post`, { method: 'POST' }),
  deletePlan: (id) => request(`/api/plan/${id}`, { method: 'DELETE' }),

  trends: () => request('/api/trends'),
  addTrend: (body) => request('/api/trends', { method: 'POST', body }),
  archiveTrend: (id, archived) => request(`/api/trends/${id}/archive`, { method: 'POST', body: { archived } }),
  deleteTrend: (id) => request(`/api/trends/${id}`, { method: 'DELETE' }),

  approve: (id) => request(`/api/posts/${id}/approve`, { method: 'POST' }),
  reject: (id, note) => request(`/api/posts/${id}/reject`, { method: 'POST', body: { note } }),

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
