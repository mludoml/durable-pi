import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Credential } from "@earendil-works/pi-ai";
import { FileCredentialStore } from "../src/credentials.js";

const oauth: Credential = { type: "oauth", access: "access-secret", refresh: "refresh-secret", expires: 1_900_000_000_000 };
const apiKey: Credential = { type: "api_key", key: "key-secret" };

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-credentials-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Reads the counter, yields so the other modify can interleave if serialization is broken, then bumps it.
const bump = async (current: Credential | undefined): Promise<Credential> => {
  const count = Number(current?.type === "api_key" ? (current.env?.count ?? "0") : "0");
  await sleep(20);
  return { type: "api_key", env: { count: String(count + 1) } };
};

test("a credential written by one store is read by a fresh store", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    await new FileCredentialStore(path).modify("anthropic", async () => oauth);
    assert.deepEqual(await new FileCredentialStore(path).read("anthropic"), oauth);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { anthropic: oauth });
  }));

test("the file is 0600 inside a 0700 directory", () =>
  withDir(async (dir) => {
    const path = join(dir, "home", "auth.json");
    await new FileCredentialStore(path).modify("anthropic", async () => oauth);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, "home"))).mode & 0o777, 0o700);
  }));

test("concurrent modify calls on one provider both apply", () =>
  withDir(async (dir) => {
    const store = new FileCredentialStore(join(dir, "auth.json"));
    await Promise.all([store.modify("openai", bump), store.modify("openai", bump)]);
    assert.deepEqual(await store.read("openai"), { type: "api_key", env: { count: "2" } });
  }));

test("concurrent modify calls from separate stores serialize through the lock file", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    await Promise.all([
      new FileCredentialStore(path).modify("openai", bump),
      new FileCredentialStore(path).modify("openai", bump),
    ]);
    assert.deepEqual(await new FileCredentialStore(path).read("openai"), { type: "api_key", env: { count: "2" } });
    await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
  }));

test("list returns provider ids and types only", () =>
  withDir(async (dir) => {
    const store = new FileCredentialStore(join(dir, "auth.json"));
    await store.modify("anthropic", async () => oauth);
    await store.modify("openrouter", async () => apiKey);
    const list = await store.list();
    assert.deepEqual(
      [...list].sort((a, b) => a.providerId.localeCompare(b.providerId)),
      [
        { providerId: "anthropic", type: "oauth" },
        { providerId: "openrouter", type: "api_key" },
      ],
    );
    assert.doesNotMatch(JSON.stringify(list), /secret/);
  }));

test("delete removes one provider and keeps another", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    const store = new FileCredentialStore(path);
    await store.modify("anthropic", async () => oauth);
    await store.modify("openai", async () => apiKey);
    await store.delete("anthropic");
    assert.equal(await store.read("anthropic"), undefined);
    assert.deepEqual(await new FileCredentialStore(path).read("openai"), apiKey);
  }));

test("modify returning undefined leaves the file unchanged", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    const store = new FileCredentialStore(path);
    await store.modify("anthropic", async () => oauth);
    const before = await readFile(path, "utf8");
    let seen: Credential | undefined;
    const result = await store.modify("anthropic", async (current) => {
      seen = current;
      return undefined;
    });
    assert.deepEqual(seen, oauth);
    assert.deepEqual(result, oauth);
    assert.equal(await readFile(path, "utf8"), before);
  }));

test("a rejecting fn propagates and releases the lock", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    const store = new FileCredentialStore(path);
    await assert.rejects(
      store.modify("anthropic", async () => {
        throw new Error("refresh failed");
      }),
      /refresh failed/,
    );
    await store.modify("anthropic", async () => oauth);
    assert.deepEqual(await store.read("anthropic"), oauth);
  }));

test("a corrupt file rejects with an error naming the path", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    await writeFile(path, '{"anthropic": {"type": "oauth", "access": "access-secret"');
    const store = new FileCredentialStore(path);
    const namesPath = (error: unknown) => {
      assert.ok(error instanceof Error && error.message.includes(path));
      assert.doesNotMatch(error.message, /secret/);
      return true;
    };
    await assert.rejects(store.read("anthropic"), namesPath);
    await assert.rejects(store.modify("anthropic", async () => oauth), namesPath);
    assert.match(await readFile(path, "utf8"), /access-secret/);
  }));

test("an abort while waiting for the lock rejects without running fn", () =>
  withDir(async (dir) => {
    const path = join(dir, "auth.json");
    const holder = new FileCredentialStore(path).modify("anthropic", async () => {
      await sleep(100);
      return oauth;
    });
    await sleep(10);
    const controller = new AbortController();
    let ran = false;
    const waiting = new FileCredentialStore(path).modify(
      "anthropic",
      async () => {
        ran = true;
        return apiKey;
      },
      { signal: controller.signal },
    );
    controller.abort(new Error("gave up"));
    await assert.rejects(waiting, /gave up/);
    await holder;
    assert.equal(ran, false);
    assert.deepEqual(await new FileCredentialStore(path).read("anthropic"), oauth);
  }));
