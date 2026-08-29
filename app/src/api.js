import Constants from 'expo-constants';
import { getItem, removeItem, setItem } from './storage';

const BASE =
  process.env.EXPO_PUBLIC_API_URL ||
  Constants.expoConfig?.extra?.apiUrl ||
  'http://localhost:8000';

const TOKEN_KEY = 'babylog.token';
let token = null;

export async function loadToken() {
  token = await getItem(TOKEN_KEY);
  return token;
}
export function currentToken() {
  return token;
}

export class ApiError extends Error {
  constructor(status, body) {
    super(typeof body === 'string' ? body : describe(body));
    this.status = status;
    this.body = body;
  }
}

// DRF returns errors in several shapes: {detail}, {field: [msgs]}, or a bare
// list. Flatten them so a screen can show one readable line.
function describe(body) {
  if (!body) return 'Something went wrong';
  if (typeof body === 'string') return body;
  if (body.detail) return String(body.detail);
  if (Array.isArray(body)) return body.map(describe).join('. ');
  return Object.entries(body)
    .map(([k, v]) => (k === 'non_field_errors' ? describe(v) : `${k}: ${describe(v)}`))
    .join('. ');
}

async function request(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Token ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(0, e.name === 'AbortError' ? 'Request timed out' : 'No connection');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text */
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
};

export async function login(username, password) {
  const { token: t } = await request('/api/auth/token/', {
    method: 'POST',
    body: { username, password },
  });
  token = t;
  await setItem(TOKEN_KEY, t);
  return t;
}

export async function logout() {
  token = null;
  await removeItem(TOKEN_KEY);
}

// --- endpoints -------------------------------------------------------------

// Multipart upload. Content-Type is deliberately unset: fetch must generate the
// multipart boundary itself, and setting it by hand produces a body the server
// cannot parse.
export async function postForm(path, form, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: token ? { Authorization: `Token ${token}` } : {},
      body: form,
    });
  } catch (e) {
    throw new ApiError(0, e.name === 'AbortError' ? 'Upload timed out' : 'No connection');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep raw */
  }
  if (!res.ok) throw new ApiError(res.status, parsed);
  return parsed;
}

export const Imports = {
  preview: (asset, tz) => {
    const form = new FormData();
    // Web hands back a real File; native needs the {uri,name,type} shape.
    form.append('file', asset.file || {
      uri: asset.uri,
      name: asset.name || 'export.csv',
      type: asset.mimeType || 'text/csv',
    });
    if (tz) form.append('tz', tz);
    return postForm('/api/import/preview/', form);
  },
  commit: (baby, events) => api.post('/api/import/commit/', { baby, events }),
};

export const Households = {
  mine: () => api.get('/api/households/'),
};

export const Babies = {
  list: () => api.get('/api/babies/'),
  create: (b) => api.post('/api/babies/', b),
};

export const Events = {
  list: (params = {}) => {
    const q = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return api.get(`/api/events/${q ? `?${q}` : ''}`);
  },
  get: (id) => api.get(`/api/events/${id}/`),
  latest: () => api.get('/api/events/latest/'),
  active: () => api.get('/api/events/active/'),
  create: (e) => api.post('/api/events/', e),
  update: (id, e) => api.patch(`/api/events/${id}/`, e),
  remove: (id) => api.del(`/api/events/${id}/`),
  // Timer intents. The server owns the accumulators -- never send computed
  // right_sec/left_sec, or two phones will clobber each other.
  tick: (id, action, side, at) =>
    api.post(`/api/events/${id}/timer/`, {
      action,
      ...(side ? { side } : {}),
      at: (at || new Date()).toISOString(),
    }),
  finish: (id, at) =>
    api.post(`/api/events/${id}/finish/`, { at: (at || new Date()).toISOString() }),
};

export const deviceTz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};
