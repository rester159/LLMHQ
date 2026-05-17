import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { buildAdminApp } from "../src/adminServer.js";
import { buildApp } from "../src/app.js";
import { AssetStore } from "../src/assets.js";
import { ProviderError } from "../src/errors.js";
import { buildProxyApp } from "../src/proxyApp.js";
import { classifyCliFailure } from "../src/providers/cliProcess.js";
import { FakeChatWorker } from "../src/providers/fakeChatWorker.js";
import { FakeImageWorker } from "../src/providers/fakeImageWorker.js";
import { createModelRegistry } from "../src/registry.js";

function testConfig(assetDir) {
  return {
    authMode: "token",
    apiKeys: ["test-key"],
    assetDir,
    conversationDir: path.join(assetDir, "conversations"),
    chat: {
      defaultModel: "claude-sonnet",
      maxConversationMessages: 60,
    },
    chatgpt: {
      enabled: false,
    },
  };
}

function runtimeConfig(assetDir) {
  return {
    ...testConfig(assetDir),
    authMode: "none",
    settingsFile: path.join(assetDir, "settings.json"),
    claude: {
      enabled: true,
      command: "claude",
      timeoutMs: 1000,
      workers: [{ id: "claude-1", profileDir: path.join(assetDir, "profiles", "claude-1") }],
      models: {
        haiku: "haiku",
        sonnet: "sonnet",
        opus: "opus",
      },
    },
    codex: {
      enabled: true,
      command: "codex",
      timeoutMs: 1000,
      workdir: path.join(assetDir, "codex-workdir"),
      workers: [{ id: "codex-1", profileDir: path.join(assetDir, "profiles", "codex-1") }],
      model: "gpt-5.5",
    },
  };
}

test("health is public and includes providers", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-health`);
  const registry = createModelRegistry({
    fakeWorker: new FakeImageWorker(),
    enableFake: true,
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: testConfig(assetDir),
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "ok");
  assert.match(body.instance.instance_id, /.+/);
  assert.match(body.instance.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(body.providers[0].id, "fake-image");
});

test("image generation requires bearer auth", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-auth`);
  const registry = createModelRegistry({
    fakeWorker: new FakeImageWorker(),
    enableFake: true,
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: testConfig(assetDir),
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    payload: { model: "fake-image", prompt: "test" },
  });
  assert.equal(response.statusCode, 401);
});

test("auth mode none allows same-server calls without bearer auth", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-noauth`);
  const registry = createModelRegistry({
    fakeWorker: new FakeImageWorker(),
    enableFake: true,
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    payload: { model: "fake-image", prompt: "test image" },
  });
  assert.equal(response.statusCode, 200);
});

test("image generation stores and serves an asset", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-asset`);
  const registry = createModelRegistry({
    fakeWorker: new FakeImageWorker(),
    enableFake: true,
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: testConfig(assetDir),
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/images/generations",
    headers: { authorization: "Bearer test-key" },
    payload: { model: "fake-image", prompt: "test image" },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.model, "fake-image");
  assert.equal(body.data.length, 1);
  assert.match(body.data[0].asset_id, /^img_/);

  const assetResponse = await app.inject({
    method: "GET",
    url: body.data[0].url,
    headers: { authorization: "Bearer test-key" },
  });
  assert.equal(assetResponse.statusCode, 200);
  assert.equal(assetResponse.headers["content-type"], "image/png");
});

test("chat completions return OpenAI-compatible content", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-chat`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "sonnet says" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-sonnet",
      fallback: "default",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.requested_model, "claude-sonnet");
  assert.equal(body.used_model, "claude-sonnet");
  assert.equal(body.fallback_used, false);
  assert.equal(body.choices[0].message.role, "assistant");
  assert.match(body.choices[0].message.content, /sonnet says: hello/);
  assert.deepEqual(body.attempts, [
    { model: "claude-sonnet", worker: "fake-sonnet", failure_domain: "fake-sonnet", status: "succeeded" },
  ]);
});

test("models endpoint lists configured chat aliases", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-models`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet" })],
        fallback: ["codex-gpt-5.5"],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/models",
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.object, "list");
  assert.equal(body.data[0].id, "claude-sonnet");
  assert.deepEqual(body.data[0].fallback, ["codex-gpt-5.5"]);
});

test("chat completions use configured default model when omitted", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-default-model`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "fake-chat",
        workers: [new FakeChatWorker({ id: "fake-chat", response: "default model" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none", chat: { defaultModel: "fake-chat" } },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      messages: [{ role: "user", content: "default please" }],
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.used_model, "fake-chat");
  assert.match(body.choices[0].message.content, /default model/);
});

test("chat completions reject invalid messages", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-invalid`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "fake-chat",
        workers: [new FakeChatWorker({ id: "fake-chat" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none", chat: { defaultModel: "fake-chat" } },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "fake-chat",
      messages: [],
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "invalid_request");
});

test("chat completions use visible default fallback", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-fallback`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-opus",
        workers: [new FakeChatWorker({ id: "fake-opus", failWith: "rate_limited" })],
        fallback: ["claude-sonnet"],
      },
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "fallback sonnet" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-opus",
      fallback: "default",
      messages: [{ role: "user", content: "use the best model" }],
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.requested_model, "claude-opus");
  assert.equal(body.used_model, "claude-sonnet");
  assert.equal(body.fallback_used, true);
  assert.equal(body.fallback_reason, "claude-opus/fake-opus: rate_limited");
  assert.equal(body.attempts[0].status, "failed");
  assert.equal(body.attempts[1].status, "succeeded");
});

test("chat completions skip a worker that already failed with sticky auth state", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-sticky-fallback`);
  const badClaudeWorker = new FakeChatWorker({ id: "fake-claude", failWith: "auth_required" });
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-haiku",
        workers: [badClaudeWorker],
        fallback: ["claude-sonnet", "codex-gpt-5.5"],
      },
      {
        id: "claude-sonnet",
        workers: [badClaudeWorker],
        fallback: ["codex-gpt-5.5"],
      },
      {
        id: "codex-gpt-5.5",
        workers: [new FakeChatWorker({ id: "fake-codex", response: "codex fallback" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none", chat: { defaultModel: "claude-haiku", workerFailureCooldownMs: 60000 } },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-haiku",
      fallback: "default",
      messages: [{ role: "user", content: "use fallback" }],
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.used_model, "codex-gpt-5.5");
  assert.deepEqual(
    body.attempts.map((attempt) => attempt.status),
    ["failed", "skipped", "succeeded"],
  );
  assert.equal(body.attempts[1].model, "claude-sonnet");
  assert.equal(body.attempts[1].code, "auth_required");

  const noFallback = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-haiku",
      fallback: "none",
      messages: [{ role: "user", content: "no fallback now" }],
    },
  });
  assert.equal(noFallback.statusCode, 503);
  assert.equal(noFallback.json().error.code, "auth_required");
  assert.equal(noFallback.json().error.retryable, false);
  assert.equal(noFallback.json().error.attempts[0].status, "skipped");
});

test("chat completions can disable fallback", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-no-fallback`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-opus",
        workers: [new FakeChatWorker({ id: "fake-opus", failWith: "auth_required" })],
        fallback: ["claude-sonnet"],
      },
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "should not run" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-opus",
      fallback: "none",
      messages: [{ role: "user", content: "no fallback" }],
    },
  });

  assert.equal(response.statusCode, 503);
  const body = response.json();
  assert.equal(body.error.code, "auth_required");
  assert.equal(body.error.attempts.length, 1);
});

test("chat completion errors expose exact provider auth diagnostics", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-auth-diagnostics`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "codex-gpt-5.5",
        provider: "codex",
        workers: [
          {
            id: "codex-1",
            async health() {
              return { id: "codex-1", status: "ready", capabilities: ["chat"] };
            },
            async generateChat() {
              throw new ProviderError(
                "auth_required",
                "Provider CLI token has been invalidated. Re-authenticate the LLMHQ worker profile.",
                {
                  authStatus: "refresh_token_reused",
                  output: "token_invalidated refresh_token: should-not-leak access_token=also-secret",
                },
              );
            },
          },
        ],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "codex-gpt-5.5",
      fallback: "none",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(response.statusCode, 503);
  const body = response.json();
  assert.equal(body.error.code, "auth_required");
  assert.equal(body.error.retryable, false);
  assert.equal(body.error.auth_status, "refresh_token_reused");
  assert.match(body.error.diagnostic, /token_invalidated/);
  assert.doesNotMatch(body.error.diagnostic, /should-not-leak|also-secret/);
  assert.equal(body.error.attempts[0].auth_status, "refresh_token_reused");
  assert.equal(body.error.attempts[0].retryable, false);
});

test("cli auth failures classify invalidated tokens with repair details", () => {
  const error = classifyCliFailure(
    "Your authentication token has been invalidated. code: token_invalidated. refresh_token: secret-refresh. code: refresh_token_reused",
    1,
  );

  assert.equal(error.code, "auth_required");
  assert.equal(error.details.authStatus, "refresh_token_reused");
  assert.equal(error.details.repair, "reauthenticate_worker_profile");
  assert.match(error.message, /Re-authenticate/);
  assert.doesNotMatch(error.details.output, /secret-refresh/);
});

test("chat completions support streaming shape", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-stream`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "stream sonnet" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-sonnet",
      messages: [{ role: "user", content: "stream please" }],
      stream: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"], /text\/event-stream/);
  assert.match(response.body, /data: /);
  assert.match(response.body, /\[DONE\]/);
  assert.match(response.body, /stream sonnet/);
});

test("chat completions can stream current status events", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-status-stream`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "status sonnet" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-sonnet",
      messages: [{ role: "user", content: "show status" }],
      stream: true,
      status_events: true,
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /event: status/);
  assert.match(response.body, /"stage":"worker_started"/);
  assert.match(response.body, /"message":"Running claude-sonnet on fake-sonnet\."/);
  assert.match(response.body, /status sonnet/);
});

test("conversation creation is idempotent by project and key", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-conversation-create`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/conversations",
    payload: {
      project_id: "soundpulse",
      conversation_key: "strategy-generator",
      title: "Strategy Generator",
      default_model: "claude-sonnet",
    },
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/conversations",
    payload: {
      project_id: "soundpulse",
      conversation_key: "strategy-generator",
      title: "Ignored Existing Title",
      default_model: "codex-gpt-5.5",
    },
  });

  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(first.json().conversation.id, second.json().conversation.id);
  assert.equal(second.json().created, false);
});

test("conversation messages endpoint stores history without app-held conversation id", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-conversation-messages`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "memory" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const first = await app.inject({
    method: "POST",
    url: "/v1/conversations/messages",
    payload: {
      project_id: "alexandria",
      conversation_key: "catalog-normalizer",
      default_model: "claude-sonnet",
      message: { role: "user", content: "first turn" },
    },
  });
  const second = await app.inject({
    method: "POST",
    url: "/v1/conversations/messages",
    payload: {
      project_id: "alexandria",
      conversation_key: "catalog-normalizer",
      default_model: "claude-sonnet",
      message: { role: "user", content: "second turn" },
    },
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  const firstBody = first.json();
  const secondBody = second.json();
  assert.equal(firstBody.conversation.id, secondBody.conversation.id);
  assert.equal(secondBody.conversation.message_count, 4);
  assert.equal(secondBody.chat_completion.conversation_key, "catalog-normalizer");

  const stored = await app.inject({
    method: "GET",
    url: `/v1/conversations/${secondBody.conversation.id}`,
  });
  assert.equal(stored.statusCode, 200);
  assert.deepEqual(
    stored.json().messages.map((message) => message.role),
    ["user", "assistant", "user", "assistant"],
  );
});

test("conversation messages persist app context ahead of history", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-conversation-context`);
  const seen = [];
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [
          {
            id: "recording-worker",
            async generateChat({ messages }) {
              seen.push(messages);
              return {
                content: "context ok",
                providerMetadata: {},
              };
            },
          },
        ],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/conversations/messages",
    payload: {
      project_id: "inventory-app",
      conversation_key: "catalog-review",
      default_model: "claude-sonnet",
      context: {
        summary: "Catalog app reviewing batch abc123.",
        metadata: { app: "inventory", workflow: "catalog-review" },
        messages: [{ role: "system", content: "Use application-provided catalog context." }],
      },
      message: { role: "user", content: "first turn" },
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.conversation.context_message_count, 2);
  assert.equal(body.chat_completion.context_message_count, 2);
  assert.equal(seen[0][0].role, "system");
  assert.match(seen[0][0].content, /Application context summary/);
  assert.equal(seen[0][1].content, "Use application-provided catalog context.");
  assert.equal(seen[0][2].content, "first turn");

  const stored = await app.inject({
    method: "GET",
    url: `/v1/conversations/${body.conversation.id}`,
  });
  assert.equal(stored.statusCode, 200);
  assert.equal(stored.json().conversation.context_message_count, 2);
});

test("conversation messages can continue by conversation id", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-conversation-id`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet", response: "by id" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const created = await app.inject({
    method: "POST",
    url: "/v1/conversations",
    payload: {
      project_id: "llmhq",
      conversation_key: "docs",
      default_model: "claude-sonnet",
    },
  });
  const conversationId = created.json().conversation.id;
  const turn = await app.inject({
    method: "POST",
    url: `/v1/conversations/${conversationId}/messages`,
    payload: {
      message: { role: "user", content: "continue" },
    },
  });

  assert.equal(turn.statusCode, 200);
  assert.equal(turn.json().conversation.id, conversationId);
  assert.equal(turn.json().conversation.message_count, 2);
});

test("conversation list can filter by project", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-conversation-list`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-sonnet",
        workers: [new FakeChatWorker({ id: "fake-sonnet" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  await app.inject({
    method: "POST",
    url: "/v1/conversations",
    payload: { project_id: "one", conversation_key: "a" },
  });
  await app.inject({
    method: "POST",
    url: "/v1/conversations",
    payload: { project_id: "two", conversation_key: "b" },
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/conversations?project_id=one",
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.length, 1);
  assert.equal(response.json().data[0].project_id, "one");
});

test("admin settings persist and rebuild model fallback chains", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-settings`);
  const app = await buildApp({
    fastify: Fastify(),
    config: runtimeConfig(assetDir),
    assetStore: new AssetStore(assetDir),
  });

  const initial = await app.inject({ method: "GET", url: "/admin/settings" });
  assert.equal(initial.statusCode, 200);
  const settings = initial.json().settings;
  assert.deepEqual(settings.models["claude-haiku"].fallback, ["claude-sonnet", "codex-gpt-5.5"]);
  assert.equal(settings.models["codex-gpt-5.5"].kind, "chat");
  assert.deepEqual(settings.models["codex-gpt-5.5"].capabilities, ["chat", "code"]);
  assert.equal(settings.models["codex-gpt-5.5-vision"].kind, "chat");
  assert.deepEqual(settings.models["codex-gpt-5.5-vision"].capabilities, ["chat", "vision", "image_input"]);
  assert.equal(settings.models["chatgpt-image-browser"].kind, "image");
  assert.equal(settings.models["chatgpt-image-browser"].enabled, false);

  const changed = {
    ...settings,
    models: {
      ...settings.models,
      "claude-haiku": {
        ...settings.models["claude-haiku"],
        fallback: ["codex-gpt-5.5"],
      },
    },
  };
  const saved = await app.inject({
    method: "PUT",
    url: "/admin/settings",
    payload: changed,
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().settings.models["claude-haiku"].fallback, ["codex-gpt-5.5"]);

  const models = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(models.statusCode, 200);
  const haiku = models.json().data.find((model) => model.id === "claude-haiku");
  assert.deepEqual(haiku.fallback, ["codex-gpt-5.5"]);
  assert.equal(haiku.cli_model, "haiku");

  const persisted = JSON.parse(await fs.readFile(path.join(assetDir, "settings.json"), "utf8"));
  assert.deepEqual(persisted.models["claude-haiku"].fallback, ["codex-gpt-5.5"]);
});

test("existing settings files are migrated with missing discrete model aliases", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-settings-migration`);
  await fs.mkdir(assetDir, { recursive: true });
  await fs.writeFile(
    path.join(assetDir, "settings.json"),
    JSON.stringify(
      {
        version: 1,
        defaultModel: "claude-sonnet",
        workers: {
          claude: [{ id: "claude-1", profileDir: path.join(assetDir, "profiles", "claude-1") }],
          codex: [{ id: "codex-1", profileDir: path.join(assetDir, "profiles", "codex-1") }],
        },
        models: {
          "claude-sonnet": {
            enabled: true,
            provider: "claude",
            cliModel: "sonnet",
            capabilities: ["chat", "vision", "smart"],
            fallback: ["codex-gpt-5.5"],
          },
          "codex-gpt-5.5": {
            enabled: true,
            provider: "codex",
            cliModel: "gpt-5.5",
            capabilities: ["chat", "code", "vision"],
            fallback: ["claude-sonnet"],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const app = await buildApp({
    fastify: Fastify(),
    config: {
      ...runtimeConfig(assetDir),
      chatgpt: {
        enabled: true,
        profileDir: path.join(assetDir, "browser-profiles", "chatgpt-main"),
        headless: true,
        timeoutMs: 1000,
        url: "https://chatgpt.com/",
      },
    },
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({ method: "GET", url: "/admin/settings" });
  assert.equal(response.statusCode, 200);
  const settings = response.json().settings;
  assert.equal(settings.models["codex-gpt-5.5"].kind, "chat");
  assert.deepEqual(settings.models["codex-gpt-5.5"].capabilities, ["chat", "code"]);
  assert.equal(settings.models["codex-gpt-5.5-vision"].kind, "chat");
  assert.equal(settings.models["chatgpt-image-browser"].kind, "image");
  assert.equal(settings.models["chatgpt-image-browser"].enabled, true);

  const persisted = JSON.parse(await fs.readFile(path.join(assetDir, "settings.json"), "utf8"));
  assert.deepEqual(persisted.models["codex-gpt-5.5"].capabilities, ["chat", "code"]);
  assert.equal(persisted.models["codex-gpt-5.5-vision"].kind, "chat");
  assert.equal(persisted.models["chatgpt-image-browser"].kind, "image");
});

test("models endpoint lists discrete text vision and image model aliases", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-all-models`);
  const app = await buildApp({
    fastify: Fastify(),
    config: {
      ...runtimeConfig(assetDir),
      chatgpt: {
        enabled: true,
        profileDir: path.join(assetDir, "browser-profiles", "chatgpt-main"),
        headless: true,
        timeoutMs: 1000,
        url: "https://chatgpt.com/",
      },
    },
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(response.statusCode, 200);
  const models = new Map(response.json().data.map((model) => [model.id, model]));
  assert.equal(models.get("codex-gpt-5.5").kind, "chat");
  assert.deepEqual(models.get("codex-gpt-5.5").capabilities, ["chat", "code"]);
  assert.equal(models.get("codex-gpt-5.5-vision").kind, "chat");
  assert.deepEqual(models.get("codex-gpt-5.5-vision").capabilities, ["chat", "vision", "image_input"]);
  assert.equal(models.get("chatgpt-image-browser").kind, "image");
  assert.deepEqual(models.get("chatgpt-image-browser").output, ["image"]);
});

test("admin provider probe reports provider usability without changing app payload contract", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-provider-probe`);
  const registry = createModelRegistry({
    fakeChatModels: [
      {
        id: "claude-haiku",
        provider: "claude",
        workers: [new FakeChatWorker({ id: "fake-claude", response: "ok" })],
        fallback: [],
      },
      {
        id: "codex-gpt-5.5",
        provider: "codex",
        workers: [new FakeChatWorker({ id: "fake-codex", failWith: "auth_required" })],
        fallback: [],
      },
    ],
  });
  const app = await buildApp({
    fastify: Fastify(),
    config: { ...testConfig(assetDir), authMode: "none" },
    registry,
    assetStore: new AssetStore(assetDir),
  });

  const response = await app.inject({
    method: "POST",
    url: "/admin/provider-probe",
    payload: { models: ["claude-haiku", "codex-gpt-5.5"] },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, false);
  assert.equal(body.results[1].code, "auth_required");
});

test("admin provider login starts codex device auth session", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-provider-login`);
  const fakeCodexCommand = await writeFakeCodexCommand(assetDir);
  const config = runtimeConfig(assetDir);
  config.codex.command = fakeCodexCommand;
  const app = await buildApp({
    fastify: Fastify(),
    config,
    assetStore: new AssetStore(assetDir),
  });

  const started = await app.inject({
    method: "POST",
    url: "/admin/provider-login",
    payload: { provider: "codex", worker: "codex-1", mode: "device" },
  });
  assert.equal(started.statusCode, 200);
  const sessionId = started.json().session.id;

  let session = started.json().session;
  for (let index = 0; index < 20 && session.status === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const status = await app.inject({ method: "GET", url: `/admin/provider-login/${sessionId}` });
    assert.equal(status.statusCode, 200);
    session = status.json().session;
  }

  assert.equal(session.status, "completed");
  assert.match(session.output, /DEVICE-AUTH-CODE/);
  assert.equal(session.worker, "codex-1");
  assert.match(session.profileDir, /codex-1/);
});

test("admin provider login starts claude browser auth session", async () => {
  const assetDir = path.join(os.tmpdir(), `llmhq-test-${Date.now()}-provider-login-claude`);
  const fakeClaudeCommand = await writeFakeClaudeCommand(assetDir);
  const config = runtimeConfig(assetDir);
  config.claude.command = fakeClaudeCommand;
  const app = await buildApp({
    fastify: Fastify(),
    config,
    assetStore: new AssetStore(assetDir),
  });

  const started = await app.inject({
    method: "POST",
    url: "/admin/provider-login",
    payload: { provider: "claude", worker: "claude-1", mode: "claudeai" },
  });
  assert.equal(started.statusCode, 200);
  const sessionId = started.json().session.id;

  let session = started.json().session;
  for (let index = 0; index < 20 && session.status === "running"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const status = await app.inject({ method: "GET", url: `/admin/provider-login/${sessionId}` });
    assert.equal(status.statusCode, 200);
    session = status.json().session;
  }

  assert.equal(session.status, "completed");
  assert.match(session.output, /CLAUDE-LOGIN-URL/);
  assert.equal(session.worker, "claude-1");
  assert.match(session.profileDir, /claude-1/);
});

test("admin webui proxies generic v1 API requests to the gateway", async () => {
  let captured = null;
  const fetchImpl = async (url, options = {}) => {
    captured = { url: String(url), method: options.method, body: JSON.parse(options.body) };
    return rawJsonResponse({
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  };
  const app = await buildAdminApp({
    fastify: Fastify(),
    llmhqBaseUrl: "http://llmhq:8080",
    fetchImpl,
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/chat/completions?trace=1",
    payload: {
      model: "claude-haiku",
      stream: false,
      messages: [{ role: "user", content: "hello" }],
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().choices[0].message.content, "ok");
  assert.equal(captured.url, "http://llmhq:8080/v1/chat/completions?trace=1");
  assert.equal(captured.method, "POST");
  assert.equal(captured.body.model, "claude-haiku");
});

test("proxy app forwards v1 requests and maps health to remote admin summary", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method, body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith("/admin/api/summary")) {
      return rawJsonResponse({
        status: "ok",
        health: {
          status: "ok",
          instance: { instance_id: "unraid-good" },
        },
      });
    }
    return rawJsonResponse({
      requested_model: "claude-haiku",
      used_model: "claude-haiku",
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
  };
  const app = await buildProxyApp({
    fastify: Fastify(),
    targetUrl: "http://10.0.5.202:18089",
    fetchImpl,
  });

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().instance.instance_id, "unraid-good");
  assert.equal(calls[0].url, "http://10.0.5.202:18089/admin/api/summary");

  const chat = await app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "claude-haiku",
      fallback: "default",
      messages: [{ role: "user", content: "hello" }],
    },
  });
  assert.equal(chat.statusCode, 200);
  assert.equal(chat.json().used_model, "claude-haiku");
  assert.equal(calls[1].url, "http://10.0.5.202:18089/v1/chat/completions");
  assert.equal(calls[1].body.model, "claude-haiku");
});

test("admin webui renders and summarizes gateway state", async () => {
  const settingsPayload = {
    version: 1,
    defaultModel: "claude-sonnet",
    workers: {
      claude: [{ id: "claude-1", profileDir: "/app/data/profiles/claude-1" }],
      codex: [],
    },
    models: {
      "claude-haiku": {
        enabled: true,
        provider: "claude",
        cliModel: "haiku",
        capabilities: ["chat", "fast"],
        fallback: ["claude-sonnet", "codex-gpt-5.5"],
      },
      "claude-sonnet": {
        enabled: true,
        provider: "claude",
        cliModel: "sonnet",
        capabilities: ["chat", "smart"],
        fallback: [],
      },
    },
  };
  let savedSettings = null;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/health")) {
      return jsonResponse({
        status: "ok",
        auth_mode: "none",
        providers: [
          {
            id: "claude-1",
            status: "configured",
            command: "claude",
            capabilities: ["chat", "vision"],
            profileDir: "/app/data/profiles/claude-1",
          },
        ],
      });
    }
    if (String(url).endsWith("/v1/models")) {
      return jsonResponse({
        object: "list",
        data: [
          {
            id: "claude-haiku",
            capabilities: ["chat", "fast"],
            output: ["text"],
            fallback: ["claude-sonnet", "codex-gpt-5.5"],
          },
        ],
      });
    }
    if (String(url).endsWith("/admin/settings") && (options.method || "GET") === "GET") {
      return jsonResponse({
        status: "ok",
        editable: true,
        settings: settingsPayload,
        models: [],
      });
    }
    if (String(url).endsWith("/admin/settings") && options.method === "PUT") {
      savedSettings = JSON.parse(options.body).models["claude-haiku"].fallback;
      return jsonResponse({
        status: "ok",
        editable: true,
        settings: JSON.parse(options.body),
        models: [
          {
            id: "claude-haiku",
            capabilities: ["chat", "fast"],
            output: ["text"],
            fallback: savedSettings,
          },
        ],
      });
    }
    if (String(url).endsWith("/admin/settings/reload") && options.method === "POST") {
      return jsonResponse({
        status: "ok",
        editable: true,
        settings: settingsPayload,
        models: [],
      });
    }
    if (String(url).endsWith("/admin/provider-probe") && options.method === "POST") {
      return jsonResponse({
        status: "degraded",
        results: [
          {
            model: "claude-haiku",
            ok: false,
            code: "auth_required",
            attempts: [{ model: "claude-haiku", worker: "claude-1", status: "failed", code: "auth_required" }],
          },
        ],
      });
    }
    if (String(url).endsWith("/admin/provider-login") && options.method === "POST") {
      return jsonResponse({
        status: "ok",
        session: {
          id: "login-test",
          provider: "codex",
          worker: "codex-1",
          status: "running",
          output: "DEVICE-AUTH-CODE",
        },
      });
    }
    if (String(url).endsWith("/admin/provider-login/login-test")) {
      return jsonResponse({
        status: "ok",
        session: {
          id: "login-test",
          provider: "codex",
          worker: "codex-1",
          status: "completed",
          output: "DEVICE-AUTH-CODE",
        },
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const app = await buildAdminApp({
    fastify: Fastify(),
    llmhqBaseUrl: "http://llmhq:8080",
    fetchImpl,
  });

  const page = await app.inject({ method: "GET", url: "/admin" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.body, /LLMHQ Admin/);
  assert.match(page.body, /Start Claude Login/);
  assert.match(page.body, /Start Codex Device Login/);

  const summary = await app.inject({ method: "GET", url: "/admin/api/summary" });
  assert.equal(summary.statusCode, 200);
  assert.equal(summary.json().health.providers[0].id, "claude-1");
  assert.equal(summary.json().models[0].id, "claude-haiku");
  assert.equal(summary.json().settings.defaultModel, "claude-sonnet");

  const saved = await app.inject({
    method: "PUT",
    url: "/admin/api/settings",
    payload: {
      settings: {
        ...settingsPayload,
        models: {
          ...settingsPayload.models,
          "claude-haiku": {
            ...settingsPayload.models["claude-haiku"],
            fallback: ["claude-sonnet"],
          },
        },
      },
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(savedSettings, ["claude-sonnet"]);

  const probe = await app.inject({
    method: "POST",
    url: "/admin/api/provider-probe",
    payload: {},
  });
  assert.equal(probe.statusCode, 200);
  assert.equal(probe.json().status, "degraded");
  assert.equal(probe.json().results[0].code, "auth_required");

  const login = await app.inject({
    method: "POST",
    url: "/admin/api/provider-login",
    payload: { provider: "codex", worker: "codex-1", mode: "device" },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().session.id, "login-test");

  const loginStatus = await app.inject({ method: "GET", url: "/admin/api/provider-login/login-test" });
  assert.equal(loginStatus.statusCode, 200);
  assert.equal(loginStatus.json().session.status, "completed");
});

async function writeFakeCodexCommand(assetDir) {
  await fs.mkdir(assetDir, { recursive: true });
  if (process.platform === "win32") {
    const filePath = path.join(assetDir, "fake-codex.cmd");
    await fs.writeFile(filePath, "@echo off\r\necho DEVICE-AUTH-CODE https://example.test ABCD-EFGH\r\nexit /b 0\r\n", "utf8");
    return filePath;
  }

  const filePath = path.join(assetDir, "fake-codex");
  await fs.writeFile(filePath, "#!/bin/sh\necho DEVICE-AUTH-CODE https://example.test ABCD-EFGH\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

async function writeFakeClaudeCommand(assetDir) {
  await fs.mkdir(assetDir, { recursive: true });
  if (process.platform === "win32") {
    const filePath = path.join(assetDir, "fake-claude.cmd");
    await fs.writeFile(filePath, "@echo off\r\necho CLAUDE-LOGIN-URL https://example.test/oauth\r\nexit /b 0\r\n", "utf8");
    return filePath;
  }

  const filePath = path.join(assetDir, "fake-claude");
  await fs.writeFile(filePath, "#!/bin/sh\necho CLAUDE-LOGIN-URL https://example.test/oauth\nexit 0\n", "utf8");
  await fs.chmod(filePath, 0o755);
  return filePath;
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function rawJsonResponse(payload, status = 200) {
  const buffer = Buffer.from(JSON.stringify(payload), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/json" : null;
      },
    },
    json: async () => payload,
    arrayBuffer: async () => buffer,
  };
}
