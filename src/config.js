import fs from "node:fs";
import path from "node:path";

function boolFromEnv(value, defaultValue = false) {
  if (value == null || value === "") {
    return defaultValue;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function intFromEnv(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function loadConfig(env = process.env) {
  const rootDir = process.cwd();
  const mergedEnv = { ...loadEnvFile(rootDir), ...env };
  const apiKeys = (mergedEnv.LLMHQ_API_KEYS || "dev-local-key")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    host: mergedEnv.LLMHQ_HOST || "127.0.0.1",
    port: intFromEnv(mergedEnv.LLMHQ_PORT, 8080),
    authMode: mergedEnv.LLMHQ_AUTH_MODE || "token",
    apiKeys,
    assetDir: path.resolve(rootDir, mergedEnv.LLMHQ_ASSET_DIR || "./data/assets"),
    conversationDir: path.resolve(rootDir, mergedEnv.LLMHQ_CONVERSATION_DIR || "./data/conversations"),
    settingsFile: path.resolve(rootDir, mergedEnv.LLMHQ_SETTINGS_FILE || "./data/settings.json"),
    chat: {
      defaultModel: mergedEnv.LLMHQ_DEFAULT_CHAT_MODEL || "claude-sonnet",
      timeoutMs: intFromEnv(mergedEnv.LLMHQ_CHAT_TIMEOUT_MS, 180000),
      maxConversationMessages: intFromEnv(mergedEnv.LLMHQ_MAX_CONVERSATION_MESSAGES, 60),
    },
    claude: {
      enabled: boolFromEnv(mergedEnv.LLMHQ_CLAUDE_ENABLED, false),
      command: mergedEnv.LLMHQ_CLAUDE_COMMAND || "claude",
      timeoutMs: intFromEnv(
        mergedEnv.LLMHQ_CLAUDE_TIMEOUT_MS,
        intFromEnv(mergedEnv.LLMHQ_CHAT_TIMEOUT_MS, 180000),
      ),
      workers: parseWorkerSpecs(mergedEnv.LLMHQ_CLAUDE_WORKERS, rootDir),
      models: {
        haiku: mergedEnv.LLMHQ_CLAUDE_HAIKU_MODEL || "haiku",
        sonnet: mergedEnv.LLMHQ_CLAUDE_SONNET_MODEL || "sonnet",
        opus: mergedEnv.LLMHQ_CLAUDE_OPUS_MODEL || "opus",
      },
    },
    codex: {
      enabled: boolFromEnv(mergedEnv.LLMHQ_CODEX_ENABLED, false),
      command: mergedEnv.LLMHQ_CODEX_COMMAND || "codex",
      timeoutMs: intFromEnv(
        mergedEnv.LLMHQ_CODEX_TIMEOUT_MS,
        intFromEnv(mergedEnv.LLMHQ_CHAT_TIMEOUT_MS, 180000),
      ),
      workdir: path.resolve(rootDir, mergedEnv.LLMHQ_CODEX_WORKDIR || "."),
      workers: parseWorkerSpecs(mergedEnv.LLMHQ_CODEX_WORKERS, rootDir),
      model: mergedEnv.LLMHQ_CODEX_MODEL || "gpt-5.5",
    },
    chatgpt: {
      enabled: boolFromEnv(mergedEnv.LLMHQ_EXPERIMENTAL_CHATGPT_BROWSER, false),
      profileDir: path.resolve(
        rootDir,
        mergedEnv.LLMHQ_CHATGPT_PROFILE_DIR || "./data/browser-profiles/chatgpt-main",
      ),
      headless: boolFromEnv(mergedEnv.LLMHQ_CHATGPT_HEADLESS, false),
      timeoutMs: intFromEnv(mergedEnv.LLMHQ_CHATGPT_TIMEOUT_MS, 180000),
      url: mergedEnv.LLMHQ_CHATGPT_URL || "https://chatgpt.com/",
    },
  };
}

function loadEnvFile(rootDir) {
  const filePath = path.join(rootDir, ".env");
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const entries = {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries[key] = value;
  }
  return entries;
}

function parseWorkerSpecs(value, rootDir) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, profileDir] = entry.split("=").map((part) => part.trim());
      return {
        id,
        profileDir: profileDir ? path.resolve(rootDir, profileDir) : null,
      };
    });
}
