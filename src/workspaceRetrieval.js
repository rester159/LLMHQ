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

async function fetchProvider(fetchImpl, source, token, body) {
  const baseUrl = normalizeBaseUrl(source.base_url);
  const workspaceId = encodeURIComponent(source.workspace_id || "");
  if (!baseUrl || !workspaceId) {
    return { chunks: [] };
  }
  const response = await fetchImpl(`${baseUrl}/internal/llmhq/workspaces/${workspaceId}/retrieve`, {
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
