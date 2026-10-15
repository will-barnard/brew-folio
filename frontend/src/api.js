// Thin fetch wrapper. Every state-changing call sends X-Folio: 1 (the
// backend's CSRF check). A 401 bounces to sign-in.
import router from './router';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

async function request(method, path, { body, raw, headers = {}, signal } = {}) {
  const opts = { method, credentials: 'same-origin', headers: { ...headers }, signal };
  if (method !== 'GET') opts.headers['X-Folio'] = '1';
  if (raw) {
    opts.body = raw;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: 'Can’t reach folio — check your connection' });
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/') && router.currentRoute.value.name !== 'login') {
      router.replace({ name: 'login', query: { next: router.currentRoute.value.fullPath } });
    }
    throw new ApiError(res.status, data);
  }
  return data;
}

export const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { ...o, body }),
  patch: (p, body, o) => request('PATCH', p, { ...o, body }),
  put: (p, body, o) => request('PUT', p, { ...o, body }),
  del: (p, o) => request('DELETE', p, o),
  // Files go up as the raw request body — no multipart.
  upload: (p, file) => request('POST', p, {
    raw: file,
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
  }),
  // Authenticated file fetch → object URL (receipts, statements).
  async blobUrl(p) {
    const res = await fetch(`/api${p}`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
    return URL.createObjectURL(await res.blob());
  },
};

export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
