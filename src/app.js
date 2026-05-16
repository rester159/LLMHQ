import { AssetStore } from "./assets.js";
import { authenticateRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  ConversationStore,
  conversationContextMessages,
  extractConversationInputMessages,
} from "./conversations.js";
import { ProviderError, toProviderError } from "./errors.js";
import { ChatGptImageBrowserWorker } from "./providers/chatgptImageBrowserWorker.js";
import { FakeChatWorker } from "./providers/fakeChatWorker.js";
import { FakeImageWorker } from "./providers/fakeImageWorker.js";
import { createModelRegistry } from "./registry.js";

export async function buildApp({
  fastify,
  config = loadConfig(),
  registry = null,
  assetStore = null,
  conversationStore = null,
} = {}) {
  const app = fastify || (await import("fastify")).default({ logger: true });
  const store = assetStore || new AssetStore(config.assetDir);
  const conversations = conversationStore || new ConversationStore(config.conversationDir);
  const activeRegistry =
    registry ||
    createModelRegistry({
      chatgptWorker: config.chatgpt.enabled ? new ChatGptImageBrowserWorker(config.chatgpt) : null,
      fakeWorker: new FakeImageWorker(),
      enableFake: process.env.NODE_ENV === "test",
      claude: config.claude,
      codex: config.codex,
      fakeChatModels:
        process.env.NODE_ENV === "test"
          ? [
              {
                id: "fake-chat",
                workers: [new FakeChatWorker({ id: "fake-chat", response: "fake response" })],
                fallback: [],
              },
            ]
          : null,
    });

  app.addHook("preHandler", authenticateRequest({ apiKeys: config.apiKeys, authMode: config.authMode }));

  app.get("/health", async () => {
    return {
      status: "ok",
      auth_mode: config.authMode,
      providers: await activeRegistry.health(),
    };
  });

  app.get("/v1/models", async () => {
    return {
      object: "list",
      data: [...activeRegistry.models.values()].map((model) => ({
        id: model.id,
        object: "model",
        capabilities: model.capabilities,
        output: model.output,
        fallback: model.fallback,
      })),
    };
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body || {};

    try {
      const response = await runChatCompletion({ activeRegistry, config, body, messages: body.messages });

      if (body.stream) {
        return sendChatCompletionStream(reply, response);
      }

      return reply.send(response);
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/v1/conversations", async (request, reply) => {
    try {
      const body = request.body || {};
      const { conversation, created } = await conversations.create({
        projectId: body.project_id,
        conversationKey: body.conversation_key,
        title: body.title,
        defaultModel: body.default_model,
        metadata: body.metadata,
      });
      return reply.code(created ? 201 : 200).send({
        conversation: conversations.summarize(conversation),
        created,
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.get("/v1/conversations", async (request) => {
    const projectId = request.query?.project_id || null;
    const rows = await conversations.list({ projectId });
    return {
      object: "list",
      data: rows.map((conversation) => conversations.summarize(conversation)),
    };
  });

  app.get("/v1/conversations/:conversationId", async (request, reply) => {
    try {
      const conversation = await conversations.require(request.params.conversationId);
      return reply.send({
        conversation: conversations.summarize(conversation),
        messages: conversation.messages,
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/v1/conversations/:conversationId/messages", async (request, reply) => {
    try {
      const body = request.body || {};
      const conversation = await conversations.require(request.params.conversationId);
      const result = await runConversationTurn({
        activeRegistry,
        config,
        conversations,
        conversation,
        body,
      });
      return reply.send(result);
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/v1/conversations/messages", async (request, reply) => {
    try {
      const body = request.body || {};
      const { conversation } = await conversations.getOrCreate({
        projectId: body.project_id,
        conversationKey: body.conversation_key,
        conversationId: body.conversation_id,
        title: body.title,
        defaultModel: body.default_model,
        metadata: body.metadata,
      });
      const result = await runConversationTurn({
        activeRegistry,
        config,
        conversations,
        conversation,
        body,
      });
      return reply.send(result);
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/v1/images/generations", async (request, reply) => {
    const body = request.body || {};
    const modelId = body.model || "chatgpt-image-browser";
    const prompt = body.prompt;
    const attempts = [];

    try {
      const initialModel = activeRegistry.get(modelId);
      const result = await tryModelWithFallbacks(activeRegistry, initialModel, {
        method: "generateImage",
        input: { prompt },
        attempts,
        fallbackPolicy: body.fallback ?? "default",
      });
      const asset = await store.saveImage({
        bytes: result.bytes,
        mimeType: result.mimeType,
        metadata: {
          model: result.usedModel,
          requestedModel: modelId,
          provider: result.providerMetadata,
        },
      });

      return reply.send({
        created: Math.floor(Date.now() / 1000),
        model: result.usedModel,
        requested_model: modelId,
        fallback_used: result.usedModel !== modelId,
        fallback_reason: firstFailureReason(attempts),
        attempts,
        data: [
          {
            asset_id: asset.id,
            url: `/v1/assets/${asset.id}`,
            mime_type: asset.mimeType,
          },
        ],
      });
    } catch (error) {
      const providerError = toProviderError(error);
      const status = providerError.code === "unknown_model" || providerError.code === "invalid_request" ? 400 : 503;
      return reply.code(status).send({
        error: {
          code: providerError.code,
          message: providerError.message,
          details: providerError.details,
          attempts,
        },
      });
    }
  });

  app.get("/v1/assets/:assetId", async (request, reply) => {
    const asset = await store.get(request.params.assetId);
    if (!asset) {
      return reply.code(404).send({
        error: {
          code: "asset_not_found",
          message: "Asset not found.",
        },
      });
    }

    return reply.type(asset.mimeType).sendFile
      ? reply.type(asset.mimeType).sendFile(asset.filePath)
      : reply.type(asset.mimeType).send(await import("node:fs/promises").then((fs) => fs.readFile(asset.filePath)));
  });

  return app;
}

async function runConversationTurn({ activeRegistry, config, conversations, conversation, body }) {
  const inputMessages = extractConversationInputMessages(body);
  const model = body.model || conversation.default_model || config.chat?.defaultModel || activeRegistry.defaultModel("chat");
  const contextMessages = conversationContextMessages(
    conversation,
    inputMessages,
    config.chat?.maxConversationMessages || 60,
  );
  const completion = await runChatCompletion({
    activeRegistry,
    config,
    body: {
      ...body,
      model,
      messages: contextMessages,
    },
    messages: contextMessages,
  });
  const updated = await conversations.appendTurn(conversation.id, {
    inputMessages,
    assistantMessage: completion.choices[0].message,
    completion,
  });

  return {
    conversation: conversations.summarize(updated),
    chat_completion: {
      ...completion,
      conversation_id: updated.id,
      project_id: updated.project_id,
      conversation_key: updated.conversation_key,
    },
  };
}

async function runChatCompletion({ activeRegistry, config, body, messages }) {
  const requestedModel = body.model || config.chat?.defaultModel || activeRegistry.defaultModel("chat");
  const attempts = [];

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProviderError("invalid_request", "messages must be a non-empty array.");
  }

  const initialModel = activeRegistry.get(requestedModel);
  if (initialModel.kind !== "chat") {
    throw new ProviderError("invalid_request", `${requestedModel} is not a chat model.`);
  }

  const result = await tryModelWithFallbacks(activeRegistry, initialModel, {
    method: "generateChat",
    input: {
      messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    },
    attempts,
    fallbackPolicy: body.fallback ?? "default",
  });

  return createChatCompletionResponse({
    requestedModel,
    result,
    attempts,
  });
}

async function tryModelWithFallbacks(registry, model, { method, input, attempts, fallbackPolicy }) {
  const candidateIds = candidateModelIds(model, fallbackPolicy);
  let lastError = null;

  for (const candidateId of candidateIds) {
    const candidate = registry.get(candidateId);
    const workers = orderedWorkers(candidate);

    for (const worker of workers) {
      try {
        attempts.push({ model: candidate.id, worker: worker.id, status: "started" });
        const result = await worker[method]({ ...input, model: candidate });
        attempts[attempts.length - 1] = { model: candidate.id, worker: worker.id, status: "succeeded" };
        return {
          ...result,
          usedModel: candidate.id,
          usedWorker: worker.id,
        };
      } catch (error) {
        const providerError = toProviderError(error);
        attempts[attempts.length - 1] = {
          model: candidate.id,
          worker: worker.id,
          status: "failed",
          code: providerError.code,
          message: providerError.message,
        };
        lastError = providerError;
      }
    }
  }

  if (lastError) {
    lastError.details = { ...lastError.details, attempts };
    throw lastError;
  }
  throw new ProviderError("provider_error", "No provider succeeded.", { attempts });
}

function candidateModelIds(model, fallbackPolicy) {
  if (fallbackPolicy === false || fallbackPolicy === "none") {
    return [model.id];
  }
  const fallbacks =
    Array.isArray(fallbackPolicy) && fallbackPolicy.length
      ? fallbackPolicy
      : typeof fallbackPolicy === "string" && fallbackPolicy !== "default"
        ? [fallbackPolicy]
        : model.fallback || [];
  return [...new Set([model.id, ...fallbacks])];
}

function orderedWorkers(model) {
  const workers = model.workers || [model.worker];
  if (workers.length <= 1) {
    return workers;
  }
  const start = model.nextWorkerIndex || 0;
  model.nextWorkerIndex = (start + 1) % workers.length;
  return [...workers.slice(start), ...workers.slice(0, start)];
}

function createChatCompletionResponse({ requestedModel, result, attempts }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl_${cryptoRandomId()}`,
    object: "chat.completion",
    created: now,
    model: result.usedModel,
    requested_model: requestedModel,
    used_model: result.usedModel,
    used_worker: result.usedWorker,
    fallback_used: result.usedModel !== requestedModel,
    fallback_reason: firstFailureReason(attempts),
    attempts,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.content,
        },
        finish_reason: "stop",
      },
    ],
    usage: null,
  };
}

function sendChatCompletionStream(reply, response) {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const chunk = {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created,
    model: response.model,
    requested_model: response.requested_model,
    used_model: response.used_model,
    fallback_used: response.fallback_used,
    fallback_reason: response.fallback_reason,
    attempts: response.attempts,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: response.choices[0].message.content,
        },
        finish_reason: null,
      },
    ],
  };

  reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
  reply.raw.write(
    `data: ${JSON.stringify({
      id: response.id,
      object: "chat.completion.chunk",
      created: response.created,
      model: response.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
}

function firstFailureReason(attempts) {
  const failed = attempts.find((attempt) => attempt.status === "failed");
  return failed ? `${failed.model}/${failed.worker}: ${failed.code}` : null;
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sendProviderError(reply, error) {
  const providerError = toProviderError(error);
  const status =
    providerError.code === "conversation_not_found"
      ? 404
      : providerError.code === "unknown_model" ||
          providerError.code === "invalid_request" ||
          providerError.code === "no_model_configured"
        ? 400
        : 503;
  return reply.code(status).send({
    error: {
      code: providerError.code,
      message: providerError.message,
      details: providerError.details,
      attempts: providerError.details?.attempts || [],
    },
  });
}
