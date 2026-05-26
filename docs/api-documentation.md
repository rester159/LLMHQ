# LLMHQ API Documentation

## Overview

LLMHQ is a private local LLM gateway for apps running on the same server or private Docker network. Apps call LLMHQ over HTTP and LLMHQ routes the request to one of its configured provider workers.

Current provider workers:

- Claude CLI worker for `claude-haiku`, `claude-sonnet`, and `claude-opus`.
- Codex CLI worker for `codex-gpt-5.5`.
- Ollama HTTP worker for local models such as `ollama-llama3.2`.
- Lightweight FastEmbed service for standard `/v1/embeddings` requests.
- Experimental ChatGPT browser worker for `chatgpt-image-browser` image generation.

Current server defaults:

- Host URL from the server host: `http://127.0.0.1:18088`
- Docker-to-Docker URL on same-server app networks: `http://llmhq:8080`
- Unraid/admin WebUI: `http://<server-ip>:18089/admin`
- Deliberate LAN validation/API proxy: `http://<server-ip>:18089`
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

```env
# Desktop validation runner calling the Unraid LLMHQ WebUI proxy
LLMHQ_BASE_URL=http://<server-ip>:18089
```

Use the WebUI proxy only when the caller is not on the Unraid Docker networks. Same-server containers should keep `http://llmhq:8080`; otherwise a local workstation with its own Docker `llmhq` container can accidentally hit a different LLMHQ instance.

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
| `codex-gpt-5.5` | Chat | chat, code | Codex CLI |
| `codex-gpt-5.5-vision` | Chat | chat, vision, image input | Codex CLI |
| `ollama-llama3.2` | Chat | chat, local, private | Ollama HTTP |
| `ollama-qwen2.5-coder` | Chat | chat, code, local, private | Ollama HTTP, disabled by default until pulled/enabled |
| `text-embedding-3-small` | Embedding | embed | FastEmbed HTTP, maps to `BAAI/bge-small-en-v1.5` by default |
| `chatgpt-image-browser` | Image | image generation, experimental image edit | ChatGPT browser |

`codex-gpt-5.5` and `codex-gpt-5.5-vision` route to the same Codex CLI provider model by default, but they are separate LLMHQ aliases so applications can request text/code turns and image-input vision turns explicitly. `ollama-llama3.2` routes to the local Ollama container and requires the native `llama3.2` model to be pulled. `text-embedding-3-small` is an embedding alias backed by the bundled FastEmbed service by default. `chatgpt-image-browser` is an image-output model and is called through `/v1/images/generations`, not `/v1/chat/completions`.

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
| `codex-gpt-5.5-vision` | none |
| `ollama-llama3.2` | `claude-haiku` |
| `ollama-qwen2.5-coder` | `codex-gpt-5.5`, then `claude-sonnet` |
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
- `llmhq`
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
  "failure_domain": "claude:/app/data/profiles/claude-1",
  "status": "succeeded"
}
```

Failed attempt:

```json
{
  "model": "claude-sonnet",
  "worker": "claude-1",
  "failure_domain": "claude:/app/data/profiles/claude-1",
  "status": "failed",
  "code": "provider_error",
  "message": "Provider-specific failure message."
}
```

Apps should log these records when debugging provider availability. `failure_domain` identifies the account/session profile being used. For example, `claude-haiku` and `claude-sonnet` may be different model aliases but the same failure domain if both use `claude-1`. A response with `fallback_used: true` is still a successful response.

When a worker fails with sticky provider state such as `auth_required`, `rate_limited`, `worker_spawn_failed`, or `worker_timeout`, LLMHQ marks that worker unavailable for `LLMHQ_WORKER_FAILURE_COOLDOWN_MS`. During that cooldown, and within the same request, other model aliases that share the same failure domain are skipped so fallback can reach a different provider instead of repeatedly hitting the same dead session.

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
  "instance": {
    "instance_id": "llmhq-host-18-abc123xy",
    "started_at": "2026-05-17T21:55:00.000Z",
    "hostname": "llmhq-host",
    "pid": 18
  },
  "auth_mode": "none",
  "providers": [
    {
      "id": "claude-1",
      "status": "configured",
      "command": "claude",
      "profileDir": "/app/data/profiles/claude-1",
      "failure_domain": "claude:/app/data/profiles/claude-1",
      "capabilities": ["chat", "vision"]
    },
    {
      "id": "codex-1",
      "status": "configured",
      "command": "codex",
      "profileDir": "/app/data/profiles/codex-1",
      "workdir": "/app/data/codex-workdir",
      "failure_domain": "codex:/app/data/profiles/codex-1",
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
- `instance.instance_id` should be logged by downstream apps when comparing app failures with admin probes. If the ids differ, the app and the admin probe are not hitting the same live LLMHQ process.

### `GET /admin`

Serves the admin WebUI. The page loads gateway status from the companion admin service at:

```http
GET /admin/api/summary
```

The UI shows configured provider accounts, model aliases, fallback chains, and editable runtime settings. Saving runtime settings writes `LLMHQ_SETTINGS_FILE` and hot-swaps LLMHQ's live model registry without restarting the container.

### `GET /admin/settings`

Returns the live runtime settings from the API service.

Request:

```http
GET /admin/settings
```

Example response:

```json
{
  "status": "ok",
  "editable": true,
  "settings": {
    "version": 1,
    "defaultModel": "claude-sonnet",
    "workers": {
      "claude": [
        { "id": "claude-1", "profileDir": "/app/data/profiles/claude-1" }
      ],
      "codex": [
        { "id": "codex-1", "profileDir": "/app/data/profiles/codex-1" }
      ]
    },
    "models": {
      "claude-haiku": {
        "enabled": true,
        "kind": "chat",
        "provider": "claude",
        "cliModel": "haiku",
        "capabilities": ["chat", "vision", "fast"],
        "output": ["text"],
        "fallback": ["claude-sonnet", "codex-gpt-5.5"]
      },
      "codex-gpt-5.5-vision": {
        "enabled": true,
        "kind": "chat",
        "provider": "codex",
        "cliModel": "gpt-5.5",
        "capabilities": ["chat", "vision", "image_input"],
        "output": ["text"],
        "fallback": []
      },
      "chatgpt-image-browser": {
        "enabled": true,
        "kind": "image",
        "provider": "chatgpt-browser",
        "capabilities": ["image_generate", "image_edit_experimental"],
        "output": ["image"],
        "fallback": []
      }
    }
  }
}
```

### `PUT /admin/settings`

Validates, persists, and applies runtime settings. The response includes the saved settings and rebuilt model list.

Request:

```http
PUT /admin/settings
Content-Type: application/json
```

Body is either the settings object itself or `{ "settings": { ... } }`.

Editable fields:

- `defaultModel`: LLMHQ model alias used when a chat call omits `model`.
- `workers.claude`: Claude worker accounts and profile directories.
- `workers.codex`: Codex worker accounts and profile directories.
- `models.<alias>.enabled`: whether the model alias is served.
- `models.<alias>.kind`: `chat` or `image`.
- `models.<alias>.provider`: `claude`, `codex`, or `chatgpt-browser`.
- `models.<alias>.cliModel`: provider-native model argument passed to the CLI for chat models.
- `models.<alias>.capabilities`: metadata returned by `/v1/models`.
- `models.<alias>.output`: output modality metadata returned by `/v1/models`.
- `models.<alias>.fallback`: ordered fallback alias list used by `"fallback": "default"`.

Notes:

- Adding a worker profile path does not authenticate that provider account. The profile must still be logged in through the provider CLI login flow.
- If a call returns `auth_required`, the app reached LLMHQ and LLMHQ reached the provider worker, but the provider CLI session is not usable.
- If a call returns `unknown_model`, the requested alias is disabled or missing from settings.

### `POST /admin/settings/reload`

Reloads `LLMHQ_SETTINGS_FILE` from disk and rebuilds the live registry.

Request:

```http
POST /admin/settings/reload
```

### `POST /admin/provider-probe`

Runs one minimal chat request per configured chat provider by default. Use this to verify that provider profiles are actually usable, not merely configured.

Request:

```http
POST /admin/provider-probe
Content-Type: application/json
```

Optional body:

```json
{
  "models": ["claude-haiku", "codex-gpt-5.5"]
}
```

Example degraded response:

```json
{
  "status": "degraded",
  "results": [
    {
      "model": "claude-haiku",
      "ok": false,
      "elapsed_ms": 1200,
      "code": "auth_required",
      "message": "Provider CLI token has been invalidated. Re-authenticate the LLMHQ worker profile.",
      "retryable": false,
      "auth_status": "refresh_token_reused",
      "diagnostic": "Your authentication token has been invalidated. code: token_invalidated. Failed to refresh token: 401 Unauthorized. code: refresh_token_reused.",
      "attempts": [
        {
          "model": "claude-haiku",
          "worker": "claude-1",
          "status": "failed",
          "code": "auth_required",
          "message": "Provider CLI token has been invalidated. Re-authenticate the LLMHQ worker profile.",
          "retryable": false,
          "auth_status": "refresh_token_reused",
          "diagnostic": "Your authentication token has been invalidated. code: token_invalidated. Failed to refresh token: 401 Unauthorized. code: refresh_token_reused."
        }
      ]
    }
  ]
}
```

The admin WebUI exposes this as the Provider Probe button.

### `POST /admin/provider-login`

Starts an admin provider-login helper inside the LLMHQ API container. This is for provider account authentication, not product-app authentication.

The supported WebUI login flows are Claude browser login and Codex device auth:

```http
POST /admin/provider-login
Content-Type: application/json
```

```json
{
  "provider": "claude",
  "worker": "claude-1",
  "mode": "claudeai"
}
```

```json
{
  "provider": "codex",
  "worker": "codex-1",
  "mode": "device"
}
```

Example response:

```json
{
  "status": "ok",
  "session": {
    "id": "login_lx1abc_1a2b3c",
    "provider": "codex",
    "worker": "codex-1",
    "profileDir": "/app/data/profiles/codex-1",
    "mode": "device",
    "status": "running",
    "output": "Starting Codex device login..."
  }
}
```

Open the printed device URL in any browser, enter the displayed code, and finish Google login. The login process writes the official Codex CLI tokens into the worker profile directory.

For Claude, open the printed Claude OAuth URL and finish the official Claude Code login. The resulting session is written into the selected Claude worker profile directory.

### `GET /admin/provider-login/:sessionId`

Returns the current provider-login session state and accumulated sanitized output.

```http
GET /admin/provider-login/login_lx1abc_1a2b3c
```

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
      "kind": "chat",
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
  -Uri http://127.0.0.1:18088/v1/chat/completions `
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
  "llmhq": {
    "instance_id": "llmhq-host-18-abc123xy",
    "started_at": "2026-05-17T21:55:00.000Z",
    "hostname": "llmhq-host",
    "pid": 18
  },
  "fallback_used": false,
  "fallback_reason": null,
  "attempts": [
    {
      "model": "claude-sonnet",
      "worker": "claude-1",
      "failure_domain": "claude:/app/data/profiles/claude-1",
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

### `POST /v1/embeddings`

Runs a standard embedding request. The default alias is `text-embedding-3-small`; LLMHQ maps that alias to the configured embedding service, `BAAI/bge-small-en-v1.5` through FastEmbed by default.

Request body:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | No | Embedding model alias. Defaults to `LLMHQ_EMBEDDINGS_MODEL`. |
| `input` | string or string array | Yes | Text to embed. |

Example request:

```powershell
$body = @{
  model = "text-embedding-3-small"
  input = @("first text", "second text")
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:18088/v1/embeddings `
  -ContentType "application/json" `
  -Body $body
```

Example response:

```json
{
  "object": "list",
  "model": "text-embedding-3-small",
  "used_model": "BAAI/bge-small-en-v1.5",
  "data": [
    {
      "object": "embedding",
      "index": 0,
      "embedding": [0.0123, -0.0456]
    }
  ],
  "usage": null
}
```

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
  -Uri http://127.0.0.1:18088/v1/conversations/messages `
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

The currently implemented image-output model is:

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
  -Uri http://127.0.0.1:18088/v1/images/generations `
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
  -Uri http://127.0.0.1:18088/v1/assets/img_68760674-64f3-4dc1-8733-f99df8ebc2d1 `
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
    "retryable": false,
    "auth_status": null,
    "diagnostic": null,
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
| `auth_required` | 503 | A provider session, such as Claude CLI, Codex CLI, or ChatGPT browser, is not logged in or usable. |
| `provider_error` | 503 | A provider worker failed. |
| `provider_timeout` | 503 | A provider worker timed out. |
| `model_not_installed` | 503 | An Ollama native model has not been pulled yet. |

Provider failures include `attempts` when the dispatcher reached a provider worker. Each failed attempt includes the same `code`, `message`, `retryable`, `auth_status`, and sanitized `diagnostic` fields as the top-level error. When Codex returns `auth_status: "token_invalidated"` or `auth_status: "refresh_token_reused"`, the request payload reached LLMHQ correctly, but the Codex CLI worker profile must be re-authenticated. Application teams should not change the chat payload shape for that failure.

## Provider Login

Provider login is outside the product application API. It can be done through the admin WebUI or through scripts inside the container/local workspace.

WebUI setup:

1. Open `http://<server-ip>:18089/admin`.
2. Click `Start Claude Login` for Claude workers or `Start Codex Device Login` for Codex workers.
3. Follow the printed official CLI login URL/device-code instructions.
4. Click `Provider Probe` and verify the requested provider model, for example `claude-haiku` or `codex-gpt-5.5`.

Docker setup:

```powershell
docker compose up -d --build
docker compose exec llmhq npm run ollama:pull -- llama3.2
docker compose exec llmhq npm run login:claude -- claude-1
docker compose exec llmhq npm run login:codex -- codex-1
docker compose exec llmhq npm run login:chatgpt:vnc
```

If Claude or Codex reports `auth_required`, `token_invalidated`, or `refresh_token_reused`, run provider login again for the LLMHQ worker profile and verify it with Provider Probe. Do not fix this by copying auth files from another machine or container profile; provider refresh tokens can rotate and copying them can invalidate one of the sessions.

The ChatGPT noVNC helper exposes:

```text
http://127.0.0.1:7900/vnc.html?autoconnect=1&resize=scale
```

Log in interactively with Google in the remote browser, then press Enter in the login command terminal when the ChatGPT prompt box is usable.

Ollama does not require provider login. It does require local model files. The default Compose setup starts `llmhq-ollama` and stores models under `${LLMHQ_OLLAMA_DATA_DIR:-./data/ollama}`. Pull the default native chat model with:

```powershell
docker compose exec llmhq npm run ollama:pull -- llama3.2
```

After the pull, apps can call LLMHQ with:

```json
{
  "model": "ollama-llama3.2",
  "fallback": "default",
  "messages": [{ "role": "user", "content": "Reply with exactly ok." }]
}
```

## Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `LLMHQ_HOST` | `127.0.0.1` | Bind host for local Node runs. Compose uses `0.0.0.0` inside the container. |
| `LLMHQ_PORT` | `8080` | API port. |
| `LLMHQ_AUTH_MODE` | `token` | `token` or `none`. |
| `LLMHQ_API_KEYS` | `dev-local-key` | Comma-separated bearer keys for token mode. |
| `LLMHQ_ASSET_DIR` | `./data/assets` | Generated asset storage. |
| `LLMHQ_CONVERSATION_DIR` | `./data/conversations` | Conversation JSON storage. |
| `LLMHQ_SETTINGS_FILE` | `./data/settings.json` | Runtime model, worker, default model, and fallback settings. |
| `LLMHQ_DEFAULT_CHAT_MODEL` | `claude-sonnet` | Default chat model. |
| `LLMHQ_CHAT_TIMEOUT_MS` | `180000` | Default provider timeout. |
| `LLMHQ_MAX_CONVERSATION_MESSAGES` | `60` | Stateful context window in messages. |
| `LLMHQ_WORKER_FAILURE_COOLDOWN_MS` | `30000` | How long to skip a worker after sticky failures such as `auth_required` or `rate_limited`. |
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
| `LLMHQ_OLLAMA_ENABLED` | `false` | Enables Ollama HTTP chat models. |
| `LLMHQ_OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Base URL for the default Ollama server. Compose sets this to `http://ollama:11434`. |
| `LLMHQ_OLLAMA_WORKERS` | empty | Comma-separated worker specs like `ollama-local=http://ollama:11434`. |
| `LLMHQ_OLLAMA_DEFAULT_MODEL` | `llama3.2` | Native Ollama model backing `ollama-llama3.2`. |
| `LLMHQ_OLLAMA_CODER_MODEL` | `qwen2.5-coder:7b` | Native Ollama model backing the disabled-by-default coder alias. |
| `LLMHQ_OLLAMA_TIMEOUT_MS` | `180000` | Ollama worker timeout. |
| `LLMHQ_EMBEDDINGS_ENABLED` | same as `LLMHQ_OLLAMA_ENABLED` | Enables `/v1/embeddings`. |
| `LLMHQ_EMBEDDINGS_BASE_URL` | `LLMHQ_OLLAMA_BASE_URL` | Embedding service base URL. Compose sets this to `http://embeddings:8080`. |
| `LLMHQ_EMBEDDINGS_MODEL` | `text-embedding-3-small` | Embedding alias served by LLMHQ. |
| `LLMHQ_EMBEDDINGS_NATIVE_MODEL` | `BAAI/bge-small-en-v1.5` | Native FastEmbed model. |
| `LLMHQ_EMBEDDINGS_TIMEOUT_MS` | `LLMHQ_OLLAMA_TIMEOUT_MS` | Embedding request timeout. |
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

### Same-Server Integration Troubleshooting

Use this decision table before changing payload code:

| Symptom | Meaning | Fix |
| --- | --- | --- |
| 100% of `claude-haiku` calls fail with `auth_required` | The request reached LLMHQ and selected the Claude worker, but that LLMHQ instance's Claude profile cannot complete inference. | Run Provider Probe on the exact LLMHQ instance in the error's `llmhq.instance_id`, then use `Start Claude Login` for `claude-1`. |
| Local desktop/CI run uses `http://llmhq:8080` and gets a different `llmhq.instance_id` than Unraid | The caller is resolving a workstation-local Docker container named `llmhq`, not the Unraid LLMHQ instance. | For desktop validation, set `LLMHQ_BASE_URL=http://<server-ip>:18089`; for deployed Unraid containers, keep `http://llmhq:8080`. |
| `ENOTFOUND llmhq` | App container is not on a Docker network where the `llmhq` alias exists yet. | Keep `LLMHQ_BASE_URL=http://llmhq:8080`; verify the `llmhq-network-sync` container is running and wait for it to attach LLMHQ to the app network. |
| Connection refused to `127.0.0.1` from an app container | The app is calling itself, not LLMHQ. | Use `http://llmhq:8080` from containers. |
| Connection refused to `10.0.5.202:18088` from another machine | The host API port is loopback-only by design. | Use `http://10.0.5.202:18089` for desktop validation or `http://10.0.5.202:18089/admin` in a browser; apps on the Unraid host use `http://127.0.0.1:18088`. |
| `invalid_request` | The JSON body does not match the endpoint contract. | Keep OpenAI-style `messages`, `model`, `fallback`, and `stream` fields for `/v1/chat/completions`. |
| `auth_required` with an `attempts` entry | The request reached LLMHQ and selected a provider worker, but the provider CLI account is not authenticated or usable. | Re-login or fix the provider account in LLMHQ; the calling app should not change payload shape. |

If a later fallback attempt shows `status: "skipped"`, LLMHQ intentionally skipped the same worker because it had already failed with sticky provider state in that request or cooldown window.

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
Invoke-RestMethod http://127.0.0.1:18088/health | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:18088/v1/models | ConvertTo-Json -Depth 8
```

Run tests:

```powershell
npm test
npm run ollama:pull -- llama3.2
```

Run provider doctor:

```powershell
npm run doctor
```

or inside Docker:

```powershell
docker compose exec llmhq npm run doctor
```
