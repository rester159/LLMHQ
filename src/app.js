import { AssetStore } from "./assets.js";
import { authenticateRequest } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  ConversationStore,
  conversationContextMessages,
  extractConversationContext,
  extractConversationInputMessages,
} from "./conversations.js";
import { ProviderError, toProviderError } from "./errors.js";
import { ChatGptImageBrowserWorker } from "./providers/chatgptImageBrowserWorker.js";
import { FakeChatWorker } from "./providers/fakeChatWorker.js";
import { FakeImageWorker } from "./providers/fakeImageWorker.js";
import { getProviderLoginSession, startProviderLogin } from "./providerLogin.js";
import { llmhqInstance } from "./instance.js";
import { createModelRegistry } from "./registry.js";
import { defaultRuntimeSettings, SettingsStore } from "./settingsStore.js";
import { WorkspaceStore, assertWorkspaceModeAllowed, normalizeWorkspaceRequest } from "./workspaces.js";
import { retrieveWorkspaceContext, workspaceContextMessage } from "./workspaceRetrieval.js";

export async function buildApp({
  fastify,
  config = loadConfig(),
  registry = null,
  assetStore = null,
  conversationStore = null,
  workspaceStore = null,
  settingsStore = null,
} = {}) {
  const app = fastify || (await import("fastify")).default({ logger: true });
  const store = assetStore || new AssetStore(config.assetDir);
  const conversations = conversationStore || new ConversationStore(config.conversationDir);
  const workspaces = workspaceStore || new WorkspaceStore(config.workspaceDir || `${config.assetDir}/workspaces`);
  const runtimeSettingsStore =
    settingsStore ||
    new SettingsStore({
      filePath: config.settingsFile,
      defaultSettings: () => defaultRuntimeSettings(config),
    });
  const runtime = {
    settingsStore: runtimeSettingsStore,
    settings: registry ? null : await runtimeSettingsStore.load(),
    registry: null,
    editable: !registry,
  };
  runtime.registry = registry || createRuntimeRegistry(config, runtime.settings);

  app.addHook("preHandler", authenticateRequest({ apiKeys: config.apiKeys, authMode: config.authMode }));

  app.get("/health", async () => {
    return {
      status: "ok",
      instance: llmhqInstance(),
      auth_mode: config.authMode,
      providers: await runtime.registry.health(),
    };
  });

  app.get("/v1/models", async () => {
    return {
      object: "list",
      data: serializeModels(runtime.registry),
    };
  });

  app.post("/v1/workspaces", async (request, reply) => {
    try {
      const { workspace, created } = await workspaces.register(request.body || {});
      return reply.code(created ? 201 : 200).send({
        workspace: workspaces.summarize(workspace),
        workspace_token: workspace.workspace_token,
        status: workspace.status,
        index_status: workspace.index_status,
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.get("/v1/workspaces/:workspaceToken", async (request, reply) => {
    try {
      const workspace = await workspaces.requireByToken(request.params.workspaceToken);
      return reply.send({ workspace: workspaces.summarize(workspace) });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/v1/workspaces/:workspaceToken/refresh", async (request, reply) => {
    try {
      const workspace = await workspaces.refresh(request.params.workspaceToken, request.body || {});
      return reply.send({
        workspace: workspaces.summarize(workspace),
        workspace_token: workspace.workspace_token,
        status: workspace.status,
        index_status: workspace.index_status,
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.get("/admin/settings", async () => {
    return {
      status: "ok",
      editable: runtime.editable,
      settings: runtime.settings,
      models: serializeModels(runtime.registry),
    };
  });

  app.put("/admin/settings", async (request, reply) => {
    if (!runtime.editable) {
      return reply.code(409).send({
        error: {
          code: "settings_not_editable",
          message: "Runtime settings cannot be changed when an explicit registry is injected.",
        },
      });
    }

    try {
      const nextSettings = await runtime.settingsStore.save(request.body?.settings || request.body || {});
      const nextRegistry = createRuntimeRegistry(config, nextSettings);
      runtime.settings = nextSettings;
      runtime.registry = nextRegistry;
      return reply.send({
        status: "ok",
        editable: runtime.editable,
        settings: runtime.settings,
        models: serializeModels(runtime.registry),
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/admin/settings/reload", async (_request, reply) => {
    if (!runtime.editable) {
      return reply.code(409).send({
        error: {
          code: "settings_not_editable",
          message: "Runtime settings cannot be changed when an explicit registry is injected.",
        },
      });
    }

    try {
      const nextSettings = await runtime.settingsStore.load();
      runtime.settings = nextSettings;
      runtime.registry = createRuntimeRegistry(config, nextSettings);
      return reply.send({
        status: "ok",
        editable: runtime.editable,
        settings: runtime.settings,
        models: serializeModels(runtime.registry),
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/admin/provider-probe", async (request, reply) => {
    try {
      const modelIds = providerProbeModelIds(runtime.registry, request.body?.models);
      const results = [];
      for (const modelId of modelIds) {
        const started = Date.now();
        try {
          const completion = await runChatCompletion({
            activeRegistry: runtime.registry,
            config,
            body: {
              model: modelId,
              fallback: "none",
              messages: [{ role: "user", content: "Reply with exactly ok." }],
            },
            messages: [{ role: "user", content: "Reply with exactly ok." }],
            defaultChatModel: modelId,
            markWorkerFailures: true,
          });
          results.push({
            model: modelId,
            ok: true,
            elapsed_ms: Date.now() - started,
            used_model: completion.used_model,
            used_worker: completion.used_worker,
            attempts: completion.attempts,
          });
        } catch (error) {
          const providerError = toProviderError(error);
          results.push({
            model: modelId,
            ok: false,
            elapsed_ms: Date.now() - started,
            ...providerErrorFields(providerError),
            attempts: providerError.details?.attempts || [],
          });
        }
      }
      return reply.send({
        status: results.every((result) => result.ok) ? "ok" : "degraded",
        results,
      });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/admin/provider-login", async (request, reply) => {
    try {
      const session = await startProviderLogin({
        provider: request.body?.provider || "codex",
        workerId: request.body?.worker || request.body?.worker_id || "codex-1",
        mode: request.body?.mode || "device",
        config,
        settings: runtime.settings,
      });
      return reply.send({ status: "ok", session });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.get("/admin/provider-login/:sessionId", async (request, reply) => {
    try {
      return reply.send({ status: "ok", session: getProviderLoginSession(request.params.sessionId) });
    } catch (error) {
      return sendProviderError(reply, error);
    }
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body || {};

    try {
      if (body.stream) {
        return sendLiveChatCompletionStream(reply, {
          emitStatusEvents: Boolean(body.status_events),
          run: (onStatus) =>
            runChatCompletion({
              activeRegistry: runtime.registry,
              config,
              body,
              messages: body.messages,
              onStatus,
              defaultChatModel: getDefaultChatModel(runtime, config),
            }),
        });
      }

      const response = await runChatCompletion({
        activeRegistry: runtime.registry,
        config,
        body,
        messages: body.messages,
        defaultChatModel: getDefaultChatModel(runtime, config),
      });
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
        context: body.context,
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
      if (body.stream) {
        return sendLiveChatCompletionStream(reply, {
          emitStatusEvents: Boolean(body.status_events),
          run: (onStatus) =>
            runConversationTurn({
              activeRegistry: runtime.registry,
              config,
              conversations,
              workspaces,
              conversation,
              body,
              onStatus,
              defaultChatModel: getDefaultChatModel(runtime, config),
            }),
          extractCompletion: (result) => result.chat_completion,
        });
      }
      const result = await runConversationTurn({
        activeRegistry: runtime.registry,
        config,
        conversations,
        workspaces,
        conversation,
        body,
        defaultChatModel: getDefaultChatModel(runtime, config),
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
        context: body.context,
      });
      if (body.stream) {
        return sendLiveChatCompletionStream(reply, {
          emitStatusEvents: Boolean(body.status_events),
          run: (onStatus) =>
            runConversationTurn({
              activeRegistry: runtime.registry,
              config,
              conversations,
              workspaces,
              conversation,
              body,
              onStatus,
              defaultChatModel: getDefaultChatModel(runtime, config),
            }),
          extractCompletion: (result) => result.chat_completion,
        });
      }
      const result = await runConversationTurn({
        activeRegistry: runtime.registry,
        config,
        conversations,
        workspaces,
        conversation,
        body,
        defaultChatModel: getDefaultChatModel(runtime, config),
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
      const activeRegistry = runtime.registry;
      const initialModel = activeRegistry.get(modelId);
      if (initialModel.kind !== "image") {
        throw new ProviderError("invalid_request", `${modelId} is not an image model.`);
      }
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
          ...providerErrorFields(providerError),
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

function createRuntimeRegistry(config, settings) {
  return createModelRegistry({
    chatgptWorker: config.chatgpt?.enabled ? new ChatGptImageBrowserWorker(config.chatgpt) : null,
    fakeWorker: new FakeImageWorker(),
    enableFake: process.env.NODE_ENV === "test",
    claude: config.claude,
    codex: config.codex,
    settings,
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
}

function serializeModels(registry) {
  return [...registry.models.values()].map((model) => ({
    id: model.id,
    object: "model",
    kind: model.kind,
    capabilities: model.capabilities,
    output: model.output,
    fallback: model.fallback,
    provider: model.provider || null,
    cli_model: model.cliModel || null,
  }));
}

function getDefaultChatModel(runtime, config) {
  return runtime.settings?.defaultModel || config.chat?.defaultModel || runtime.registry.defaultModel("chat");
}

function providerProbeModelIds(registry, requestedModels) {
  if (Array.isArray(requestedModels) && requestedModels.length) {
    return [...new Set(requestedModels.map((modelId) => String(modelId || "").trim()).filter(Boolean))];
  }

  const providerModels = new Map();
  for (const model of registry.models.values()) {
    if (model.kind !== "chat" || !model.provider) {
      continue;
    }
    if (!providerModels.has(model.provider)) {
      providerModels.set(model.provider, model.id);
    }
  }
  return [...providerModels.values()];
}

async function runConversationTurn({
  activeRegistry,
  config,
  conversations,
  workspaces,
  conversation,
  body,
  onStatus,
  defaultChatModel,
}) {
  const inputMessages = extractConversationInputMessages(body);
  const context = extractConversationContext(body);
  const workspaceRequest = normalizeWorkspaceRequest(body.workspace);
  const workspace = workspaceRequest ? await workspaces.requireByToken(workspaceRequest.token) : null;
  if (workspaceRequest) {
    assertWorkspaceModeAllowed(workspace, workspaceRequest);
  }
  const conversationWithContext =
    context === undefined ? conversation : await conversations.updateContext(conversation.id, context);
  const model = body.model || conversation.default_model || defaultChatModel || config.chat?.defaultModel || activeRegistry.defaultModel("chat");
  const contextMessages = conversationContextMessages(
    conversationWithContext,
    inputMessages,
    config.chat?.maxConversationMessages || 60,
  );
  const retrievedChunks = await retrieveWorkspaceContext({
    workspace,
    workspaceRequest,
    config,
    query: inputMessages.map((message) => message.content).join("\n"),
  });
  const workspaceMessage = workspace ? workspaceContextMessage(workspace, retrievedChunks) : null;
  const messages = workspaceMessage ? [workspaceMessage, ...contextMessages] : contextMessages;
  const completion = await runChatCompletion({
    activeRegistry,
    config,
    body: {
      ...body,
      model,
      messages,
    },
    messages,
    onStatus,
    defaultChatModel,
  });
  const updated = await conversations.appendTurn(conversationWithContext.id, {
    inputMessages,
    assistantMessage: completion.choices[0].message,
    completion,
  });

  return {
    conversation: conversations.summarize(updated),
    workspace: workspace
      ? {
          ...workspaces.summarize(workspace),
          mode: workspaceRequest.mode,
          retrieved_chunks: retrievedChunks.map((chunk) => ({
            id: chunk.id,
            kind: chunk.kind,
            title: chunk.title,
            metadata: chunk.metadata,
          })),
        }
      : null,
    chat_completion: {
      ...completion,
      conversation_id: updated.id,
      project_id: updated.project_id,
      conversation_key: updated.conversation_key,
      context_message_count: updated.context?.messages?.length || 0,
      context_updated_at: updated.context?.updated_at || null,
    },
  };
}

async function runChatCompletion({
  activeRegistry,
  config,
  body,
  messages,
  onStatus,
  defaultChatModel,
  markWorkerFailures = true,
}) {
  const requestedModel = body.model || defaultChatModel || config.chat?.defaultModel || activeRegistry.defaultModel("chat");
  const attempts = [];
  const statusEvents = [];
  const emitStatus = createStatusEmitter((event) => {
    statusEvents.push(event);
    onStatus?.(event);
  });

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ProviderError("invalid_request", "messages must be a non-empty array.");
  }

  emitStatus("request_received", "Received chat request.", { requested_model: requestedModel });
  const initialModel = activeRegistry.get(requestedModel);
  if (initialModel.kind !== "chat") {
    throw new ProviderError("invalid_request", `${requestedModel} is not a chat model.`);
  }

  emitStatus("model_selected", `Selected ${initialModel.id}.`, { model: initialModel.id });
  const result = await tryModelWithFallbacks(activeRegistry, initialModel, {
    method: "generateChat",
    input: {
      messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    },
    attempts,
    fallbackPolicy: body.fallback ?? "default",
    onStatus: emitStatus,
    workerFailureCooldownMs: markWorkerFailures ? config.chat?.workerFailureCooldownMs : 0,
  });

  return createChatCompletionResponse({
    requestedModel,
    result,
    attempts,
    statusEvents,
  });
}

async function tryModelWithFallbacks(
  registry,
  model,
  { method, input, attempts, fallbackPolicy, onStatus, workerFailureCooldownMs = 30000 },
) {
  const candidateIds = candidateModelIds(model, fallbackPolicy);
  let lastError = null;
  const failedFailureDomains = new Map();

  for (const candidateId of candidateIds) {
    const candidate = registry.get(candidateId);
    const workers = orderedWorkers(candidate);
    onStatus?.("model_attempt", `Trying ${candidate.id}.`, { model: candidate.id });

    for (const worker of workers) {
      const failureDomain = workerFailureDomain(worker);
      const domainFailure = failedFailureDomains.get(failureDomain);
      if (domainFailure) {
        const skippedError = new ProviderError(
          domainFailure.code,
          `${worker.id} shares failure domain ${failureDomain}, which already failed with ${domainFailure.code}.`,
          {
            authStatus: domainFailure.details?.authStatus || null,
            output: providerDiagnostic(domainFailure),
          },
        );
        attempts.push({
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
          status: "skipped",
          ...providerErrorFields(skippedError),
        });
        onStatus?.("worker_skipped", `${worker.id} skipped: shared failure domain.`, {
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
          code: skippedError.code,
          auth_status: skippedError.details?.authStatus || null,
        });
        lastError = skippedError;
        continue;
      }

      const unavailable = workerUnavailable(worker);
      if (unavailable) {
        const skippedError = new ProviderError(
          unavailable.code,
          `${worker.id} is unavailable until ${unavailable.retryAt} because the last provider attempt failed with ${unavailable.code}.`,
          {
            authStatus: unavailable.authStatus,
            output: unavailable.diagnostic,
            retryAt: unavailable.retryAt,
          },
        );
        attempts.push({
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
          status: "skipped",
          ...providerErrorFields(skippedError),
          retry_at: unavailable.retryAt,
        });
        onStatus?.("worker_skipped", `${worker.id} skipped: ${unavailable.code}.`, {
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
          code: unavailable.code,
          auth_status: unavailable.authStatus,
          retry_at: unavailable.retryAt,
        });
        lastError = skippedError;
        continue;
      }

      try {
        attempts.push({ model: candidate.id, worker: worker.id, failure_domain: failureDomain, status: "started" });
        onStatus?.("worker_started", `Running ${candidate.id} on ${worker.id}.`, {
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
        });
        const result = await worker[method]({
          ...input,
          model: candidate,
          onStatus: (stage, message, details = {}) =>
            onStatus?.(stage, message, { model: candidate.id, worker: worker.id, failure_domain: failureDomain, ...details }),
        });
        attempts[attempts.length - 1] = {
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
          status: "succeeded",
        };
        onStatus?.("worker_completed", `${worker.id} completed.`, {
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
        });
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
          failure_domain: failureDomain,
          status: "failed",
          ...providerErrorFields(providerError),
        };
        onStatus?.("worker_failed", `${worker.id} failed: ${providerError.code}.`, {
          model: candidate.id,
          worker: worker.id,
          failure_domain: failureDomain,
          code: providerError.code,
          auth_status: providerError.details?.authStatus || null,
        });
        markWorkerUnavailable(worker, providerError, workerFailureCooldownMs);
        if (stickyWorkerFailure(providerError.code)) {
          failedFailureDomains.set(failureDomain, providerError);
        }
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

function workerFailureDomain(worker) {
  return worker.failureDomain || worker.id;
}

function workerUnavailable(worker) {
  if (!worker.unavailableUntil || worker.unavailableUntil <= Date.now()) {
    return null;
  }
  return {
    code: worker.lastFailureCode || "provider_unavailable",
    authStatus: worker.lastFailureAuthStatus || null,
    diagnostic: worker.lastFailureDiagnostic || null,
    retryAt: new Date(worker.unavailableUntil).toISOString(),
  };
}

function markWorkerUnavailable(worker, error, cooldownMs) {
  if (!cooldownMs || !stickyWorkerFailure(error.code)) {
    return;
  }
  worker.lastFailureCode = error.code;
  worker.lastFailureAt = new Date().toISOString();
  worker.lastFailureAuthStatus = error.details?.authStatus || null;
  worker.lastFailureDiagnostic = providerDiagnostic(error);
  worker.unavailableUntil = Date.now() + cooldownMs;
}

function stickyWorkerFailure(code) {
  return ["auth_required", "rate_limited", "worker_spawn_failed", "worker_timeout"].includes(code);
}

function providerDiagnostic(error) {
  return sanitizeDiagnostic(error?.details?.output || error?.details?.stderr || null);
}

function providerErrorFields(error) {
  return {
    code: error.code,
    message: error.message,
    retryable: providerErrorRetryable(error),
    auth_status: error.details?.authStatus || null,
    diagnostic: providerDiagnostic(error),
  };
}

function providerErrorRetryable(error) {
  if (error.details?.authStatus) {
    return false;
  }
  if (
    error.code === "auth_required" ||
    error.code === "invalid_request" ||
    error.code === "unknown_model" ||
    error.code === "workspace_not_found" ||
    error.code === "workspace_permission_denied" ||
    error.code === "workspace_provider_denied"
  ) {
    return false;
  }
  return ["rate_limited", "worker_timeout", "worker_spawn_failed", "provider_error"].includes(error.code);
}

function sanitizeDiagnostic(value) {
  if (!value) {
    return null;
  }
  return String(value)
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[jwt-redacted]")
    .slice(0, 2000);
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

function createChatCompletionResponse({ requestedModel, result, attempts, statusEvents = [] }) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `chatcmpl_${cryptoRandomId()}`,
    object: "chat.completion",
    created: now,
    model: result.usedModel,
    requested_model: requestedModel,
    used_model: result.usedModel,
    used_worker: result.usedWorker,
    llmhq: llmhqInstance(),
    fallback_used: result.usedModel !== requestedModel,
    fallback_reason: firstFailureReason(attempts),
    attempts,
    status_events: statusEvents,
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

function createStatusEmitter(onStatus) {
  return (stage, message, details = {}) => {
    const event = {
      type: "status",
      stage,
      message,
      created: Math.floor(Date.now() / 1000),
      ...details,
    };
    onStatus(event);
    return event;
  };
}

function writeSseEvent(reply, event, data) {
  if (event) {
    reply.raw.write(`event: ${event}\n`);
  }
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function sendLiveChatCompletionStream(reply, { run, emitStatusEvents = false, extractCompletion = (result) => result }) {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const onStatus = (event) => {
    if (emitStatusEvents) {
      writeSseEvent(reply, "status", event);
    }
  };

  try {
    const result = await run(onStatus);
    const response = extractCompletion(result);
    sendChatCompletionStreamChunks(reply, response);
  } catch (error) {
    const providerError = toProviderError(error);
    writeSseEvent(reply, "error", {
      error: {
        ...providerErrorFields(providerError),
        details: providerError.details,
        attempts: providerError.details?.attempts || [],
      },
    });
    reply.raw.write("data: [DONE]\n\n");
  } finally {
    reply.raw.end();
  }
}

function sendChatCompletionStream(reply, response) {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  sendChatCompletionStreamChunks(reply, response);
  reply.raw.end();
}

function sendChatCompletionStreamChunks(reply, response) {
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
    status_events: response.status_events || [],
    conversation_id: response.conversation_id,
    project_id: response.project_id,
    conversation_key: response.conversation_key,
    context_message_count: response.context_message_count,
    context_updated_at: response.context_updated_at,
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
    providerError.code === "conversation_not_found" || providerError.code === "workspace_not_found"
      ? 404
      : providerError.code === "workspace_permission_denied" || providerError.code === "workspace_provider_denied"
        ? 403
      : providerError.code === "unknown_model" ||
          providerError.code === "invalid_request" ||
          providerError.code === "no_model_configured"
        ? 400
        : 503;
  return reply.code(status).send({
    error: {
      llmhq: llmhqInstance(),
      ...providerErrorFields(providerError),
      details: providerError.details,
      attempts: providerError.details?.attempts || [],
    },
  });
}
