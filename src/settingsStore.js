import fs from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "./errors.js";

const MODEL_DEFAULTS = {
  "claude-haiku": {
    kind: "chat",
    provider: "claude",
    cliModelKey: "haiku",
    cliModel: "haiku",
    capabilities: ["chat", "vision", "fast"],
    output: ["text"],
    fallback: ["claude-sonnet", "codex-gpt-5.5"],
  },
  "claude-sonnet": {
    kind: "chat",
    provider: "claude",
    cliModelKey: "sonnet",
    cliModel: "sonnet",
    capabilities: ["chat", "vision", "smart"],
    output: ["text"],
    fallback: ["codex-gpt-5.5"],
  },
  "claude-opus": {
    kind: "chat",
    provider: "claude",
    cliModelKey: "opus",
    cliModel: "opus",
    capabilities: ["chat", "vision", "deep_reasoning"],
    output: ["text"],
    fallback: ["claude-sonnet", "codex-gpt-5.5"],
  },
  "codex-gpt-5.5": {
    kind: "chat",
    provider: "codex",
    cliModelKey: "model",
    cliModel: "gpt-5.5",
    capabilities: ["chat", "code"],
    fallback: ["claude-sonnet"],
    output: ["text"],
  },
  "codex-gpt-5.5-vision": {
    kind: "chat",
    provider: "codex",
    cliModelKey: "model",
    cliModel: "gpt-5.5",
    capabilities: ["chat", "vision", "image_input"],
    fallback: [],
    output: ["text"],
  },
  "chatgpt-image-browser": {
    kind: "image",
    provider: "chatgpt-browser",
    capabilities: ["image_generate", "image_edit_experimental"],
    fallback: [],
    output: ["image"],
  },
};

const PROVIDERS = new Set(["claude", "codex", "chatgpt-browser"]);
const MODEL_KINDS = new Set(["chat", "image"]);

export class SettingsStore {
  constructor({ filePath, defaultSettings }) {
    this.filePath = filePath;
    this.defaultSettings = defaultSettings;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      const normalized = normalizeSettings(parsed, { baseDir: path.dirname(this.filePath) });
      const defaults = normalizeSettings(resolveDefault(this.defaultSettings), { baseDir: path.dirname(this.filePath) });
      const merged = mergeMissingDefaults(normalized, defaults);
      if (merged.changed) {
        await this.write(merged.settings);
      }
      return merged.settings;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new ProviderError("invalid_request", `Could not load LLMHQ settings: ${error.message}`);
      }
      const settings = normalizeSettings(resolveDefault(this.defaultSettings), { baseDir: path.dirname(this.filePath) });
      await this.write(settings);
      return settings;
    }
  }

  async save(settings) {
    const normalized = normalizeSettings(settings, { baseDir: path.dirname(this.filePath) });
    await this.write(normalized);
    return normalized;
  }

  async write(settings) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.filePath);
  }
}

export function defaultRuntimeSettings(config) {
  const claudeEnabled = Boolean(config.claude?.enabled);
  const codexEnabled = Boolean(config.codex?.enabled);
  const chatgptBrowserEnabled = Boolean(config.chatgpt?.enabled);
  const models = {};

  for (const [id, defaults] of Object.entries(MODEL_DEFAULTS)) {
    const providerEnabled =
      defaults.provider === "claude"
        ? claudeEnabled
        : defaults.provider === "codex"
          ? codexEnabled
          : chatgptBrowserEnabled;
    const providerConfig = defaults.provider === "claude" ? config.claude : defaults.provider === "codex" ? config.codex : {};
    const configuredCliModel =
      defaults.provider === "claude"
        ? providerConfig?.models?.[defaults.cliModelKey]
        : defaults.provider === "codex"
          ? providerConfig?.[defaults.cliModelKey]
          : null;

    models[id] = {
      enabled: providerEnabled,
      kind: defaults.kind,
      provider: defaults.provider,
      ...(defaults.kind === "chat" ? { cliModel: configuredCliModel || defaults.cliModel } : {}),
      capabilities: defaults.capabilities,
      output: defaults.output,
      fallback: defaults.fallback,
    };
  }

  return normalizeSettings(
    {
      version: 1,
      defaultModel: config.chat?.defaultModel || "claude-sonnet",
      workers: {
        claude: config.claude?.workers || [],
        codex: config.codex?.workers || [],
      },
      models,
    },
    { baseDir: path.dirname(config.settingsFile || process.cwd()) },
  );
}

export function normalizeSettings(settings, { baseDir = process.cwd() } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ProviderError("invalid_request", "settings must be a JSON object.");
  }

  const workers = normalizeWorkers(settings.workers || {}, baseDir);
  const models = normalizeModels(settings.models || {});
  const defaultModel = normalizeDefaultModel(settings.defaultModel, models);

  return {
    version: 1,
    defaultModel,
    workers,
    models,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeWorkers(workers, baseDir) {
  return {
    claude: normalizeWorkerList(workers.claude, baseDir),
    codex: normalizeWorkerList(workers.codex, baseDir),
  };
}

function normalizeWorkerList(value, baseDir) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ProviderError("invalid_request", "worker lists must be arrays.");
  }

  const seen = new Set();
  return value.map((worker, index) => {
    if (!worker || typeof worker !== "object" || Array.isArray(worker)) {
      throw new ProviderError("invalid_request", `worker at index ${index} must be an object.`);
    }
    const id = String(worker.id || "").trim();
    if (!id) {
      throw new ProviderError("invalid_request", `worker at index ${index} is missing id.`);
    }
    if (seen.has(id)) {
      throw new ProviderError("invalid_request", `duplicate worker id: ${id}`);
    }
    seen.add(id);
    return {
      id,
      profileDir: normalizePath(worker.profileDir, baseDir),
    };
  });
}

function normalizeModels(models) {
  if (!models || typeof models !== "object" || Array.isArray(models)) {
    throw new ProviderError("invalid_request", "models must be an object keyed by alias.");
  }

  const normalized = {};
  for (const [rawId, rawModel] of Object.entries(models)) {
    const id = String(rawId || "").trim();
    if (!id) {
      throw new ProviderError("invalid_request", "model aliases must be non-empty.");
    }
    if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) {
      throw new ProviderError("invalid_request", `${id} must be a model object.`);
    }

    const kind = String(rawModel.kind || "chat").trim();
    if (!MODEL_KINDS.has(kind)) {
      throw new ProviderError("invalid_request", `${id} has unsupported kind: ${kind || "missing"}.`);
    }
    const provider = String(rawModel.provider || "").trim();
    if (!PROVIDERS.has(provider)) {
      throw new ProviderError("invalid_request", `${id} has unsupported provider: ${provider || "missing"}.`);
    }
    if (provider === "chatgpt-browser" && kind !== "image") {
      throw new ProviderError("invalid_request", `${id} uses chatgpt-browser but is not an image model.`);
    }
    if ((provider === "claude" || provider === "codex") && kind !== "chat") {
      throw new ProviderError("invalid_request", `${id} uses ${provider} but is not a chat model.`);
    }

    const cliModel = rawModel.cliModel == null ? null : String(rawModel.cliModel || "").trim();
    if (kind === "chat" && !cliModel) {
      throw new ProviderError("invalid_request", `${id} is missing cliModel.`);
    }

    normalized[id] = {
      enabled: rawModel.enabled !== false,
      kind,
      provider,
      ...(kind === "chat" ? { cliModel } : {}),
      capabilities: normalizeStringArray(
        rawModel.capabilities,
        kind === "image" ? ["image_generate"] : ["chat"],
        `${id}.capabilities`,
      ),
      output: normalizeStringArray(rawModel.output, kind === "image" ? ["image"] : ["text"], `${id}.output`),
      fallback: normalizeStringArray(rawModel.fallback, [], `${id}.fallback`),
    };
  }

  for (const [id, model] of Object.entries(normalized)) {
    if (!model.enabled) {
      continue;
    }
    for (const fallbackId of model.fallback) {
      if (!normalized[fallbackId]?.enabled) {
        throw new ProviderError("invalid_request", `${id} fallback references unavailable model: ${fallbackId}.`);
      }
    }
  }

  return normalized;
}

function normalizeDefaultModel(value, models) {
  const defaultModel = String(value || "").trim();
  if (defaultModel && models[defaultModel]?.enabled && models[defaultModel]?.kind === "chat") {
    return defaultModel;
  }

  const firstEnabled = Object.entries(models).find(([, model]) => model.enabled && model.kind === "chat");
  if (firstEnabled) {
    return firstEnabled[0];
  }
  return defaultModel;
}

function normalizeStringArray(value, defaultValue, name) {
  if (value == null) {
    return defaultValue;
  }
  if (!Array.isArray(value)) {
    throw new ProviderError("invalid_request", `${name} must be an array.`);
  }
  const normalized = value.map((entry) => String(entry || "").trim()).filter(Boolean);
  return [...new Set(normalized)];
}

function normalizePath(value, baseDir) {
  const text = String(value || "").trim();
  if (!text) {
    return null;
  }
  return path.isAbsolute(text) ? text : path.resolve(baseDir, text);
}

function resolveDefault(value) {
  return typeof value === "function" ? value() : value;
}

function mergeMissingDefaults(settings, defaults) {
  let changed = false;
  const models = { ...settings.models };
  for (const [id, model] of Object.entries(defaults.models || {})) {
    if (!models[id]) {
      models[id] = model;
      changed = true;
      continue;
    }
    if (
      id === "codex-gpt-5.5" &&
      arraysEqual(models[id].capabilities, ["chat", "code", "vision"]) &&
      arraysEqual(model.capabilities, ["chat", "code"])
    ) {
      models[id] = {
        ...models[id],
        capabilities: model.capabilities,
      };
      changed = true;
    }
  }

  return {
    changed,
    settings: {
      ...settings,
      models,
    },
  };
}

function arraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}
