import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { ProviderError } from "./errors.js";

const TOKEN_PREFIX = "ws_live_";

export class WorkspaceStore {
  constructor(workspaceDir) {
    this.workspaceDir = workspaceDir;
  }

  async register(input) {
    const now = new Date().toISOString();
    const identity = normalizeIdentity(input);
    const existing = await this.findByIdentity(identity);
    const token = existing?.workspace_token || `${TOKEN_PREFIX}${randomUUID()}`;
    const workspace = {
      ...(existing || {}),
      ...identity,
      workspace_token: token,
      workspace_type: normalizeRequired(input.workspace_type, "workspace_type"),
      display_name: input.display_name == null ? null : String(input.display_name),
      sources: normalizeSources(input.sources),
      permissions: normalizePermissions(input.permissions),
      metadata: isPlainObject(input.metadata) ? input.metadata : {},
      status: "registered",
      index_status: existing?.index_status || "not_indexed",
      source_version: existing?.source_version || null,
      created_at: existing?.created_at || now,
      updated_at: now,
      revoked_at: null,
    };
    await this.#write(workspace);
    return { workspace, created: !existing };
  }

  async getByToken(token) {
    const normalized = normalizeRequired(token, "workspace_token");
    if (!normalized.startsWith(TOKEN_PREFIX)) {
      return null;
    }
    const filePath = this.#filePathForToken(normalized);
    const raw = await fs.readFile(filePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return raw ? JSON.parse(raw) : null;
  }

  async requireByToken(token) {
    const workspace = await this.getByToken(token);
    if (!workspace || workspace.revoked_at) {
      throw new ProviderError("workspace_not_found", "Workspace token is invalid or revoked.");
    }
    return workspace;
  }

  async refresh(token, input = {}) {
    const workspace = await this.requireByToken(token);
    const now = new Date().toISOString();
    const refreshed = {
      ...workspace,
      status: "registered",
      index_status: "queued",
      source_version: isPlainObject(input.source_version) ? input.source_version : workspace.source_version,
      last_refresh: {
        reason: input.reason == null ? null : String(input.reason),
        changed_paths: Array.isArray(input.changed_paths) ? input.changed_paths.map(String) : [],
        priority: input.priority == null ? null : String(input.priority),
        refreshed_at: now,
      },
      updated_at: now,
    };
    await this.#write(refreshed);
    return refreshed;
  }

  async findByIdentity(identity) {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    const entries = await fs.readdir(this.workspaceDir).catch(() => []);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const raw = await fs.readFile(path.join(this.workspaceDir, entry), "utf8");
      const workspace = JSON.parse(raw);
      if (
        workspace.app_id === identity.app_id &&
        workspace.tenant_id === identity.tenant_id &&
        workspace.owner_subject === identity.owner_subject &&
        workspace.workspace_id === identity.workspace_id
      ) {
        return workspace;
      }
    }
    return null;
  }

  summarize(workspace) {
    return {
      workspace_token: workspace.workspace_token,
      app_id: workspace.app_id,
      tenant_id: workspace.tenant_id,
      owner_subject: workspace.owner_subject,
      workspace_id: workspace.workspace_id,
      workspace_type: workspace.workspace_type,
      display_name: workspace.display_name,
      status: workspace.status,
      index_status: workspace.index_status,
      source_count: Array.isArray(workspace.sources) ? workspace.sources.length : 0,
      permissions: workspace.permissions,
      metadata: workspace.metadata,
      source_version: workspace.source_version,
      created_at: workspace.created_at,
      updated_at: workspace.updated_at,
      revoked_at: workspace.revoked_at || null,
    };
  }

  #filePathForToken(token) {
    return path.join(this.workspaceDir, `${hashToken(token)}.json`);
  }

  async #write(workspace) {
    await fs.mkdir(this.workspaceDir, { recursive: true });
    const filePath = this.#filePathForToken(workspace.workspace_token);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(workspace, null, 2));
    await fs.rename(tempPath, filePath);
  }
}

export function normalizeWorkspaceRequest(workspace) {
  if (workspace == null) return null;
  if (!isPlainObject(workspace)) {
    throw new ProviderError("invalid_request", "workspace must be an object.");
  }
  const token = normalizeRequired(workspace.token || workspace.workspace_token, "workspace.token");
  const mode = workspace.mode == null ? "answer" : String(workspace.mode);
  if (!["answer", "agent"].includes(mode)) {
    throw new ProviderError("invalid_request", "workspace.mode must be answer or agent.");
  }
  return {
    token,
    mode,
    retrieval: isPlainObject(workspace.retrieval) ? workspace.retrieval : {},
    execution: isPlainObject(workspace.execution) ? workspace.execution : {},
  };
}

export function assertWorkspaceModeAllowed(workspace, request) {
  if (!request) return;
  const permissions = workspace.permissions || {};
  if (request.mode === "agent") {
    if (!permissions.shell && !permissions.write) {
      throw new ProviderError("workspace_permission_denied", "Workspace does not allow agent execution.");
    }
  }
}

function normalizeIdentity(input) {
  return {
    app_id: normalizeRequired(input.app_id, "app_id"),
    tenant_id: normalizeRequired(input.tenant_id, "tenant_id"),
    owner_subject: input.owner_subject == null ? null : String(input.owner_subject).trim() || null,
    workspace_id: normalizeRequired(input.workspace_id, "workspace_id"),
  };
}

function normalizeSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new ProviderError("invalid_request", "sources must be a non-empty array.");
  }
  return sources.map((source) => {
    if (!isPlainObject(source)) {
      throw new ProviderError("invalid_request", "workspace source must be an object.");
    }
    const type = normalizeRequired(source.type, "source.type");
    return { ...source, type };
  });
}

function normalizePermissions(permissions) {
  const raw = isPlainObject(permissions) ? permissions : {};
  return {
    read: raw.read !== false,
    search: raw.search !== false,
    write: Boolean(raw.write),
    shell: Boolean(raw.shell),
    network: Boolean(raw.network),
    git: isPlainObject(raw.git) ? raw.git : {},
  };
}

function normalizeRequired(value, fieldName) {
  if (value == null || String(value).trim() === "") {
    throw new ProviderError("invalid_request", `${fieldName} is required.`);
  }
  return String(value).trim();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
