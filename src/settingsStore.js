import fs from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "./errors.js";

const MODEL_DEFAULTS = {
  "claude-haiku": {
    provider: "claude",
    cliModelKey: "haiku",
    cliModel: "haiku",
    capabilities: ["chat", "vision", "fast"],
    fallback: ["claude-sonnet", "codex-gpt-5.5"],
  },
  "claude-sonnet": {
    provider: "claude",
    cliModelKey: "sonnet",
    cliModel: "sonnet",
    capabilities: ["chat", "vision", "smart"],
    fallback: ["codex-gpt-5.5"],
  },
  "claude-opus": {
    provider: "claude",
    cliModelKey: "opus",
    cliModel: "opus",
    capabilities: ["chat", "vision", "deep_reasoning"],
    fallback: ["claude-sonnet", "codex-gpt-5.5"],
  },
  "codex-gpt-5.5": {
    provider: "codex",
    cliModelKey: "model",
    cliModel: "gpt-5.5",
    capabilities: ["chat", "code", "vision"],
    fallback: ["claude-sonnet"],
  },
};

const PROVIDERS = new Set(["claude", "codex"]);

export class SettingsStore {
  constructor({ filePath, defaultSettings }) {
    this.filePath = filePath;
    this.defaultSettings = defaultSettings;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      return normalizeSettings(parsed, { baseDir: path.dirname(this.filePath) });
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
  const models = {};

  for (const [id, defaults] of Object.entries(MODEL_DEFAULTS)) {
    const providerEnabled = defaults.provider === "claude" ? claudeEnabled : codexEnabled;
    const providerConfig = defaults.provider === "claude" ? config.claude : config.codex;
    const configuredCliModel =
      defaults.provider === "claude"
        ? providerConfig?.models?.[defaults.cliModelKey]
        : providerConfig?.[defaults.cliModelKey];

    models[id] = {
      enabled: providerEnabled,
      provider: defaults.provider,
      cliModel: configuredCliModel || defaults.cliModel,
      capabilities: defaults.capabilities,
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

    const provider = String(rawModel.provider || "").trim();
    if (!PROVIDERS.has(provider)) {
      throw new ProviderError("invalid_request", `${id} has unsupported provider: ${provider || "missing"}.`);
    }
    const cliModel = String(rawModel.cliModel || "").trim();
    if (!cliModel) {
      throw new ProviderError("invalid_request", `${id} is missing cliModel.`);
    }

    normalized[id] = {
      enabled: rawModel.enabled !== false,
      provider,
      cliModel,
      capabilities: normalizeStringArray(rawModel.capabilities, ["chat"], `${id}.capabilities`),
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
  if (defaultModel && models[defaultModel]?.enabled) {
    return defaultModel;
  }

  const firstEnabled = Object.entries(models).find(([, model]) => model.enabled);
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
