import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/store.js";
import { faux, newToken, tempStore } from "./helpers.js";

const config = (env: Record<string, string>) =>
  loadConfig([], { DPI_HOME: "/nonexistent/dpi", DPI_ENV_FILE: "/nonexistent/dpi/none.env", DPI_TOKEN: newToken(), ...env });

test("DPI_PROVIDER and DPI_DEFAULT_MODEL parsing", () => {
  assert.deepEqual(config({}).providers, ["openrouter"]);
  assert.equal(config({}).defaultModel, undefined);
  assert.deepEqual(config({ DPI_PROVIDER: " anthropic , openai,anthropic,, ollama-cloud,openrouter " }).providers, [
    "anthropic",
    "openai",
    "ollama-cloud",
    "openrouter",
  ]);
  assert.deepEqual(config({ DPI_PROVIDER: "faux" }).providers, ["faux"]);
  assert.throws(
    () => config({ DPI_PROVIDER: "openrouter,bogus" }),
    /^Error: Unknown provider bogus; use openrouter, anthropic, openai, ollama-cloud or faux$/,
  );
  assert.throws(() => config({ DPI_PROVIDER: "faux,openrouter" }), /faux cannot be combined with other providers/);

  assert.deepEqual(config({ DPI_DEFAULT_MODEL: "openrouter/anthropic/claude-sonnet-5.5" }).defaultModel, {
    provider: "openrouter",
    modelId: "anthropic/claude-sonnet-5.5",
  });
  assert.deepEqual(config({ DPI_DEFAULT_MODEL: " anthropic/claude-sonnet-5-5 " }).defaultModel, {
    provider: "anthropic",
    modelId: "claude-sonnet-5-5",
  });
  for (const bad of ["claude-sonnet-5-5", "/claude", "anthropic/"])
    assert.throws(() => config({ DPI_DEFAULT_MODEL: bad }), /DPI_DEFAULT_MODEL must be <provider>\/<modelId>/);
});

test("faux device default, and a DPI_DEFAULT_MODEL the device does not list", async () => {
  const t = await tempStore();
  try {
    const store = await t.open();
    assert.equal(store.deviceInfo().defaultModel, faux.modelId);
    assert.deepEqual(
      store.deviceInfo().models.map((m) => [m.provider, m.id, m.tier]),
      [["faux", "echo", "T"]],
    );
    await store.close();
    await assert.rejects(
      () => Store.open({ ...t.options, defaultModel: { provider: "faux", modelId: "nope" } }),
      /DPI_DEFAULT_MODEL faux\/nope is not available on this device/,
    );
    const chosen = await Store.open({ ...t.options, defaultModel: faux });
    assert.equal(chosen.deviceInfo().defaultModel, faux.modelId);
    await chosen.close();
  } finally {
    await t.cleanup();
  }
});

const body = async (req: IncomingMessage) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : undefined;
};

test("ollama-cloud lists the server's models and streams a turn through it", async () => {
  const seen: { path: string; auth?: string; model?: string }[] = [];
  const server = createServer(async (req, res) => {
    const json = await body(req);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, model: json?.model });
    if (req.method === "GET" && req.url === "/api/tags") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ models: [{ name: "fake-cloud:20b" }] }));
    }
    if (req.method === "POST" && req.url === "/api/show") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          model_info: { "general.architecture": "fake", "fake.context_length": 65536 },
          capabilities: ["completion", "tools", "thinking"],
        }),
      );
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "Hello from " }, null));
      res.write(chunk({ content: "fake Ollama" }, null));
      res.write(chunk({}, "stop"));
      res.write(
        `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: json.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } })}\n\n`,
      );
      return res.end("data: [DONE]\n\n");
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const saved = { host: process.env.OLLAMA_HOST, key: process.env.OLLAMA_API_KEY };
  process.env.OLLAMA_HOST = `${host}/`;
  process.env.OLLAMA_API_KEY = "test-ollama-key";
  const t = await tempStore();
  try {
    const store = await Store.open({ ...t.options, providers: ["ollama-cloud"] });
    try {
      const info = store.deviceInfo();
      assert.deepEqual(info.models, [
        {
          id: "fake-cloud:20b",
          provider: "ollama-cloud",
          name: "fake-cloud:20b",
          tier: "cloud",
          icon: "lab.png",
          contextWindow: 65536,
          reasoning: true,
          cost: { input: 0, output: 0 },
        },
      ]);
      assert.equal(info.defaultModel, "fake-cloud:20b");
      assert.throws(() => store.validateModel(faux), /Unknown model faux\/echo/);

      const model = { provider: "ollama-cloud", modelId: "fake-cloud:20b" };
      const session = await store.create({ name: "Cloud", cwd: t.work, model });
      const { h, c } = await store.resolveAgent(session.id, "main");
      const sent = await store.send(c, { content: "Say hello", requestId: "ollama-1" });
      const answer = await store.settled(h, sent.id as number, 20000);
      assert.ok(answer.status === "done", JSON.stringify(answer));
      assert.equal(answer.answer.text, "Hello from fake Ollama");
      assert.ok(seen.filter((r) => r.path !== "/api/tags").every((r) => r.model === "fake-cloud:20b"));
      assert.ok(seen.some((r) => r.path === "/v1/chat/completions"));
      assert.ok(seen.every((r) => r.auth === "Bearer test-ollama-key"));
    } finally {
      await store.close();
    }
  } finally {
    for (const [name, value] of [
      ["OLLAMA_HOST", saved.host],
      ["OLLAMA_API_KEY", saved.key],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    server.close();
    await t.cleanup();
  }
});

test("a session keeps its model when its enabled provider lists nothing after a restart", async () => {
  let tagsServed = 0;
  const server = createServer(async (req, res) => {
    const json = await body(req);
    res.setHeader("content-type", "application/json");
    // The first start lists the model; on the restart the catalog fetch fails, as with an expired login.
    if (req.method === "GET" && req.url === "/api/tags") {
      if (tagsServed++ > 0) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "unavailable" }));
      }
      return res.end(JSON.stringify({ models: [{ name: "fake-cloud:20b" }] }));
    }
    if (req.method === "POST" && req.url === "/api/show" && json?.model === "fake-cloud:20b")
      return res.end(JSON.stringify({ model_info: {}, capabilities: ["completion"] }));
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const saved = {
    host: process.env.OLLAMA_HOST,
    key: process.env.OLLAMA_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };
  process.env.OLLAMA_HOST = `http://127.0.0.1:${address.port}`;
  process.env.OLLAMA_API_KEY = "test-ollama-key";
  // OpenRouter stays listed, so its default model is a real place the session could be moved to.
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  const warn = console.warn;
  console.warn = () => {};
  const t = await tempStore();
  const options = { ...t.options, providers: ["openrouter" as const, "ollama-cloud" as const] };
  const model = { provider: "ollama-cloud", modelId: "fake-cloud:20b" };
  try {
    const first = await Store.open(options);
    const listed = first.deviceInfo().models.some((m) => m.provider === "ollama-cloud" && m.id === model.modelId);
    const session = await first.create({ name: "Cloud", cwd: t.work, model }).finally(() => first.close());
    assert.ok(listed);

    const reopened = await Store.open(options);
    try {
      const info = reopened.deviceInfo();
      assert.ok(!info.models.some((m) => m.provider === "ollama-cloud"), "ollama-cloud lists nothing on the restart");
      assert.notEqual(info.defaultModel, model.modelId);
      const { row, c } = await reopened.resolveAgent(session.id, "main");
      assert.deepEqual((await reopened.agentDetail(row, c)).config.model, model);
      assert.equal(row.model, model.modelId);
      assert.throws(() => reopened.validateModel(model), /Unknown model ollama-cloud\/fake-cloud:20b/);
    } finally {
      await reopened.close();
    }
    assert.equal(tagsServed, 2);
  } finally {
    console.warn = warn;
    for (const [name, value] of [
      ["OLLAMA_HOST", saved.host],
      ["OLLAMA_API_KEY", saved.key],
      ["OPENROUTER_API_KEY", saved.openrouter],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    server.close();
    await t.cleanup();
  }
});

test("ollama-cloud without a key is skipped with a warning, not a crash", async () => {
  const saved = { host: process.env.OLLAMA_HOST, key: process.env.OLLAMA_API_KEY };
  delete process.env.OLLAMA_HOST;
  delete process.env.OLLAMA_API_KEY;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  const t = await tempStore();
  try {
    const store = await Store.open({ ...t.options, providers: ["ollama-cloud"] });
    assert.deepEqual(store.deviceInfo().models, []);
    assert.equal(store.deviceInfo().defaultModel, undefined);
    await store.close();
    assert.ok(warnings.some((w) => /Provider ollama-cloud lists no models: not configured/.test(w)), warnings.join("\n"));
  } finally {
    console.warn = warn;
    if (saved.host !== undefined) process.env.OLLAMA_HOST = saved.host;
    if (saved.key !== undefined) process.env.OLLAMA_API_KEY = saved.key;
    await t.cleanup();
  }
});
