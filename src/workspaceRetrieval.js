import { ProviderError } from "./errors.js";

const DEFAULT_MAX_CHUNKS = 8;
const DEFAULT_MAX_CHARS = 18000;

export async function retrieveWorkspaceContext({ workspace, workspaceRequest, config, query, fetchImpl = fetch }) {
  if (!workspace || !workspaceRequest) {
    return [];
  }
  const retrieval = workspaceRequest.retrieval || {};
  if (retrieval.strategy === "none" || retrieval.enabled === false) {
    return [];
  }
  const maxChunks = clamp(Number(retrieval.max_chunks || retrieval.maxChunks || DEFAULT_MAX_CHUNKS), 1, 20);
  const maxChars = clamp(Number(retrieval.max_chars || retrieval.maxChars || DEFAULT_MAX_CHARS), 2000, 50000);
  const providerSources = (workspace.sources || []).filter((source) => source.type === "app_context_provider");
  const chunks = [];
  for (const source of providerSources) {
    if (chunks.length >= maxChunks) break;
    const token = config.workspaceProviderTokens?.[source.provider_id];
    if (!token) {
      continue;
    }
    const response = await fetchProvider(fetchImpl, source, token, {
      query,
      limits: {
        max_chunks: maxChunks - chunks.length,
        max_chars: maxChars,
      },
    });
    for (const chunk of response.chunks || []) {
      if (chunks.length >= maxChunks) break;
      chunks.push(normalizeChunk(chunk, source));
    }
  }
  return chunks;
}

export function workspaceContextMessage(workspace, chunks) {
  if (!chunks.length) {
    return null;
  }
  const lines = [
    "Workspace context retrieved by LLMHQ. Use this as the authoritative repo/app context for the user's request.",
    `Workspace: ${workspace.display_name || workspace.workspace_id}`,
    `Workspace ID: ${workspace.workspace_id}`,
    "",
  ];
  chunks.forEach((chunk, index) => {
    lines.push(`--- Chunk ${index + 1}: ${chunk.title || chunk.id} ---`);
    lines.push(chunk.content);
    lines.push("");
  });
  return {
    role: "system",
    content: lines.join("\n").trim(),
  };
}

export async function callWorkspaceTool({ workspace, config, tool, input, fetchImpl = fetch }) {
  assertToolAllowed(workspace, tool);
  const source = (workspace.sources || []).find((candidate) => candidate.type === "app_context_provider");
  if (!source) {
    throw new ProviderError("workspace_provider_failed", "Workspace has no app_context_provider source.");
  }
  const token = config.workspaceProviderTokens?.[source.provider_id];
  if (!token) {
    throw new ProviderError("workspace_provider_denied", `No provider token configured for ${source.provider_id}.`);
  }
  return fetchProvider(fetchImpl, source, token, { tool, input: input || {} }, "tools");
}

function assertToolAllowed(workspace, tool) {
  const permissions = workspace.permissions || {};
  if (["list", "read"].includes(tool) && permissions.read === false) {
    throw new ProviderError("workspace_permission_denied", `Workspace does not allow ${tool}.`);
  }
  if (tool === "search" && permissions.search === false) {
    throw new ProviderError("workspace_permission_denied", "Workspace does not allow search.");
  }
  if (tool === "diff" && permissions.git?.diff === false) {
    throw new ProviderError("workspace_permission_denied", "Workspace does not allow diff.");
  }
  if (tool === "apply_patch" && !permissions.write) {
    throw new ProviderError("workspace_permission_denied", "Workspace does not allow writes.");
  }
}

export function workspaceToolInstruction(workspace) {
  return {
    role: "system",
    content: [
      "You can inspect and modify the Riff workspace by requesting one workspace tool call at a time.",
      "Only request apply_patch when the user asked for a code/file change and the workspace allows writes.",
      "When you need a tool, reply with ONLY compact JSON in this shape:",
      "{\"tool\":\"search\",\"input\":{\"query\":\"text\"}}",
      "Available tools:",
      "- list: {path?, max_entries?}",
      "- search: {query, path?, max_results?}",
      "- read: {path, start_line?, max_lines?}",
      "- diff: {}",
      "- apply_patch: {patch}",
      "After tool results give you enough context, answer normally in plain text.",
      "Never quote workspace tool call JSON or internal tool-result messages in your final answer.",
      "Do not invent file contents. Use tools before answering repo-specific questions.",
      `Workspace: ${workspace.display_name || workspace.workspace_id}`
    ].join("\n")
  };
}

export function parseWorkspaceToolCall(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  const jsonText = extractLeadingJsonObject(trimmed);
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== "object" || typeof parsed.tool !== "string") {
      return null;
    }
    if (!["list", "search", "read", "diff", "apply_patch"].includes(parsed.tool)) {
      return null;
    }
    return {
      tool: parsed.tool,
      input: isPlainObject(parsed.input) ? parsed.input : {}
    };
  } catch {
    return null;
  }
}

function extractLeadingJsonObject(content) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(0, index + 1);
    }
  }
  return null;
}

async function fetchProvider(fetchImpl, source, token, body, action = "retrieve") {
  const baseUrl = normalizeBaseUrl(source.base_url);
  const workspaceId = encodeURIComponent(source.workspace_id || "");
  if (!baseUrl || !workspaceId) {
    return { chunks: [] };
  }
  const response = await fetchImpl(`${baseUrl}/internal/llmhq/workspaces/${workspaceId}/${action}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new ProviderError(
      response.status === 401 || response.status === 403 ? "workspace_provider_denied" : "workspace_provider_failed",
      `Workspace provider ${source.provider_id || "unknown"} returned ${response.status}.`,
    );
  }
  return response.json();
}

function normalizeChunk(chunk, source) {
  return {
    id: String(chunk?.id || `${source.provider_id || "provider"}:chunk`),
    kind: String(chunk?.kind || "text"),
    title: chunk?.title == null ? null : String(chunk.title),
    content: String(chunk?.content || ""),
    metadata: {
      provider_id: source.provider_id || null,
      ...(isPlainObject(chunk?.metadata) ? chunk.metadata : {}),
    },
  };
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
