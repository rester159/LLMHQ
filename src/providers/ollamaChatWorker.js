import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ProviderError } from "../errors.js";

export class OllamaChatWorker {
  constructor({ id = "ollama-local", baseUrl = "http://127.0.0.1:11434", timeoutMs = 180000, fetchImpl = fetch }) {
    this.id = id;
    this.baseUrl = String(baseUrl || "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.failureDomain = `ollama:${this.baseUrl}`;
    this.queue = Promise.resolve();
  }

  async health() {
    return {
      id: this.id,
      status: "configured",
      command: "ollama-http",
      baseUrl: this.baseUrl,
      failure_domain: this.failureDomain,
      capabilities: ["chat", "local"],
    };
  }

  async generateChat({ messages, model, temperature, maxTokens, onStatus }) {
    return this.#runExclusive(async () => {
      onStatus?.("provider_running", `Waiting for Ollama response from ${this.id}.`, {
        base_url: this.baseUrl,
        native_model: model.cliModel,
      });

      const payload = {
        model: model.cliModel,
        messages: await toOllamaMessages(messages),
        stream: false,
      };
      const options = {};
      if (Number.isFinite(Number(temperature))) {
        options.temperature = Number(temperature);
      }
      if (Number.isFinite(Number(maxTokens))) {
        options.num_predict = Number(maxTokens);
      }
      if (Object.keys(options).length) {
        payload.options = options;
      }

      const started = Date.now();
      let response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        timeoutMs: this.timeoutMs,
      });
      let raw = await response.text();
      let parsed = parseJson(raw);
      let sourceEndpoint = "chat";
      if (!response.ok && ollamaModelRequired(parsed, raw)) {
        response = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: model.cliModel,
            prompt: messagesToPrompt(messages),
            stream: false,
            ...(Object.keys(options).length ? { options } : {}),
          }),
          timeoutMs: this.timeoutMs,
        });
        raw = await response.text();
        parsed = parseJson(raw);
        sourceEndpoint = "generate";
      }
      if (!response.ok) {
        throw classifyOllamaFailure(response.status, parsed, raw, model.cliModel);
      }

      const content = parsed?.message?.content || parsed?.response || "";
      if (!String(content).trim()) {
        throw new ProviderError("empty_response", "Ollama returned an empty response.", {
          output: raw.slice(0, 2000),
        });
      }

      onStatus?.("response_received", `Received Ollama response from ${this.id}.`, {
        elapsed_ms: Date.now() - started,
      });
      return {
        content,
        providerMetadata: {
          worker: this.id,
          provider: "ollama",
          baseUrl: this.baseUrl,
          nativeModel: model.cliModel,
          endpoint: sourceEndpoint,
          totalDuration: parsed?.total_duration || null,
          loadDuration: parsed?.load_duration || null,
          promptEvalCount: parsed?.prompt_eval_count || null,
          evalCount: parsed?.eval_count || null,
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

async function fetchWithTimeout(fetchImpl, url, { timeoutMs, ...options }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderError("worker_timeout", `Ollama worker timed out after ${timeoutMs}ms.`);
    }
    throw new ProviderError("provider_error", `Ollama request failed: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function toOllamaMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProviderError("invalid_request", "messages must be a non-empty array.");
  }
  return Promise.all(messages.map(toOllamaMessage));
}

async function toOllamaMessage(message) {
  const role = ["system", "user", "assistant"].includes(message?.role) ? message.role : "user";
  const content = message?.content;
  if (!Array.isArray(content)) {
    return {
      role,
      content: content == null ? "" : String(content),
    };
  }

  const text = [];
  const images = [];
  for (const part of content) {
    if (part?.type === "text") {
      text.push(part.text || "");
      continue;
    }
    if (part?.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) {
        images.push(await imageToBase64(url));
      }
      continue;
    }
    text.push(part?.text || JSON.stringify(part));
  }

  return {
    role,
    content: text.filter(Boolean).join("\n"),
    ...(images.length ? { images } : {}),
  };
}

async function imageToBase64(url) {
  if (url.startsWith("data:")) {
    const separator = url.indexOf(",");
    if (separator === -1 || !url.slice(0, separator).includes(";base64")) {
      throw new ProviderError("invalid_request", "Ollama image data URLs must be base64 encoded.");
    }
    return url.slice(separator + 1);
  }

  if (/^https?:\/\//i.test(url)) {
    throw new ProviderError(
      "invalid_request",
      "Ollama image inputs must be local file paths, file:// URLs, or base64 data URLs.",
    );
  }

  const filePath = url.startsWith("file://") ? fileURLToPath(url) : url;
  return (await fs.readFile(filePath)).toString("base64");
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function ollamaModelRequired(parsed, raw) {
  const message = parsed?.error || raw || "";
  return String(message).toLowerCase().includes("model is required");
}

function messagesToPrompt(messages) {
  return messages
    .map((message) => {
      const role = ["system", "user", "assistant"].includes(message?.role) ? message.role : "user";
      return `${role}: ${contentToText(message?.content)}`;
    })
    .join("\n");
}

function contentToText(content) {
  if (!Array.isArray(content)) {
    return content == null ? "" : String(content);
  }
  return content
    .map((part) => {
      if (part?.type === "text") {
        return part.text || "";
      }
      if (part?.text) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function classifyOllamaFailure(status, parsed, raw, nativeModel) {
  const message = parsed?.error || raw || `Ollama returned HTTP ${status}.`;
  const lower = String(message).toLowerCase();
  if (status === 404 || lower.includes("not found") || lower.includes("pull model")) {
    return new ProviderError(
      "model_not_installed",
      `Ollama model ${nativeModel} is not installed. Pull it inside the Ollama container, then retry.`,
      {
        status,
        nativeModel,
        output: String(message).slice(0, 2000),
      },
    );
  }
  return new ProviderError("provider_error", `Ollama failed: ${message}`, {
    status,
    output: String(message).slice(0, 2000),
  });
}
