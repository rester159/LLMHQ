import fs from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { runCli } from "../src/providers/cliProcess.js";

const config = loadConfig();

console.log("LLMHQ doctor");
console.log(`host=${config.host}`);
console.log(`port=${config.port}`);
console.log(`authMode=${config.authMode}`);
console.log(`assetDir=${config.assetDir}`);

await checkDirectory("assetDir", config.assetDir);

if (config.claude.enabled) {
  await checkCommand("claude", config.claude.command, ["--version"]);
  console.log(`claude workers=${config.claude.workers.map((worker) => worker.id).join(", ") || "claude-local"}`);
}

if (config.codex.enabled) {
  await checkCommand("codex", config.codex.command, ["--version"]);
  console.log(`codex workers=${config.codex.workers.map((worker) => worker.id).join(", ") || "codex-local"}`);
}

if (config.chatgpt.enabled) {
  await checkDirectory("chatgptProfile", config.chatgpt.profileDir);
  console.log("chatgpt browser worker=enabled");
}

console.log("doctor complete");

async function checkDirectory(label, directory) {
  await fs.mkdir(directory, { recursive: true });
  console.log(`${label}=ok`);
}

async function checkCommand(label, command, args) {
  try {
    const result = await runCli({ command, args, timeoutMs: 30000 });
    const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0];
    console.log(`${label}=ok ${version}`);
  } catch (error) {
    console.log(`${label}=failed ${error.message}`);
    if (error.details?.output) {
      console.log(error.details.output);
    }
  }
}
