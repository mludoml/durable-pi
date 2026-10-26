// Device configuration: ~/.dpi/backend.env (or $DPI_ENV_FILE) plus CLI flags.
// Nothing here knows about specific machines; dpi-network.yaml on the operator's laptop
// writes this env file through `just net up <device>`.
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { PROVIDER_IDS, type ProviderId } from "./providers.js";

export interface BackendConfig {
  name: string;
  host: string;
  port: number;
  home: string;
  envFile: string;
  dataDir: string;
  startDirs: string[];
  providers: ProviderId[];
  defaultModel?: { provider: string; modelId: string };
  token: string;
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function parseProviders(value: string): ProviderId[] {
  const ids = [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
  if (!ids.length) throw Error("DPI_PROVIDER names no provider; use openrouter, anthropic, openai, ollama-cloud or faux");
  for (const id of ids)
    if (!PROVIDER_IDS.includes(id as ProviderId))
      throw Error(`Unknown provider ${id}; use openrouter, anthropic, openai, ollama-cloud or faux`);
  if (ids.includes("faux") && ids.length > 1) throw Error("faux cannot be combined with other providers");
  return ids as ProviderId[];
}

/** `<provider>/<modelId>`, split at the first slash: OpenRouter model ids contain slashes too. */
function parseModelRef(value: string) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1)
    throw Error(`DPI_DEFAULT_MODEL must be <provider>/<modelId>, got "${value}"`);
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export function loadConfig(argv = process.argv.slice(2), env = process.env): BackendConfig {
  const flag = (key: string, fallback: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return fallback;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw Error(`${key} needs a value`);
    return value;
  };
  const home = expand(env.DPI_HOME ?? join(homedir(), ".dpi"));
  const envFile = expand(flag("--env-file", env.DPI_ENV_FILE ?? join(home, "backend.env")));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config: BackendConfig = {
    name: flag("--name", env.DPI_DEVICE_NAME ?? hostname().replace(/\.local$/, "")),
    host: flag("--host", env.DPI_HOST ?? "127.0.0.1"),
    port: Number(flag("--port", env.DPI_PORT ?? "4780")),
    home,
    envFile,
    dataDir: resolve(expand(flag("--data-dir", env.DPI_DATA_DIR ?? join(home, "backend")))),
    startDirs: flag("--start-dirs", env.DPI_START_DIRS ?? "~/dpi-work")
      .split(":")
      .filter(Boolean)
      .map((p) => resolve(expand(p))),
    providers: parseProviders(env.DPI_PROVIDER || "openrouter"),
    defaultModel: env.DPI_DEFAULT_MODEL?.trim() ? parseModelRef(env.DPI_DEFAULT_MODEL.trim()) : undefined,
    token: env.DPI_TOKEN ?? "",
  };
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    throw Error(`Invalid port: ${config.port}`);
  if (config.token.length < 32)
    throw Error(
      `DPI_TOKEN is missing or shorter than 32 characters (looked in ${envFile}). Create one with: npm run token`,
    );
  return config;
}
