import { loadConfig } from "../src/config.js";

const config = loadConfig();
const model = process.argv[2] || config.ollama.defaultModel || "llama3.2";
const baseUrl = String(process.env.LLMHQ_OLLAMA_BASE_URL || config.ollama.baseUrl || "http://127.0.0.1:11434").replace(
  /\/+$/,
  "",
);

console.log(`Pulling Ollama model ${model} from ${baseUrl}`);

const response = await fetch(`${baseUrl}/api/pull`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model, stream: true }),
});

if (!response.ok) {
  const text = await response.text();
  throw new Error(`Ollama pull failed with HTTP ${response.status}: ${text}`);
}

let buffer = "";
let lastStatus = "";
const reader = response.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) {
    break;
  }
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const event = JSON.parse(line);
    if (event.error) {
      throw new Error(event.error);
    }
    const status = event.status || "pulling";
    if (status !== lastStatus) {
      console.log(status);
      lastStatus = status;
    }
  }
}

console.log(`Ollama model ready: ${model}`);
