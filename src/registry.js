import { ProviderError } from "./errors.js";
import { ClaudeCliChatWorker } from "./providers/claudeCliChatWorker.js";
import { CodexCliChatWorker } from "./providers/codexCliChatWorker.js";

export function createModelRegistry({
  chatgptWorker,
  fakeWorker = null,
  enableFake = false,
  claude = null,
  codex = null,
  fakeChatModels = null,
}) {
  const models = new Map();

  if (chatgptWorker) {
    models.set("chatgpt-image-browser", {
      id: "chatgpt-image-browser",
      capabilities: ["image_generate", "image_edit_experimental"],
      output: ["image"],
      worker: chatgptWorker,
      fallback: enableFake && fakeWorker ? ["fake-image"] : [],
      kind: "image",
    });
  }

  if (enableFake && fakeWorker) {
    models.set("fake-image", {
      id: "fake-image",
      capabilities: ["image_generate"],
      output: ["image"],
      worker: fakeWorker,
      fallback: [],
      kind: "image",
    });
  }

  if (fakeChatModels) {
    for (const model of fakeChatModels) {
      models.set(model.id, {
        id: model.id,
        capabilities: model.capabilities || ["chat"],
        output: ["text"],
        workers: model.workers,
        fallback: model.fallback || [],
        kind: "chat",
        cliModel: model.cliModel || model.id,
      });
    }
  }

  if (claude?.enabled) {
    const workers = buildClaudeWorkers(claude);
    addChatModel(models, "claude-haiku", workers, claude.models.haiku, ["claude-sonnet", "codex-gpt-5.5"], [
      "chat",
      "vision",
      "fast",
    ]);
    addChatModel(models, "claude-sonnet", workers, claude.models.sonnet, ["codex-gpt-5.5"], [
      "chat",
      "vision",
      "smart",
    ]);
    addChatModel(models, "claude-opus", workers, claude.models.opus, ["claude-sonnet", "codex-gpt-5.5"], [
      "chat",
      "vision",
      "deep_reasoning",
    ]);
  }

  if (codex?.enabled) {
    const workers = buildCodexWorkers(codex);
    addChatModel(models, "codex-gpt-5.5", workers, codex.model, ["claude-sonnet"], [
      "chat",
      "code",
      "vision",
    ]);
  }

  return {
    models,

    get(modelId) {
      const model = models.get(modelId);
      if (!model) {
        throw new ProviderError("unknown_model", `Unknown model: ${modelId}`);
      }
      return model;
    },

    defaultModel(kind = "chat") {
      const preferred = kind === "chat" ? ["claude-sonnet", "codex-gpt-5.5"] : ["chatgpt-image-browser", "fake-image"];
      for (const id of preferred) {
        if (models.has(id)) {
          return id;
        }
      }
      for (const model of models.values()) {
        if (model.kind === kind) {
          return model.id;
        }
      }
      throw new ProviderError("no_model_configured", `No ${kind} model is configured.`);
    },

    async health() {
      const providers = [];
      const seen = new Set();
      for (const model of models.values()) {
        const workers = model.workers || [model.worker];
        for (const worker of workers) {
          if (!worker || seen.has(worker.id)) {
            continue;
          }
          seen.add(worker.id);
          providers.push(await worker.health());
        }
      }
      return providers;
    },
  };
}

function addChatModel(models, id, workers, cliModel, fallback, capabilities) {
  models.set(id, {
    id,
    kind: "chat",
    capabilities,
    output: ["text"],
    workers,
    fallback,
    cliModel,
    nextWorkerIndex: 0,
  });
}

function buildClaudeWorkers(config) {
  const specs = config.workers.length ? config.workers : [{ id: "claude-local", profileDir: null }];
  return specs.map(
    (spec) =>
      new ClaudeCliChatWorker({
        id: spec.id,
        profileDir: spec.profileDir,
        command: config.command,
        timeoutMs: config.timeoutMs,
      }),
  );
}

function buildCodexWorkers(config) {
  const specs = config.workers.length ? config.workers : [{ id: "codex-local", profileDir: null }];
  return specs.map(
    (spec) =>
      new CodexCliChatWorker({
        id: spec.id,
        profileDir: spec.profileDir,
        command: config.command,
        timeoutMs: config.timeoutMs,
        workdir: config.workdir,
      }),
  );
}
