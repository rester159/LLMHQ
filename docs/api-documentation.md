# LLMHQ API Documentation

## Overview

LLMHQ is a private local LLM gateway for apps running on the same server or private Docker network. Apps call LLMHQ over HTTP and LLMHQ routes the request to one of its configured provider workers.

Current provider workers:

- Claude CLI worker for `claude-haiku`, `claude-sonnet`, and `claude-opus`.
- Codex CLI worker for `codex-gpt-5.5`.
- Experimental ChatGPT browser worker for `chatgpt-image-browser` image generation.

Current server defaults:

- Host URL from the server host: `http://127.0.0.1:18088`
- Docker-to-Docker URL on same-server app networks: `http://llmhq:8080`
- Unraid/admin WebUI: `http://<server-ip>:18089/admin`
- Default chat model: `claude-sonnet`
- Same-server auth mode in Compose: `LLMHQ_AUTH_MODE=none`

## Base URL

Use one of these values in product apps:

```env
# Host-local apps
LLMHQ_BASE_URL=http://127.0.0.1:18088
```

```env
# Apps running as containers on the same server
LLMHQ_BASE_URL=http://llmhq:8080
```

The Compose deployment also sets the Unraid WebUI label:

```yaml
net.unraid.docker.webui: "http://[IP]:[PORT:18089]/admin"
```

## Authentication

LLMHQ supports two auth modes.

### `LLMHQ_AUTH_MODE=none`

No `Authorization` header is required.

Use this only when LLMHQ is reachable through:

- `127.0.0.1`, or
- a private Docker network that only trusted local apps can join.

The default Compose setup is designed for this mode.

### `LLMHQ_AUTH_MODE=token`

Requests must include:

```http
Authorization: Bearer <key>
```

Keys are configured with:

```env
LLMHQ_API_KEYS=key-one,key-two
```

Generate a key with:

```powershell
npm run key:generate my-app
```

## Model Aliases

Apps should use LLMHQ model aliases, not provider-native model names.

| Alias | Type | Capabilities | Provider worker |
| --- | --- | --- | --- |
| `claude-haiku` | Chat | chat, vision, fast | Claude CLI |
| `claude-sonnet` | Chat | chat, vision, smart | Claude CLI |
| `claude-opus` | Chat | chat, vision, deep reasoning | Claude CLI |
| `codex-gpt-5.5` | Chat | chat, code, vision | Codex CLI |
| `chatgpt-image-browser` | Image | image generation, experimental image edit | ChatGPT browser |

Fetch the live list from:

```http
GET /v1/models
```

## Fallback Behavior

LLMHQ fallback is request-visible. Apps select a model. If that model fails and fallback is enabled, LLMHQ tries the model's fallback chain.

Default fallback chains:

| Requested model | Default fallback chain |
| --- | --- |
| `claude-haiku` | `claude-sonnet`, then `codex-gpt-5.5` |
| `claude-sonnet` | `codex-gpt-5.5` |
| `claude-opus` | `claude-sonnet`, then `codex-gpt-5.5` |
| `codex-gpt-5.5` | `claude-sonnet` |
| `chatgpt-image-browser` | none |

Default behavior:

```json
{
  "fallback": "default"
}
```

Disable fallback for a strict request:

```json
{
  "fallback": "none"
}
```

or:

```json
{
  "fallback": false
}
```

Use a custom fallback:

```json
{
  "fallback": "codex-gpt-5.5"
}
```

or:

```json
{
  "fallback": ["claude-sonnet", "codex-gpt-5.5"]
}
```

Every chat response includes:

- `requested_model`
- `used_model`
- `used_worker`
- `fallback_used`
- `fallback_reason`
- `attempts`

## Response Attempt Records

`attempts` records the provider path taken by the gateway.

Successful attempt:

```json
{
  "model": "claude-sonnet",
  "worker": "claude-1",
  "status": "succeeded"
}
```

Failed attempt:

```json
{
  "model": "claude-sonnet",
  "worker": "claude-1",
  "status": "failed",
  "code": "provider_error",
  "message": "Provider-specific failure message."
}
```

Apps should log these records when debugging provider availability. A response with `fallback_used: true` is still a successful response.

## Endpoints

### `GET /health`

Returns gateway status and configured provider worker health.

Request:

```http
GET /health
```

Example response:

```json
{
  "status": "ok",
  "auth_mode": "none",
  "providers": [
    {
      "id": "claude-1",
      "status": "configured",
      "command": "claude",
      "profileDir": "/app/data/profiles/claude-1",
      "capabilities": ["chat", "vision"]
    },
    {
      "id": "codex-1",
      "status": "configured",
      "command": "codex",
      "profileDir": "/app/data/profiles/codex-1",
      "workdir": "/app/data/codex-workdir",
      "capabilities": ["chat", "code", "vision"]
    },
    {
      "id": "chatgpt-image-browser",
      "status": "configured",
      "capabilities": ["image_generate", "image_edit_experimental"],
      "profileDir": "/app/data/browser-profiles/chatgpt-main",
      "headless": true
    }
  ]
}
```

Notes:

- This endpoint does not prove the provider is logged in. It reports configured worker health.
- A provider may still fail during a generation call if its subscription, session, or provider UI is unavailable.

### `GET /admin`

Serves the read-only admin WebUI. The page loads gateway status from the companion admin service at:

```http
GET /admin/api/summary
```

The current UI shows configured provider accounts, model aliases, and fallback chains. It does not yet edit accounts, model aliases, or fallback policies.

### `GET /v1/models`

Returns configured model aliases.

Request:

```http
GET /v1/models
```

Example response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "claude-sonnet",
      "object": "model",
      "capabilities": ["chat", "vision", "smart"],
      "output": ["text"],
      "fallback": ["codex-gpt-5.5"]
    }
  ]
}
```

Use this endpoint for admin/debug UI and runtime capability discovery.

### `POST /v1/chat/completions`

Runs a stateless chat completion.

Use this when the product app already stores full chat history or only needs one-shot LLM work.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | No | LLMHQ chat model alias. Defaults to `LLMHQ_DEFAULT_CHAT_MODEL`. |
| `messages` | array | Yes | Non-empty list of chat messages. |
| `fallback` | string, array, boolean | No | Defaults to `"default"`. Use `"none"` or `false` to disable. |
| `temperature` | number | No | Passed to the worker where supported. |
| `max_tokens` | number | No | Passed to the worker where supported. |
| `stream` | boolean | No | If true, returns a simple SSE response. |

Message shape:

```json
{
  "role": "system",
  "content": "You are a concise coding assistant."
}
```

Supported roles:

- `system`
- `user`
- `assistant`

Example request:

```powershell
$body = @{
  model = "claude-sonnet"
  fallback = "default"
  messages = @(
    @{ role = "system"; content = "You are a concise coding assistant." },
    @{ role = "user"; content = "Review this function for bugs." }
  )
  stream = $false
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8080/v1/chat/completions `
  -ContentType "application/json" `
  -Body $body
```

Example response:

```json
{
  "id": "chatcmpl_abc123",
  "object": "chat.completion",
  "created": 1778910000,
  "model": "claude-sonnet",
  "requested_model": "claude-sonnet",
  "used_model": "claude-sonnet",
  "used_worker": "claude-1",
  "fallback_used": false,
  "fallback_reason": null,
  "attempts": [
    {
      "model": "claude-sonnet",
      "worker": "claude-1",
      "status": "succeeded"
    }
  ],
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": null
}
```

Read the assistant content from:

```text
choices[0].message.content
```

#### Streaming

If `stream: true`, LLMHQ returns `text/event-stream`.

The current streaming implementation emits the full assistant content as one chunk, followed by a finish chunk and `[DONE]`. It is API-compatible enough for simple stream consumers but is not token-by-token streaming.

If the request also includes `status_events: true`, LLMHQ emits named SSE events before the final assistant chunk:

```text
event: status
data: {"type":"status","stage":"worker_started","message":"Running claude-sonnet on claude-1.","model":"claude-sonnet","worker":"claude-1","created":1779041015}
```

Status events are generic and provider-neutral. Apps can show `message` as the current action while the request is running. Common `stage` values include `request_received`, `model_selected`, `model_attempt`, `worker_started`, `profile_ready`, `provider_running`, `response_received`, `worker_completed`, and `worker_failed`.

### `POST /v1/conversations`

Creates or resolves a stored conversation.

Use this when an app wants to prepare a conversation before sending messages, or when an admin tool needs a stable conversation id.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Yes | Stable app/project id. |
| `conversation_key` | string | No | Stable workflow/thread key. If present, calls are idempotent per project/key. |
| `title` | string | No | Human-readable title. |
| `default_model` | string | No | Default model for future conversation turns. |
| `metadata` | object | No | App-specific metadata. |

Example request:

```json
{
  "project_id": "soundpulse",
  "conversation_key": "strategy-generator",
  "title": "Strategy Generator",
  "default_model": "claude-sonnet",
  "metadata": {
    "feature": "strategy"
  }
}
```

Example response:

```json
{
  "conversation": {
    "id": "conv_68760674-64f3-4dc1-8733-f99df8ebc2d1",
    "project_id": "soundpulse",
    "conversation_key": "strategy-generator",
    "title": "Strategy Generator",
    "default_model": "claude-sonnet",
    "metadata": {
      "feature": "strategy"
    },
    "message_count": 0,
    "created_at": "2026-05-16T08:00:00.000Z",
    "updated_at": "2026-05-16T08:00:00.000Z"
  },
  "created": true
}
```

If the same `project_id + conversation_key` already exists, LLMHQ returns it with:

```json
{
  "created": false
}
```

### `GET /v1/conversations`

Lists stored conversations.

Request all conversations:

```http
GET /v1/conversations
```

Request conversations for one project:

```http
GET /v1/conversations?project_id=soundpulse
```

Example response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "conv_68760674-64f3-4dc1-8733-f99df8ebc2d1",
      "project_id": "soundpulse",
      "conversation_key": "strategy-generator",
      "title": "Strategy Generator",
      "default_model": "claude-sonnet",
      "metadata": {},
      "message_count": 12,
      "created_at": "2026-05-16T08:00:00.000Z",
      "updated_at": "2026-05-16T08:20:00.000Z"
    }
  ]
}
```

Conversations are sorted by newest `updated_at` first.

### `GET /v1/conversations/:conversationId`

Returns one full conversation, including stored messages.

Request:

```http
GET /v1/conversations/conv_68760674-64f3-4dc1-8733-f99df8ebc2d1
```

Example response:

```json
{
  "conversation": {
    "id": "conv_68760674-64f3-4dc1-8733-f99df8ebc2d1",
    "project_id": "soundpulse",
    "conversation_key": "strategy-generator",
    "title": "Strategy Generator",
    "default_model": "claude-sonnet",
    "metadata": {},
    "message_count": 2,
    "created_at": "2026-05-16T08:00:00.000Z",
    "updated_at": "2026-05-16T08:02:00.000Z"
  },
  "messages": [
    {
      "id": "msg_...",
      "role": "user",
      "content": "Create a strategy.",
      "created_at": "2026-05-16T08:01:00.000Z"
    },
    {
      "id": "msg_...",
      "role": "assistant",
      "content": "...",
      "created_at": "2026-05-16T08:02:00.000Z",
      "model": "claude-sonnet",
      "requested_model": "claude-sonnet",
      "used_worker": "claude-1",
      "fallback_used": false,
      "fallback_reason": null,
      "attempts": []
    }
  ]
}
```

### `POST /v1/conversations/messages`

Creates or resolves a conversation and appends one turn.

Use this as the default stateful integration for apps that do not own chat history.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Required unless `conversation_id` is used | Stable app/project id. |
| `conversation_key` | string | Required unless `conversation_id` is used | Stable workflow/thread key. |
| `conversation_id` | string | No | Existing conversation id. If supplied, bypasses project/key lookup. |
| `title` | string | No | Used only when creating a conversation. |
| `default_model` | string | No | Used only when creating a conversation. |
| `model` | string | No | Model for this turn. Defaults to request model, conversation default, or gateway default. |
| `fallback` | string, array, boolean | No | Defaults to `"default"`. |
| `message` | object | Required unless `messages` is used | One new message. |
| `messages` | array | Required unless `message` is used | New messages to append as this turn input. |
| `metadata` | object | No | Used only when creating a conversation. |
| `context` | object | No | Generic app-provided context to store separately from chat turns. Supports `summary`, `metadata`, and `messages`. |

Example request:

```powershell
$body = @{
  project_id = "soundpulse"
  conversation_key = "strategy-generator"
  title = "Strategy Generator"
  default_model = "claude-sonnet"
  model = "claude-sonnet"
  fallback = "default"
  context = @{
    summary = "Stable workflow context supplied by the calling app."
    metadata = @{
      app = "soundpulse"
      workflow = "strategy-generator"
    }
    messages = @(
      @{ role = "system"; content = "Use this application context before chat history." }
    )
  }
  message = @{
    role = "user"
    content = "Create a release strategy for this track."
  }
  metadata = @{
    feature = "strategy"
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8080/v1/conversations/messages `
  -ContentType "application/json" `
  -Body $body
```

Example response:

```json
{
  "conversation": {
    "id": "conv_68760674-64f3-4dc1-8733-f99df8ebc2d1",
    "project_id": "soundpulse",
    "conversation_key": "strategy-generator",
    "title": "Strategy Generator",
    "default_model": "claude-sonnet",
    "metadata": {
      "feature": "strategy"
    },
    "context_message_count": 2,
    "context_updated_at": "2026-05-16T08:02:00.000Z",
    "message_count": 2,
    "created_at": "2026-05-16T08:00:00.000Z",
    "updated_at": "2026-05-16T08:02:00.000Z"
  },
  "chat_completion": {
    "id": "chatcmpl_abc123",
    "object": "chat.completion",
    "created": 1778910000,
    "model": "claude-sonnet",
    "requested_model": "claude-sonnet",
    "used_model": "claude-sonnet",
    "used_worker": "claude-1",
    "fallback_used": false,
    "fallback_reason": null,
    "attempts": [
      {
        "model": "claude-sonnet",
        "worker": "claude-1",
        "status": "succeeded"
      }
    ],
    "choices": [
      {
        "index": 0,
        "message": {
          "role": "assistant",
          "content": "..."
        },
        "finish_reason": "stop"
      }
    ],
    "usage": null,
    "conversation_id": "conv_68760674-64f3-4dc1-8733-f99df8ebc2d1",
    "project_id": "soundpulse",
    "conversation_key": "strategy-generator",
    "context_message_count": 2,
    "context_updated_at": "2026-05-16T08:02:00.000Z"
  }
}
```

Read assistant content from:

```text
chat_completion.choices[0].message.content
```

### `POST /v1/conversations/:conversationId/messages`

Appends one turn to an existing conversation by id.

Request:

```http
POST /v1/conversations/conv_68760674-64f3-4dc1-8733-f99df8ebc2d1/messages
```

Body:

```json
{
  "model": "codex-gpt-5.5",
  "fallback": "default",
  "message": {
    "role": "user",
    "content": "Continue with implementation details."
  }
}
```

This endpoint returns the same response shape as `POST /v1/conversations/messages`.

## Stateful Conversation Mechanics

For each stateful turn, LLMHQ:

1. Resolves the conversation by `conversation_id` or `project_id + conversation_key`.
2. Updates stored app context when a `context` object is provided.
3. Reads prior stored messages from disk.
4. Prepends app context messages, then combines prior chat messages with the new input.
5. Keeps up to `LLMHQ_MAX_CONVERSATION_MESSAGES` chat messages, preserving app context messages outside that chat-history limit.
6. Calls `/v1/chat/completions` internally.
7. Stores the new user/input messages and assistant message.
8. Saves fallback and provider attempt metadata on the assistant message.

Conversation files live in:

```text
./data/conversations
```

In Docker, this maps to:

```text
/app/data/conversations
```

## Image Generation

### `POST /v1/images/generations`

Generates an image and stores it as a local asset.

The currently implemented image model is:

```text
chatgpt-image-browser
```

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | No | Defaults to `chatgpt-image-browser`. |
| `prompt` | string | Yes | Image generation prompt. |
| `fallback` | string, array, boolean | No | Supported by the generic dispatcher, but the current image model has no default fallback. |

Example request:

```powershell
$body = @{
  model = "chatgpt-image-browser"
  prompt = "Generate a simple square image of a red circle on a white background. No text."
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8080/v1/images/generations `
  -ContentType "application/json" `
  -Body $body `
  -TimeoutSec 120
```

Example success response:

```json
{
  "created": 1778910000,
  "model": "chatgpt-image-browser",
  "requested_model": "chatgpt-image-browser",
  "fallback_used": false,
  "fallback_reason": null,
  "attempts": [
    {
      "model": "chatgpt-image-browser",
      "worker": "chatgpt-image-browser",
      "status": "succeeded"
    }
  ],
  "data": [
    {
      "asset_id": "img_68760674-64f3-4dc1-8733-f99df8ebc2d1",
      "url": "/v1/assets/img_68760674-64f3-4dc1-8733-f99df8ebc2d1",
      "mime_type": "image/png"
    }
  ]
}
```

Important constraints:

- This route is experimental.
- It depends on a logged-in ChatGPT web session.
- It may fail when ChatGPT changes its UI, logs out, rate-limits, blocks automation, or requires a captcha.
- It does not bypass provider limits.

### `GET /v1/assets/:assetId`

Returns a generated local asset.

Request:

```http
GET /v1/assets/img_68760674-64f3-4dc1-8733-f99df8ebc2d1
```

Example PowerShell download:

```powershell
Invoke-WebRequest `
  -Uri http://127.0.0.1:8080/v1/assets/img_68760674-64f3-4dc1-8733-f99df8ebc2d1 `
  -OutFile D:\LLMHQ\data\test-image.png
```

Asset files live in:

```text
./data/assets
```

Each saved image has a sidecar JSON metadata file containing model, requested model, provider metadata, MIME type, and creation time.

## Error Responses

LLMHQ returns errors in this shape:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "messages must be a non-empty array.",
    "details": {},
    "attempts": []
  }
}
```

Common error codes:

| Code | Typical HTTP status | Meaning |
| --- | --- | --- |
| `invalid_request` | 400 | Missing or invalid request body fields. |
| `unknown_model` | 400 | The requested model alias is not configured. |
| `no_model_configured` | 400 | No model exists for the requested kind. |
| `conversation_not_found` | 404 | Conversation id does not exist. |
| `asset_not_found` | 404 | Asset id does not exist. |
| `auth_required` | 503 | A provider session, usually ChatGPT browser, is not logged in or usable. |
| `provider_error` | 503 | A provider worker failed. |
| `provider_timeout` | 503 | A provider worker timed out. |

Provider failures include `attempts` when the dispatcher reached a provider worker.

## Provider Login

Provider login is outside the API. It is done through scripts inside the container or local workspace.

Docker setup:

```powershell
docker compose up -d --build
docker compose exec llmhq npm run login:claude -- claude-1
docker compose exec llmhq npm run login:codex -- codex-1
docker compose exec llmhq npm run login:chatgpt:vnc
```

The ChatGPT noVNC helper exposes:

```text
http://127.0.0.1:7900/vnc.html?autoconnect=1&resize=scale
```

Log in interactively with Google in the remote browser, then press Enter in the login command terminal when the ChatGPT prompt box is usable.

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LLMHQ_HOST` | `127.0.0.1` | Bind host for local Node runs. Compose uses `0.0.0.0` inside the container. |
| `LLMHQ_PORT` | `8080` | API port. |
| `LLMHQ_AUTH_MODE` | `token` | `token` or `none`. |
| `LLMHQ_API_KEYS` | `dev-local-key` | Comma-separated bearer keys for token mode. |
| `LLMHQ_ASSET_DIR` | `./data/assets` | Generated asset storage. |
| `LLMHQ_CONVERSATION_DIR` | `./data/conversations` | Conversation JSON storage. |
| `LLMHQ_DEFAULT_CHAT_MODEL` | `claude-sonnet` | Default chat model. |
| `LLMHQ_CHAT_TIMEOUT_MS` | `180000` | Default provider timeout. |
| `LLMHQ_MAX_CONVERSATION_MESSAGES` | `60` | Stateful context window in messages. |
| `LLMHQ_CLAUDE_ENABLED` | `false` | Enables Claude CLI models. |
| `LLMHQ_CLAUDE_COMMAND` | `claude` | Claude CLI command. |
| `LLMHQ_CLAUDE_WORKERS` | empty | Comma-separated worker specs like `claude-1=./data/profiles/claude-1`. |
| `LLMHQ_CLAUDE_HAIKU_MODEL` | `haiku` | Provider-native Claude Haiku model argument. |
| `LLMHQ_CLAUDE_SONNET_MODEL` | `sonnet` | Provider-native Claude Sonnet model argument. |
| `LLMHQ_CLAUDE_OPUS_MODEL` | `opus` | Provider-native Claude Opus model argument. |
| `LLMHQ_CODEX_ENABLED` | `false` | Enables Codex CLI model. |
| `LLMHQ_CODEX_COMMAND` | `codex` | Codex CLI command. |
| `LLMHQ_CODEX_WORKERS` | empty | Comma-separated worker specs like `codex-1=./data/profiles/codex-1`. |
| `LLMHQ_CODEX_MODEL` | `gpt-5.5` | Provider-native Codex model argument. |
| `LLMHQ_CODEX_WORKDIR` | `.` | Working directory used by Codex CLI. |
| `LLMHQ_EXPERIMENTAL_CHATGPT_BROWSER` | `false` | Enables browser-backed ChatGPT image worker. |
| `LLMHQ_CHATGPT_PROFILE_DIR` | `./data/browser-profiles/chatgpt-main` | Persistent browser profile. |
| `LLMHQ_CHATGPT_HEADLESS` | `false` | Headless browser mode for generation. |
| `LLMHQ_CHATGPT_TIMEOUT_MS` | `180000` | ChatGPT image worker timeout. |
| `LLMHQ_CHATGPT_URL` | `https://chatgpt.com/` | ChatGPT web URL. |

## Integration Patterns

### Stateless App

Use this when the app already has its own chat/message table.

1. Store the conversation in the app.
2. Send the full `messages` array to `POST /v1/chat/completions`.
3. Store the returned assistant content.
4. Log fallback metadata.

### Stateful App

Use this when the app does not want to own LLM chat history.

1. Pick a stable `project_id`.
2. Pick a stable `conversation_key` per workflow/user thread.
3. Send only the new user message to `POST /v1/conversations/messages`.
4. Let LLMHQ store and replay context.
5. Optionally store `conversation.id` for direct continuation.

### Same-Server Docker App

Configure:

```env
LLMHQ_BASE_URL=http://llmhq:8080
```

The `llmhq-network-sync` sidecar automatically connects LLMHQ to user-defined Docker bridge networks on the server.

No bearer token is required if LLMHQ is running with `LLMHQ_AUTH_MODE=none`.

## Minimal Client Behavior

Every product app should centralize LLMHQ calls in one client module.

The client should:

- Read `LLMHQ_BASE_URL`.
- Optionally read `LLMHQ_API_KEY`.
- Read `LLMHQ_DEFAULT_MODEL`, defaulting to `claude-sonnet`.
- Send `fallback: "default"` unless the caller opts out.
- Normalize errors into the app's existing error type.
- Preserve `requested_model`, `used_model`, `fallback_used`, `fallback_reason`, and `attempts`.

## Operational Checks

Run these after startup:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:8080/v1/models | ConvertTo-Json -Depth 8
```

Run tests:

```powershell
npm test
```

Run provider doctor:

```powershell
npm run doctor
```

or inside Docker:

```powershell
docker compose exec llmhq npm run doctor
```
