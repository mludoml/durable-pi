// pi-ai CredentialStore backed by $DPI_HOME/auth.json (same shape as pi's auth.json).
// The login CLI and the backend are separate processes, and pi-ai refreshes OAuth tokens
// inside `modify`, so every write holds a cross-process lock file around read → fn → write.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { clearInterval, setInterval } from "node:timers";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type Credentials = Record<string, Credential>;

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MAX_MS = 200;

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

export class FileCredentialStore implements CredentialStore {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(readonly path: string) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return (await this.load())[providerId];
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.serialize(providerId, options?.signal, async () => {
      const credentials = await this.load();
      const current = credentials[providerId];
      const next = await fn(current);
      if (next === undefined) return current;
      credentials[providerId] = next;
      await this.save(credentials);
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.serialize(providerId, options?.signal, async () => {
      const credentials = await this.load();
      if (!Object.hasOwn(credentials, providerId)) return;
      delete credentials[providerId];
      await this.save(credentials);
    });
  }

  /** Run `task` after earlier tasks for this provider settle, holding the file lock. */
  private serialize<T>(providerId: string, signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const run = (async () => {
      await abortable(previous, signal);
      const release = await this.lock(signal);
      try {
        return await task();
      } finally {
        await release();
      }
    })();
    // A caller that aborts while queued must not let the next task overtake `previous`.
    const tail = Promise.allSettled([previous, run]).then(() => {});
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return run;
  }

  private async lock(signal: AbortSignal | undefined): Promise<() => Promise<void>> {
    const lockPath = `${this.path}.lock`;
    const token = `${process.pid} ${randomUUID()}`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await writeFile(lockPath, token, { flag: "wx", mode: 0o600 });
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      const modified = await stat(lockPath).then(
        (stats) => stats.mtimeMs,
        (error) => {
          if (errorCode(error) === "ENOENT") return undefined;
          throw error;
        },
      );
      if (modified === undefined) continue;
      if (Date.now() - modified > LOCK_STALE_MS) {
        await rm(lockPath, { force: true });
        continue;
      }
      await sleep(Math.min(10 * 2 ** attempt, LOCK_RETRY_MAX_MS), undefined, { signal }).catch((error: unknown) => {
        // Surface the caller's abort reason rather than Node's generic AbortError.
        signal?.throwIfAborted();
        throw error;
      });
    }
    // Keep the lock fresh so a slow token refresh inside `fn` is not mistaken for a crashed holder.
    const heartbeat = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch(() => {});
    }, LOCK_STALE_MS / 3);
    heartbeat.unref();
    return async () => {
      clearInterval(heartbeat);
      const holder = await readFile(lockPath, "utf8").catch(() => undefined);
      if (holder === token) await rm(lockPath, { force: true });
    };
  }

  private async load(): Promise<Credentials> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // No cause: JSON.parse messages quote file contents, which are secrets.
      throw new Error(`Credential file ${this.path} is not valid JSON; fix or remove it`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`Credential file ${this.path} must contain a JSON object`);
    return parsed as Credentials;
  }

  private async save(credentials: Credentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    // A leftover temp file from a crash could carry a wider mode; writeFile only sets mode on create.
    await rm(temp, { force: true });
    try {
      await writeFile(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
}

function abortable(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
