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

/**
 * Открытый проект. Панель почти всегда спрашивает данные «этого проекта»,
 * и таскать его через каждый вызов руками — верный способ однажды забыть
 * и показать посты академии в карточке «Дошколярика».
 */
let projectId = null;

export function setProject(id) {
  projectId = id || null;
}

export function getProject() {
  return projectId;
}

function withProject(path) {
  if (!projectId) return path;
  return path + (path.includes('?') ? '&' : '?') + `project=${projectId}`;
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

/**
 * Загрузка файлов с прогрессом.
 *
 * Через XHR, а не fetch: fetch до сих пор не сообщает, сколько отправлено.
 * Ролик на сотни мегабайт грузится минутами, и без полосы прогресса человек
 * решает, что панель зависла, и перезагружает страницу посреди загрузки.
 * Ответ разбирается так же, как в `request`: единые 401 и текст ошибки.
 */
function upload(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'json';
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      });
    }
    xhr.addEventListener('error', () => reject(new ApiError('Сервер не отвечает — загрузка прервалась')));
    xhr.addEventListener('abort', () => reject(new ApiError('Загрузка отменена')));
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
        reject(new ApiError('Не выполнен вход', { status: 401 }));
        return;
      }
      const data = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else if (xhr.status === 413 && !data.error) {
        // Прокси отбивает тело раньше сервера панели и отвечает своей страницей.
        reject(new ApiError('Файл слишком большой для загрузки', { status: 413, data }));
      } else reject(new ApiError(data.error || `Ошибка ${xhr.status}`, { status: xhr.status, data }));
    });
    xhr.send(form);
  });
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

  schedule: () => request(withProject('/api/schedule')),
  addSlot: (body) => request(withProject('/api/schedule/slots'), { method: 'POST', body }),
  removeSlot: (id) => request(withProject(`/api/schedule/slots/${id}`), { method: 'DELETE' }),
  createCategory: (body) => request(withProject('/api/categories'), { method: 'POST', body }),
  updateCategory: (id, body) => request(`/api/categories/${id}`, { method: 'PUT', body }),
  removeCategory: (id) => request(`/api/categories/${id}`, { method: 'DELETE' }),
  toSlot: (id) => request(`/api/posts/${id}/slot`, { method: 'POST' }),
  report: (id) => request(`/api/posts/${id}/report`),
  leadsSettings: () => request('/api/settings/leads'),
  saveLeadsSettings: (body) => request('/api/settings/leads', { method: 'PUT', body }),

  settings: () => request('/api/settings'),
  saveSettings: (body) => request('/api/settings', { method: 'PUT', body }),

  plan: (status, scope) =>
    scope === 'all'
      ? request(`/api/plan?project=all${status ? `&status=${status}` : ''}`)
      : request(withProject(`/api/plan${status ? `?status=${status}` : ''}`)),
  createPlan: (body) => request(withProject('/api/plan'), { method: 'POST', body }),
  updatePlan: (id, body) => request(`/api/plan/${id}`, { method: 'PUT', body }),
  approvePlan: (id) => request(`/api/plan/${id}/approve`, { method: 'POST' }),
  planToPost: (id) => request(`/api/plan/${id}/to-post`, { method: 'POST' }),
  deletePlan: (id) => request(`/api/plan/${id}`, { method: 'DELETE' }),

  trends: (scope) =>
    scope === 'all' ? request('/api/trends?project=all') : request(withProject('/api/trends')),
  addTrend: (body) => request(withProject('/api/trends'), { method: 'POST', body }),
  keywords: () => request(withProject('/api/trends/keywords')),
  addKeyword: (phrase) => request(withProject('/api/trends/keywords'), { method: 'POST', body: { phrase } }),
  removeKeyword: (id) => request(withProject(`/api/trends/keywords/${id}`), { method: 'DELETE' }),
  collectTrends: () => request(withProject('/api/trends/collect'), { method: 'POST' }),
  digest: (days) => request(withProject(`/api/observed/digest?days=${days || 7}`)),
  ingestKey: () => request('/api/ingest/key'),
  newIngestKey: () => request('/api/ingest/key', { method: 'POST' }),
  archiveTrend: (id, archived) => request(`/api/trends/${id}/archive`, { method: 'POST', body: { archived } }),
  deleteTrend: (id) => request(`/api/trends/${id}`, { method: 'DELETE' }),

  approve: (id) => request(`/api/posts/${id}/approve`, { method: 'POST' }),
  reject: (id, note) => request(`/api/posts/${id}/reject`, { method: 'POST', body: { note } }),

  specs: () => request('/api/specs'),
  status: () => request(withProject('/api/status')),

  projects: () => request('/api/projects'),
  createProject: (body) => request('/api/projects', { method: 'POST', body }),
  updateProject: (id, body) => request(`/api/projects/${id}`, { method: 'PUT', body }),
  projectAccounts: (id) => request(`/api/projects/${id}/accounts`),
  saveAccount: (id, platform, body) =>
    request(`/api/projects/${id}/accounts/${platform}`, { method: 'PUT', body }),
  clearAccount: (id, platform) =>
    request(`/api/projects/${id}/accounts/${platform}`, { method: 'DELETE' }),
  checkAccount: (id, platform) =>
    request(`/api/projects/${id}/accounts/${platform}/check`, { method: 'POST' }),
  startThreadsOauth: (id) => request(`/api/projects/${id}/oauth/threads/start`, { method: 'POST' }),
  startFacebookOauth: (id) => request(`/api/projects/${id}/oauth/facebook/start`, { method: 'POST' }),
  facebookPending: (id, pid) => request(`/api/projects/${id}/oauth/facebook/pending/${pid}`),
  applyFacebookPending: (id, pid, body) =>
    request(`/api/projects/${id}/oauth/facebook/pending/${pid}/apply`, { method: 'POST', body }),
  cancelFacebookPending: (id, pid) => request(`/api/projects/${id}/oauth/facebook/pending/${pid}`, { method: 'DELETE' }),

  // Сроки жизни токенов: их пишет сторож в воркере, панель только читает.
  tokens: (id) => request(`/api/tokens?project=${id}`),
  tokenAlerts: () => request('/api/tokens/alerts'),
  checkTokens: () => request('/api/tokens/check', { method: 'POST' }),
  renewToken: (id, platform) => request(`/api/tokens/${platform}/renew?project=${id}`, { method: 'POST' }),

  posts: (from, to) =>
    request(withProject(`/api/posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)),
  post: (id) => request(`/api/posts/${id}`),
  createPost: (body) => request(withProject('/api/posts'), { method: 'POST', body }),
  updatePost: (id, body) => request(`/api/posts/${id}`, { method: 'PUT', body }),
  deletePost: (id) => request(`/api/posts/${id}`, { method: 'DELETE' }),
  // Не `schedule`: это имя занято сеткой расписания ниже, и дубль ключа
  // в объекте молча затирал один метод другим.
  enqueue: (id) => request(`/api/posts/${id}/schedule`, { method: 'POST' }),
  unschedule: (id) => request(`/api/posts/${id}/unschedule`, { method: 'POST' }),
  publishNow: (id) => request(`/api/posts/${id}/publish-now`, { method: 'POST' }),

  /**
   * @param {File[]} files
   * @param {Array<Blob|null>} [thumbs] — миниатюры по тем же номерам, что файлы;
   *   null там, где браузер сделать её не сумел
   * @param {(sent: number, total: number) => void} [onProgress]
   */
  uploadMedia: (postId, files, thumbs = [], onProgress = null) => {
    const form = new FormData();
    for (const f of files) form.append('files', f);
    // Номер в имени, а не порядок полей: пропуск одной миниатюры не должен
    // сдвинуть остальные на чужие файлы.
    thumbs.forEach((blob, i) => {
      if (blob) form.append('thumbs', blob, `thumb-${i}.jpg`);
    });
    return upload(`/api/posts/${postId}/media`, form, onProgress);
  },
  reorderMedia: (postId, ids) => request(`/api/posts/${postId}/media/order`, { method: 'PUT', body: { ids } }),
  setFocus: (mediaId, x, y) =>
    request(`/api/media/${mediaId}/focus`, { method: 'PUT', body: { focus_x: x, focus_y: y } }),
  deleteMedia: (mediaId) => request(`/api/media/${mediaId}`, { method: 'DELETE' }),

  /** @param {{kind?: string, problems?: boolean, platform?: string, q?: string, before?: number}} filters */
  journal: (filters = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value === true) qs.set(key, '1');
      else if (value) qs.set(key, String(value));
    }
    // Не `qs.size`: его нет в Safari до 17, и фильтр там молча отбрасывался бы.
    const query = qs.toString();
    return request(`/api/log${query ? `?${query}` : ''}`);
  },
};

export { ApiError };
