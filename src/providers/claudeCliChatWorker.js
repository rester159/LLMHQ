import fs from "node:fs/promises";
import { messagesToPrompt } from "../chatPayload.js";
import { ProviderError } from "../errors.js";
import { runCli } from "./cliProcess.js";

export class ClaudeCliChatWorker {
  constructor({ id, command = "claude", profileDir = null, timeoutMs = 180000 }) {
    this.id = id;
    this.command = command;
    this.profileDir = profileDir;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
  }

  async health() {
    return {
      id: this.id,
      status: "configured",
      command: this.command,
      profileDir: this.profileDir,
      capabilities: ["chat", "vision"],
    };
  }

  async generateChat({ messages, model, onStatus }) {
    return this.#runExclusive(async () => {
      if (this.profileDir) {
        onStatus?.("profile_ready", `Preparing ${this.id} profile.`);
        await fs.mkdir(this.profileDir, { recursive: true });
      }

      const prompt = messagesToPrompt(messages);
      const args = ["-p", "--output-format", "json", "--model", model.cliModel, "--tools", ""];
      onStatus?.("provider_running", `Waiting for Claude CLI response from ${this.id}.`);
      const result = await runCli({
        command: this.command,
        args,
        input: prompt,
        env: this.profileDir
          ? {
              HOME: this.profileDir,
              USERPROFILE: this.profileDir,
            }
          : {},
        timeoutMs: this.timeoutMs,
      });

      onStatus?.("response_received", `Received Claude CLI response from ${this.id}.`);
      return {
        content: parseClaudeOutput(result.stdout),
        providerMetadata: {
          worker: this.id,
          cli: "claude",
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

function parseClaudeOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new ProviderError("empty_response", "Claude CLI returned an empty response.");
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
    if (typeof parsed.result === "string") {
      return parsed.result;
    }
    if (typeof parsed.response === "string") {
      return parsed.response;
    }
    if (Array.isArray(parsed.content)) {
      return parsed.content.map((part) => part.text || "").join("");
    }
    if (Array.isArray(parsed.message?.content)) {
      return parsed.message.content.map((part) => part.text || "").join("");
    }
    if (typeof parsed.message?.content === "string") {
      return parsed.message.content;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}
