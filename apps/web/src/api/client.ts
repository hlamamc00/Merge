export const TOKEN_KEY = 'merge.token';

export interface EligibilityIssue {
  code: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }

  /** Blockers attached to a 422 eligibility failure, if any. */
  get blockers(): EligibilityIssue[] {
    const d = this.details as { blockers?: EligibilityIssue[] } | undefined;
    return d?.blockers ?? [];
  }

  get warnings(): EligibilityIssue[] {
    const d = this.details as { warnings?: EligibilityIssue[] } | undefined;
    return d?.warnings ?? [];
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

const BASE = '/api/v1';

async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = data as { error?: string; details?: unknown } | null;
    throw new ApiError(res.status, err?.error ?? `Request failed (${res.status})`, err?.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string | number | boolean | undefined>) => call<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => call<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body ?? {}),
  delete: <T>(path: string) => call<T>('DELETE', path),
};
