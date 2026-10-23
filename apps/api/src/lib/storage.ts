/**
 * Where uploaded files (compliance documents) live. Local disk by default; an S3-compatible
 * bucket is the production choice (decision 18) and can be plugged in here without touching routes.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface StoredFile {
  body: Buffer;
  mimeType: string;
}

export interface StorageAdapter {
  readonly kind: 'local' | 's3';
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

/** Keys are opaque and never derived from user input, so they are safe to use as paths. */
export function newFileKey(prefix: string, extension: string): string {
  const ext = extension.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${prefix}/${randomBytes(16).toString('hex')}${ext ? `.${ext}` : ''}`;
}

export class LocalDiskStorage implements StorageAdapter {
  readonly kind = 'local' as const;
  constructor(readonly root: string) {}

  private pathFor(key: string): string {
    const p = resolve(this.root, key);
    if (!p.startsWith(resolve(this.root))) throw new Error('Invalid storage key');
    return p;
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
    await writeFile(`${p}.meta`, JSON.stringify({ mimeType }));
  }

  async get(key: string): Promise<StoredFile | null> {
    const p = this.pathFor(key);
    try {
      const body = await readFile(p);
      let mimeType = 'application/octet-stream';
      try {
        mimeType = (JSON.parse(await readFile(`${p}.meta`, 'utf8')) as { mimeType?: string }).mimeType ?? mimeType;
      } catch {
        /* meta missing: serve as a download */
      }
      return { body, mimeType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    await rm(p, { force: true });
    await rm(`${p}.meta`, { force: true });
  }
}

/**
 * Placeholder for an S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2…). Wire in the
 * AWS SDK here when deploying; until then any attempt to use it fails loudly rather than silently
 * losing files.
 */
export class S3Storage implements StorageAdapter {
  readonly kind = 's3' as const;
  constructor(readonly bucket: string) {}
  private notConfigured(): never {
    throw new Error(`S3 storage is not configured (bucket "${this.bucket}"): install an S3 client and implement S3Storage, or set FILE_STORAGE=local`);
  }
  put(): Promise<void> {
    return Promise.reject(this.notConfigured());
  }
  get(): Promise<StoredFile | null> {
    return Promise.reject(this.notConfigured());
  }
  delete(): Promise<void> {
    return Promise.reject(this.notConfigured());
  }
}

let shared: StorageAdapter | undefined;

export function storageFromEnv(): StorageAdapter {
  if (process.env.FILE_STORAGE === 's3') return new S3Storage(process.env.S3_BUCKET ?? '');
  const root = process.env.FILE_STORAGE_DIR ?? (process.env.VITEST || process.env.NODE_ENV === 'test' ? join(process.cwd(), 'data', 'files-test') : join(process.cwd(), 'data', 'files'));
  return new LocalDiskStorage(root);
}

/** One adapter per process; tests can swap it with setStorage(). */
export function getStorage(): StorageAdapter {
  if (!shared) shared = storageFromEnv();
  return shared;
}

export function setStorage(adapter: StorageAdapter): void {
  shared = adapter;
}
