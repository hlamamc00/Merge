import { ApiError, getToken } from '../api/client';

const BASE = '/api/v1';

async function throwIfFailed(res: Response): Promise<void> {
  if (res.ok) return;
  let data: { error?: string; details?: unknown } | null = null;
  try {
    data = (await res.json()) as { error?: string; details?: unknown };
  } catch {
    /* no body */
  }
  throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
}

/** Send one file as multipart/form-data (the JSON client cannot). */
export async function uploadFile<T>(path: string, file: File, field = 'file'): Promise<T> {
  const body = new FormData();
  body.append(field, file, file.name);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method: 'POST', headers, body });
  await throwIfFailed(res);
  return (await res.json()) as T;
}

/** Fetch a protected file with the session token and show it in a new tab. */
export async function openProtectedFile(path: string): Promise<void> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { headers });
  await throwIfFailed(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
