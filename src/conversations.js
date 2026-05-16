import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProviderError } from "./errors.js";

export class ConversationStore {
  constructor(conversationDir) {
    this.conversationDir = conversationDir;
  }

  async create({ projectId, conversationKey = null, title = null, defaultModel = null, metadata = {} }) {
    const normalizedProjectId = normalizeRequiredId(projectId, "project_id");
    const now = new Date().toISOString();
    const existing =
      conversationKey == null ? null : await this.findByProjectKey(normalizedProjectId, String(conversationKey));
    if (existing) {
      return { conversation: existing, created: false };
    }

    const conversation = {
      id: `conv_${randomUUID()}`,
      project_id: normalizedProjectId,
      conversation_key: conversationKey == null ? null : String(conversationKey),
      title: title == null ? null : String(title),
      default_model: defaultModel == null ? null : String(defaultModel),
      metadata: isPlainObject(metadata) ? metadata : {},
      messages: [],
      created_at: now,
      updated_at: now,
    };

    await this.#write(conversation);
    return { conversation, created: true };
  }

  async get(conversationId) {
    const id = normalizeRequiredId(conversationId, "conversation_id");
    const filePath = this.#filePath(id);
    const raw = await fs.readFile(filePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    return raw ? JSON.parse(raw) : null;
  }

  async require(conversationId) {
    const conversation = await this.get(conversationId);
    if (!conversation) {
      throw new ProviderError("conversation_not_found", "Conversation not found.");
    }
    return conversation;
  }

  async findByProjectKey(projectId, conversationKey) {
    const normalizedProjectId = normalizeRequiredId(projectId, "project_id");
    const normalizedKey = normalizeRequiredId(conversationKey, "conversation_key");
    const conversations = await this.list({ projectId: normalizedProjectId });
    return (
      conversations.find((conversation) => conversation.conversation_key === normalizedKey) ||
      null
    );
  }

  async getOrCreate(input) {
    if (input.conversationId) {
      return { conversation: await this.require(input.conversationId), created: false };
    }
    return this.create(input);
  }

  async list({ projectId = null } = {}) {
    await fs.mkdir(this.conversationDir, { recursive: true });
    const entries = await fs.readdir(this.conversationDir).catch(() => []);
    const conversations = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) {
        continue;
      }
      const raw = await fs.readFile(path.join(this.conversationDir, entry), "utf8");
      const conversation = JSON.parse(raw);
      if (projectId && conversation.project_id !== projectId) {
        continue;
      }
      conversations.push(conversation);
    }
    conversations.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
    return conversations;
  }

  async appendTurn(conversationId, { inputMessages, assistantMessage, completion }) {
    const conversation = await this.require(conversationId);
    const now = new Date().toISOString();
    const storedInput = inputMessages.map((message) => ({
      id: `msg_${randomUUID()}`,
      role: message.role || "user",
      content: message.content ?? "",
      created_at: now,
    }));
    const storedAssistant = {
      id: `msg_${randomUUID()}`,
      role: "assistant",
      content: assistantMessage.content,
      created_at: now,
      model: completion.used_model,
      requested_model: completion.requested_model,
      used_worker: completion.used_worker,
      fallback_used: completion.fallback_used,
      fallback_reason: completion.fallback_reason,
      attempts: completion.attempts,
    };

    const updated = {
      ...conversation,
      messages: [...conversation.messages, ...storedInput, storedAssistant],
      updated_at: now,
    };
    await this.#write(updated);
    return updated;
  }

  summarize(conversation) {
    return {
      id: conversation.id,
      project_id: conversation.project_id,
      conversation_key: conversation.conversation_key,
      title: conversation.title,
      default_model: conversation.default_model,
      metadata: conversation.metadata,
      message_count: conversation.messages.length,
      created_at: conversation.created_at,
      updated_at: conversation.updated_at,
    };
  }

  async #write(conversation) {
    await fs.mkdir(this.conversationDir, { recursive: true });
    const filePath = this.#filePath(conversation.id);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(conversation, null, 2));
    await fs.rename(tempPath, filePath);
  }

  #filePath(conversationId) {
    if (!/^conv_[a-f0-9-]+$/i.test(conversationId)) {
      throw new ProviderError("invalid_request", "Invalid conversation_id.");
    }
    return path.join(this.conversationDir, `${conversationId}.json`);
  }
}

export function extractConversationInputMessages(body) {
  if (body.message) {
    return [normalizeMessage(body.message)];
  }
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages.map(normalizeMessage);
  }
  throw new ProviderError("invalid_request", "message or non-empty messages is required.");
}

export function conversationContextMessages(conversation, inputMessages, maxMessages) {
  const existing = conversation.messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const combined = [...existing, ...inputMessages];
  if (!maxMessages || combined.length <= maxMessages) {
    return combined;
  }
  const systemMessages = combined.filter((message) => message.role === "system");
  const tail = combined.filter((message) => message.role !== "system").slice(-maxMessages);
  return [...systemMessages.slice(0, 1), ...tail];
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object") {
    throw new ProviderError("invalid_request", "message must be an object.");
  }
  return {
    role: message.role || "user",
    content: message.content ?? "",
  };
}

function normalizeRequiredId(value, fieldName) {
  if (value == null || String(value).trim() === "") {
    throw new ProviderError("invalid_request", `${fieldName} is required.`);
  }
  return String(value).trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
