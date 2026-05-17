import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { loadConfig } from "../src/config.js";

const provider = process.argv[2];
const workerId = process.argv[3];
const config = loadConfig();

if (!["claude", "codex"].includes(provider)) {
  console.error("Usage: node scripts/cli-login.js <claude|codex> [worker-id]");
  process.exit(1);
}

const providerConfig = config[provider];
const workers = providerConfig.workers.length
  ? providerConfig.workers
  : [{ id: `${provider}-local`, profileDir: null }];
const worker = workerId ? workers.find((candidate) => candidate.id === workerId) : workers[0];

if (!worker) {
  console.error(`Unknown ${provider} worker: ${workerId}`);
  console.error(`Known workers: ${workers.map((candidate) => candidate.id).join(", ")}`);
  process.exit(1);
}

if (worker.profileDir) {
  await fs.mkdir(worker.profileDir, { recursive: true });
  if (provider === "codex") {
    await fs.mkdir(`${worker.profileDir}/.codex`, { recursive: true });
  }
}

const command = providerConfig.command;
const loginArgs =
  provider === "claude"
    ? splitArgs(process.env.LLMHQ_CLAUDE_LOGIN_ARGS)
    : splitArgs(process.env.LLMHQ_CODEX_LOGIN_ARGS);
const args = provider === "claude" ? ["auth", "login", ...loginArgs] : ["login", ...loginArgs];
const env =
  provider === "claude" && worker.profileDir
    ? { ...process.env, HOME: worker.profileDir, USERPROFILE: worker.profileDir }
    : provider === "codex" && worker.profileDir
      ? { ...process.env, CODEX_HOME: worker.profileDir, HOME: worker.profileDir, USERPROFILE: worker.profileDir }
      : process.env;

console.log(`Logging in ${provider} worker ${worker.id}`);
if (worker.profileDir) {
  console.log(`Profile: ${worker.profileDir}`);
}

const child = spawn(command, args, {
  stdio: "inherit",
  shell: process.platform === "win32" && !command.toLowerCase().endsWith(".exe"),
  env,
});

child.on("exit", (code) => {
  process.exit(code || 0);
});

function splitArgs(value) {
  if (!value) {
    return [];
  }
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
