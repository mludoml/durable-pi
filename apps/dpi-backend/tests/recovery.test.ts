import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { TaskNode } from "../../dpi-sdk/src/api.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("SIGKILL restart resumes a durable job from its checkpoint with no client attached", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Crash recovery", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "change-watch", input: { checks: 4, interval_seconds: 2 } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => ((await run())?.phases[1].progress?.done ?? 0) >= 1, 15000, "first check");
    await server.stop("SIGKILL");
    await server.start();
    await until(async () => (await run())?.status === "completed", 30000, "completion after SIGKILL");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done"]);
    assert.equal(done.phases[1].steps.filter((s) => s.kind === "checkpoint" && s.status === "done").length, 4);
    const history = await main.entries({ scope: "all" });
    assert.equal(history.items.filter((e) => e.kind === "demo.job").length, 1);
  } finally {
    await server.stop();
    await t.cleanup();
  }
});

test("a task cut off by 5 crashes in a row is parked, and retry runs it again", async () => {
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({ home: join(t.root, "home"), startDirs: t.work, token });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "Crash loop", cwd: t.work, model: faux });
    const session = client.session(s.id);
    const main = client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "release-check" });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => (await run())?.approval === "pending", 20000, "approval");
    // The approval task polls inside its phase, so every crash cuts it off.
    const approval = async () =>
      ((await session.tasks("live")) as unknown as TaskNode[]).find((n) => n.kind === "demo.job-approval");
    for (let crash = 1; crash <= 5; crash++) {
      await server.stop("SIGKILL");
      await server.start();
      await until(async () => !!(await approval()), 15000, `reopen after crash ${crash}`);
    }
    const parked = (await approval())!;
    assert.equal(parked.blocked, "restart_limit");
    // A decision recorded while parked waits; retry runs the approval again and it picks the decision up.
    await main.demo(`jobs/${taskId}/approval`, { approved: true });
    assert.equal((await approval())?.blocked, "restart_limit");
    assert.deepEqual(await session.retryTask(parked.id), { ok: true });
    await until(async () => (await run())?.status === "completed", 20000, "completion after retry");
  } finally {
    await server.stop();
    await t.cleanup();
  }
});
