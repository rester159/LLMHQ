import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { AssetStore } from "../src/assets.js";
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
  assert.deepEqual(body.attempts, [{ model: "claude-sonnet", worker: "fake-sonnet", status: "succeeded" }]);
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
