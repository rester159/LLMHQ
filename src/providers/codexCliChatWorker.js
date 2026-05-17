import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractImageFilePaths, messagesToPrompt } from "../chatPayload.js";
import { ProviderError } from "../errors.js";
import { runCli } from "./cliProcess.js";

export class CodexCliChatWorker {
  constructor({ id, command = "codex", profileDir = null, workdir = process.cwd(), timeoutMs = 180000 }) {
    this.id = id;
    this.command = command;
    this.profileDir = profileDir;
    this.workdir = workdir;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
  }

  async health() {
    return {
      id: this.id,
      status: "configured",
      command: this.command,
      profileDir: this.profileDir,
      workdir: this.workdir,
      capabilities: ["chat", "code", "vision"],
    };
  }

  async generateChat({ messages, model, onStatus }) {
    return this.#runExclusive(async () => {
      if (this.profileDir) {
        onStatus?.("profile_ready", `Preparing ${this.id} profile.`);
        await prepareCodexProfile(this.profileDir);
      }
      onStatus?.("workspace_ready", `Preparing Codex workdir for ${this.id}.`);
      await fs.mkdir(this.workdir, { recursive: true });

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "llmhq-codex-"));
      const outputFile = path.join(tempDir, "last-message.txt");
      const prompt = messagesToPrompt(messages);
      const imageArgs = extractImageFilePaths(messages).flatMap((filePath) => ["--image", filePath]);
      const args = [
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        this.workdir,
        "-m",
        model.cliModel,
        "-o",
        outputFile,
        ...imageArgs,
        "-",
      ];

      onStatus?.("provider_running", `Waiting for Codex CLI response from ${this.id}.`);
      const result = await runCli({
        command: this.command,
        args,
        input: prompt,
        env: this.profileDir
          ? {
              CODEX_HOME: this.profileDir,
              HOME: this.profileDir,
              USERPROFILE: this.profileDir,
            }
          : {},
        cwd: this.workdir,
        timeoutMs: this.timeoutMs,
      });

      onStatus?.("response_received", `Received Codex CLI response from ${this.id}.`);
      const output = await fs.readFile(outputFile, "utf8").catch(() => parseCodexJsonl(result.stdout));
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

      return {
        content: output.trim(),
        providerMetadata: {
          worker: this.id,
          cli: "codex",
          stderr: result.stderr?.slice(0, 1000) || "",
        },
      };
    });
  }

  async #runExclusive(task) {
    const previous = this.queue;
    let release;
    this.queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
    }
  }
}

async function prepareCodexProfile(profileDir) {
  await fs.mkdir(profileDir, { recursive: true });
  const nestedDir = path.join(profileDir, ".codex");
  await fs.mkdir(nestedDir, { recursive: true });
  await mirrorProfileFile(path.join(profileDir, "auth.json"), path.join(nestedDir, "auth.json"));
  await mirrorProfileFile(path.join(profileDir, "config.toml"), path.join(nestedDir, "config.toml"));
}

async function mirrorProfileFile(directPath, nestedPath) {
  const directExists = await fileExists(directPath);
  const nestedExists = await fileExists(nestedPath);
  if (directExists && !nestedExists) {
    await fs.copyFile(directPath, nestedPath);
  } else if (!directExists && nestedExists) {
    await fs.copyFile(nestedPath, directPath);
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

function parseCodexJsonl(stdout) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let lastText = "";
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const text =
        event.message?.content ||
        event.item?.content ||
        event.output_text ||
        event.text ||
        event.delta;
      if (typeof text === "string") {
        lastText = text;
      }
    } catch {
      lastText = line;
    }
  }

  if (!lastText.trim()) {
    throw new ProviderError("empty_response", "Codex CLI returned an empty response.");
  }
  return lastText;
}
