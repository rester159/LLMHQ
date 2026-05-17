import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ProviderError } from "./errors.js";

const sessions = new Map();
const MAX_OUTPUT_CHARS = 12000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export async function startProviderLogin({ provider, workerId, config, mode = "device" }) {
  if (!["claude", "codex"].includes(provider)) {
    throw new ProviderError("invalid_request", `Unsupported provider login: ${provider || "missing"}.`);
  }
  if (provider === "codex" && mode !== "device") {
    throw new ProviderError("invalid_request", "Codex WebUI login uses device auth.");
  }
  if (provider === "claude" && !["claudeai", "sso", "console"].includes(mode)) {
    throw new ProviderError("invalid_request", "Claude WebUI login mode must be claudeai, sso, or console.");
  }

  const providerConfig = config[provider];
  const worker = findWorker(providerConfig, provider, workerId);
  const existing = findRunningSession(provider, worker.id);
  if (existing) {
    return snapshot(existing);
  }

  if (worker.profileDir) {
    await fs.mkdir(worker.profileDir, { recursive: true });
    if (provider === "codex") {
      await fs.mkdir(path.join(worker.profileDir, ".codex"), { recursive: true });
    }
  }

  const session = {
    id: `login_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    provider,
    worker: worker.id,
    profileDir: worker.profileDir || null,
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: "",
    error: null,
    child: null,
    timer: null,
  };
  sessions.set(session.id, session);

  const command = providerConfig?.command || provider;
  const args = provider === "claude" ? claudeLoginArgs(mode) : ["login", "--device-auth"];
  appendOutput(session, `Starting ${provider} login for ${worker.id}.\n`);
  appendOutput(session, `Profile: ${worker.profileDir || "default"}\n`);
  appendOutput(session, `Mode: ${mode}\n`);

  const shell = shouldUseShell(command);
  const child = spawn(shell ? buildShellCommand(command, args) : command, shell ? [] : args, {
    cwd: process.cwd(),
    env: providerLoginEnv(provider, worker),
    shell,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.child = child;
  session.timer = setTimeout(() => {
    if (session.status === "running") {
      appendOutput(session, "\nLogin timed out. Start a new device login if the code expired.\n");
      session.status = "timeout";
      session.finishedAt = new Date().toISOString();
      session.updatedAt = session.finishedAt;
      child.kill("SIGKILL");
    }
  }, LOGIN_TIMEOUT_MS);

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => appendOutput(session, chunk));
  child.stderr.on("data", (chunk) => appendOutput(session, chunk));
  child.on("error", (error) => {
    session.status = "failed";
    session.error = error.message;
    session.finishedAt = new Date().toISOString();
    session.updatedAt = session.finishedAt;
    appendOutput(session, `\nFailed to start Codex login: ${error.message}\n`);
    clearTimeout(session.timer);
  });
  child.on("close", (code) => {
    if (session.status === "timeout") {
      clearTimeout(session.timer);
      return;
    }
    session.exitCode = code;
    session.status = code === 0 ? "completed" : "failed";
    session.finishedAt = new Date().toISOString();
    session.updatedAt = session.finishedAt;
    appendOutput(session, `\n${provider} login ${session.status} with exit code ${code}.\n`);
    clearTimeout(session.timer);
  });

  return snapshot(session);
}

export function getProviderLoginSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new ProviderError("login_session_not_found", `Login session not found: ${sessionId}`);
  }
  return snapshot(session);
}

function shouldUseShell(command) {
  if (process.platform !== "win32") {
    return false;
  }
  return !command.toLowerCase().endsWith(".exe");
}

function buildShellCommand(command, args) {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function claudeLoginArgs(mode) {
  const args = ["auth", "login"];
  if (mode === "console") {
    args.push("--console");
  } else {
    args.push("--claudeai");
  }
  if (mode === "sso") {
    args.push("--sso");
  }
  return args;
}

function providerLoginEnv(provider, worker) {
  if (!worker.profileDir) {
    return process.env;
  }
  if (provider === "codex") {
    return {
      ...process.env,
      CODEX_HOME: worker.profileDir,
      HOME: worker.profileDir,
      USERPROFILE: worker.profileDir,
    };
  }
  return {
    ...process.env,
    HOME: worker.profileDir,
    USERPROFILE: worker.profileDir,
  };
}

function quoteShellArg(value) {
  const text = String(value);
  if (text === "") {
    return '""';
  }
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}

function findWorker(providerConfig, provider, workerId) {
  const workers = providerConfig?.workers?.length
    ? providerConfig.workers
    : [{ id: `${provider}-local`, profileDir: null }];
  const worker = workerId ? workers.find((candidate) => candidate.id === workerId) : workers[0];
  if (!worker) {
    throw new ProviderError(
      "invalid_request",
      `Unknown ${provider} worker: ${workerId}. Known workers: ${workers.map((candidate) => candidate.id).join(", ")}`,
    );
  }
  return worker;
}

function findRunningSession(provider, workerId) {
  for (const session of sessions.values()) {
    if (session.provider === provider && session.worker === workerId && session.status === "running") {
      return session;
    }
  }
  return null;
}

function appendOutput(session, chunk) {
  session.output = sanitizeLoginOutput(`${session.output}${chunk}`).slice(-MAX_OUTPUT_CHARS);
  session.updatedAt = new Date().toISOString();
}

function sanitizeLoginOutput(value) {
  return String(value || "")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[jwt-redacted]");
}

function snapshot(session) {
  return {
    id: session.id,
    provider: session.provider,
    worker: session.worker,
    profileDir: session.profileDir,
    mode: session.mode,
    status: session.status,
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    finished_at: session.finishedAt,
    exit_code: session.exitCode,
    output: session.output,
    error: session.error,
  };
}
