// The model providers a device can serve (DPI_PROVIDER) and the models it offers from each.
import { envApiKeyAuth, type Api, type Model } from "@earendil-works/pi-ai";
import { createProvider, type MutableModels, type Provider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { curatedModels, defaultModelId } from "./model-catalog.js";
import { fauxModels, installFaux } from "./faux.js";

export type ProviderId = "openrouter" | "anthropic" | "openai" | "ollama-cloud" | "faux";

/** A model the device offers, with its display metadata. */
export interface Offered {
  model: Model<Api>;
  name: string;
  tier: string;
  icon: string;
}

export interface ProviderDef {
  /** Registers the provider; throws when pi-ai's catalog lacks a curated model. */
  install(models: MutableModels): void;
  /** Dynamic catalogs list nothing until `Models.refresh()` fetches them. */
  dynamic?: boolean;
  /** The models the device offers from the provider's available ones, in display order. */
  offer(available: readonly Model<Api>[]): Offered[];
  /** Whether the device serves this model id from the provider, listed right now or not. */
  curates(modelId: string): boolean;
  /** Preferred default model id; absent means the first offered. */
  defaultModel?: string;
}

type Curated = readonly { id: string; name: string; tier: string; icon: string }[];

function curatedProvider(label: string, factory: () => Provider, curated: Curated, defaultModel: string): ProviderDef {
  return {
    defaultModel,
    install(models) {
      const provider = factory();
      const catalog = provider.getModels();
      for (const model of curated)
        if (!catalog.some((m) => m.id === model.id)) throw Error(`${label} catalog missing ${model.id}`);
      models.setProvider({
        ...provider,
        getModels: () => catalog.filter((m) => curated.some((c) => c.id === m.id)),
      });
    },
    offer: (available) =>
      curated.flatMap((c) => {
        const model = available.find((m) => m.id === c.id);
        return model ? [{ model, name: c.name, tier: c.tier, icon: c.icon }] : [];
      }),
    curates: (modelId) => curated.some((c) => c.id === modelId),
  };
}

const anthropicModels: Curated = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", tier: "S+", icon: "anthropic.png" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", tier: "S+", icon: "anthropic.png" },
  { id: "claude-fable-5-1", name: "Claude Fable 5.1", tier: "S+", icon: "anthropic.png" },
  { id: "claude-opus-5", name: "Opus 5", tier: "S+", icon: "anthropic.png" },
  { id: "claude-sonnet-5", name: "Sonnet 5", tier: "A", icon: "anthropic.png" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", tier: "B", icon: "anthropic.png" },
];

const openaiModels: Curated = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", tier: "S+", icon: "openai.png" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", tier: "S+", icon: "openai.png" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", tier: "S", icon: "openai.png" },
  { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", tier: "A", icon: "openai.png" },
  { id: "gpt-6-luna", name: "GPT-6 Luna", tier: "A", icon: "openai.png" },
  { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", tier: "A", icon: "openai.png" },
];

// Ollama ignores the key, but pi-ai's OpenAI client refuses to send a request without one.
const KEYLESS = "ollama";

function ollamaHost() {
  const host = (process.env.OLLAMA_HOST || "https://ollama.com").replace(/\/+$/, "");
  return host.includes("://") ? host : `http://${host}`;
}

async function ollamaJson(url: string, key: string | undefined, signal: AbortSignal, body?: unknown) {
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw Error(`${url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Ollama Cloud, or any Ollama server at OLLAMA_HOST; its catalog is the server's model list. */
function installOllama(models: MutableModels) {
  const host = ollamaHost();
  const baseUrl = `${host}/v1`;
  const cloud = /(^|\.)ollama\.com$/.test(new URL(host).hostname);
  const standard = envApiKeyAuth("Ollama API key", ["OLLAMA_API_KEY"]);
  models.setProvider(
    createProvider({
      id: "ollama-cloud",
      name: "Ollama Cloud",
      baseUrl,
      auth: {
        apiKey: {
          ...standard,
          // A local server needs no key; ollama.com does.
          resolve: async (input) =>
            (await standard.resolve(input)) ??
            (cloud ? undefined : { auth: { apiKey: KEYLESS }, source: "keyless Ollama server" }),
        },
      },
      models: [],
      fetchModels: async ({ credential, signal }) => {
        const key = credential?.type === "api_key" && credential.key !== KEYLESS ? credential.key : undefined;
        const tags = (await ollamaJson(`${host}/api/tags`, key, signal)) as { models?: { name: string }[] };
        return Promise.all(
          (tags.models ?? []).map(async ({ name }): Promise<Model<"openai-completions">> => {
            const show = (await ollamaJson(`${host}/api/show`, key, signal, { model: name })) as {
              model_info?: Record<string, unknown>;
              capabilities?: string[];
            };
            const length = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
            const contextWindow = typeof length === "number" && length > 0 ? length : 128000;
            const capabilities = show.capabilities ?? [];
            return {
              id: name,
              name,
              api: "openai-completions",
              provider: "ollama-cloud",
              baseUrl,
              reasoning: capabilities.includes("thinking"),
              input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow,
              maxTokens: Math.min(contextWindow, 32000),
              compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            };
          }),
        );
      },
      api: openAICompletionsApi(),
    }),
  );
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  openrouter: curatedProvider("OpenRouter", openrouterProvider, curatedModels, defaultModelId),
  anthropic: curatedProvider("Anthropic", anthropicProvider, anthropicModels, "claude-sonnet-5-5"),
  openai: curatedProvider("OpenAI", openaiProvider, openaiModels, "gpt-6-sol"),
  "ollama-cloud": {
    dynamic: true,
    install: installOllama,
    offer: (available) => available.map((model) => ({ model, name: model.name, tier: "cloud", icon: "lab.png" })),
    // The catalog is whatever the server lists, so any id may come back once it answers again.
    curates: () => true,
  },
  faux: {
    defaultModel: fauxModels[0].id,
    install: (models) => void installFaux(models),
    offer: (available) =>
      fauxModels.flatMap((f) => {
        const model = available.find((m) => m.id === f.id);
        return model ? [{ model, name: f.name, tier: "T", icon: "lab.png" }] : [];
      }),
    curates: (modelId) => fauxModels.some((f) => f.id === modelId),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
