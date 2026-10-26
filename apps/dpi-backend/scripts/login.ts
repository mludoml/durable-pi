// Subscription logins for this device: OAuth credentials go to $DPI_HOME/auth.json, which the
// backend reads at startup. Usage: npm run login -- login <provider> | logout <provider> | status
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { FileCredentialStore } from "../src/credentials.js";

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const home = expand(process.env.DPI_HOME ?? join(homedir(), ".dpi"));
const store = new FileCredentialStore(join(home, "auth.json"));
const oauthProviders = [anthropicProvider(), openaiProvider(), openrouterProvider()].filter((p) => p.auth.oauth);
const providerIds = oauthProviders.map((p) => p.id).join(", ");

function usage(): never {
  console.error(
    `Usage: npm run login -- <command>\n\n` +
      `  login <provider>   Sign in with a subscription (${providerIds})\n` +
      `  logout <provider>  Remove a stored credential\n` +
      `  status             List stored credentials`,
  );
  process.exit(1);
}

/** Stable per-installation id; OpenAI's login sends it as the agent host id. */
function deviceId(): string {
  const file = join(home, "installation-id");
  try {
    const id = readFileSync(file, "utf8").trim();
    if (id) return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try {
    writeFileSync(file, `${id}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // Another login created it first; use theirs so the id stays stable.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return readFileSync(file, "utf8").trim();
    throw error;
  }
  return id;
}

async function ask(rl: Interface, authPrompt: AuthPrompt, signal: AbortSignal): Promise<string> {
  // manual_code prompts race a local callback server; its signal aborts the prompt when the server wins.
  const questionSignal = authPrompt.signal ? AbortSignal.any([signal, authPrompt.signal]) : signal;
  const hint = authPrompt.type !== "select" && authPrompt.placeholder ? ` (${authPrompt.placeholder})` : "";
  try {
    if (authPrompt.type === "select") {
      console.log(`\n${authPrompt.message}`);
      authPrompt.options.forEach((option, i) =>
        console.log(`  ${i + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`),
      );
      for (;;) {
        const answer = (await rl.question(`Enter number (1-${authPrompt.options.length}): `, { signal: questionSignal })).trim();
        const selected = authPrompt.options[Number(answer) - 1] ?? authPrompt.options.find((o) => o.id === answer);
        if (selected) return selected.id;
      }
    }
    if (authPrompt.type === "secret") {
      // Silence readline's echo so a pasted secret does not stay on screen.
      const output = rl as unknown as { _writeToOutput(text: string): void };
      const write = output._writeToOutput;
      process.stdout.write(`${authPrompt.message}${hint}: `);
      output._writeToOutput = () => {};
      try {
        return (await rl.question("", { signal: questionSignal })).trim();
      } finally {
        output._writeToOutput = write;
        process.stdout.write("\n");
      }
    }
    return (await rl.question(`${authPrompt.message}${hint}: `, { signal: questionSignal })).trim();
  } catch (error) {
    if (questionSignal.aborted) process.stdout.write("\n");
    // Report why the login stopped (cancel, closed input), not readline's generic AbortError.
    throw signal.aborted ? signal.reason : error;
  }
}

function show(event: AuthEvent) {
  switch (event.type) {
    case "auth_url":
      console.log(`\nOpen this URL in your browser:\n${event.url}`);
      if (event.instructions) console.log(event.instructions);
      break;
    case "device_code":
      console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
      console.log(`Enter code: ${event.userCode}`);
      break;
    case "info":
      console.log(event.message);
      for (const link of event.links ?? []) console.log(`${link.label ?? "More information"}: ${link.url}`);
      break;
    case "progress":
      console.log(event.message);
      break;
  }
}

async function login(providerId: string | undefined) {
  const provider = oauthProviders.find((p) => p.id === providerId);
  const oauth = provider?.auth.oauth;
  if (!provider || !oauth) {
    console.error(`${providerId ? `Unknown provider ${providerId}` : "Missing provider"}; use one of: ${providerIds}`);
    process.exit(1);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Login cancelled"));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // readline owns Ctrl+C while it reads the terminal; the process handler covers the rest.
  rl.on("SIGINT", cancel);
  process.on("SIGINT", cancel);
  // At stdin EOF readline closes and leaves a pending question unsettled; fail the login instead.
  const inputClosedMessage = "Input closed before the login finished";
  let inputOpen = true;
  let pendingPrompts = 0;
  rl.on("close", () => {
    inputOpen = false;
    if (pendingPrompts > 0) controller.abort(new Error(inputClosedMessage));
  });
  const prompt = async (authPrompt: AuthPrompt) => {
    if (!inputOpen) {
      controller.abort(new Error(inputClosedMessage));
      throw controller.signal.reason;
    }
    pendingPrompts++;
    try {
      return await ask(rl, authPrompt, controller.signal);
    } finally {
      pendingPrompts--;
    }
  };
  try {
    const interaction: ProviderAuthInteraction = { signal: controller.signal, prompt, notify: show };
    try {
      const credential = await oauth.login(interaction, { getDeviceId: deviceId });
      await store.modify(provider.id, async () => credential);
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    }
  } finally {
    process.off("SIGINT", cancel);
    rl.close();
  }
  console.log(`\nLogged in to ${oauth.name}. Restart the backend (just backend run) to list its models.`);
}

async function logout(providerId: string | undefined) {
  if (!providerId) usage();
  if (!(await store.read(providerId))) {
    console.log(`No credential stored for ${providerId}.`);
    return;
  }
  await store.delete(providerId);
  console.log(`Removed the ${providerId} credential. Restart the backend (just backend run) to apply.`);
}

async function status() {
  const credentials = await store.list();
  if (credentials.length === 0) console.log("(none)");
  for (const { providerId, type } of credentials) console.log(`${providerId}  ${type}`);
}

const [command, providerId] = process.argv.slice(2);
try {
  if (command === "login") await login(providerId);
  else if (command === "logout") await logout(providerId);
  else if (command === "status") await status();
  else usage();
  // OAuth callback servers and keep-alive sockets may linger after a finished login.
  process.exit(0);
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
