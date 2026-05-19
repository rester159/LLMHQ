# LLMHQ API Documentation

## Scope

This document describes the public HTTP contract for product apps calling LLMHQ and the operational API surface used by the admin UI. It reflects the local Unraid/Docker deployment where LLMHQ runs alongside provider workers, an Ollama sidecar, persistent provider profiles, file-backed conversations, and generated assets.

## Base URLs

| Caller | Base URL | Notes |
| --- | --- | --- |
| Host-native app on the server | `http://127.0.0.1:18088` | Loopback-only Compose port. |
| Product container on the same server | `http://llmhq:8080` | Preferred same-server Docker path. |
| Browser/admin access | `http://<server-ip>:18089/admin` | Admin WebUI. |
| LAN validation runner | `http://<server-ip>:18089` | WebUI proxy for deliberate `/v1/*` validation calls. |

Same-server containers should use `http://llmhq:8080`. The LAN WebUI proxy is for desktop validation or tools that cannot join the server Docker networks.

## Authentication

LLMHQ supports two modes:

| Mode | Header | Use case |
| --- | --- | --- |
| `LLMHQ_AUTH_MODE=none` | none | Localhost or private Docker network only. |
| `LLMHQ_AUTH_MODE=token` | `Authorization: Bearer <key>` | Any deployment where untrusted callers might reach LLMHQ. |

Generate wrapper keys with:

```powershell
npm run key:generate my-app
```

## Providers And Model Aliases

Apps call model aliases. They do not call provider-native model names directly.

| Alias | Endpoint | Provider | Native model | Output | Notes |
| --- | --- | --- | --- | --- | --- |
| `claude-haiku` | `/v1/chat/completions` | Claude CLI | `haiku` | text | Fast Claude alias. |
| `claude-sonnet` | `/v1/chat/completions` | Claude CLI | `sonnet` | text | Default smart chat alias. |
| `claude-opus` | `/v1/chat/completions` | Claude CLI | `opus` | text | Deep reasoning alias. |
| `codex-gpt-5.5` | `/v1/chat/completions` | Codex CLI | `gpt-5.5` | text | Coding/text alias. |
| `codex-gpt-5.5-vision` | `/v1/chat/completions` | Codex CLI | `gpt-5.5` | text | Image-input alias. |
| `ollama-llama3.2` | `/v1/chat/completions` | Ollama HTTP | `llama3.2` | text | Local/private model alias. |
| `ollama-qwen2.5-coder` | `/v1/chat/completions` | Ollama HTTP | `qwen2.5-coder:7b` | text | Disabled by default until pulled/enabled. |
| `chatgpt-image-browser` | `/v1/images/generations` | ChatGPT browser | web session | image | Experimental image route. |

Fetch live aliases:

```http
GET /v1/models
```

## Ollama Setup

Compose starts the official Ollama container as `llmhq-ollama` and connects it to the same private network as LLMHQ.

Default Ollama service path:

```text
http://ollama:11434
```

Default persistent model store:

```text
${LLMHQ_OLLAMA_DATA_DIR:-./data/ollama}
```

Pull the default native model:

```powershell
docker compose up -d ollama
docker compose exec llmhq npm run ollama:pull -- llama3.2
```

Then call:

```json
{
  "model": "ollama-llama3.2",
  "fallback": "default",
  "messages": [
    { "role": "user", "content": "Reply with exactly ok." }
  ]
}
```

If the native model has not been pulled, LLMHQ returns `model_not_installed` and, when fallback is enabled, attempts the configured fallback chain.

## Fallback

Fallback is visible and configurable per request.

Default fallback chains:

| Requested model | Fallback chain |
| --- | --- |
| `claude-haiku` | `claude-sonnet`, `codex-gpt-5.5` |
| `claude-sonnet` | `codex-gpt-5.5` |
| `claude-opus` | `claude-sonnet`, `codex-gpt-5.5` |
| `codex-gpt-5.5` | `claude-sonnet` |
| `codex-gpt-5.5-vision` | none |
| `ollama-llama3.2` | `claude-sonnet` |
| `ollama-qwen2.5-coder` | `codex-gpt-5.5`, `claude-sonnet` |
| `chatgpt-image-browser` | none |

Normal calls should send:

```json
{ "fallback": "default" }
```

Disable fallback:

```json
{ "fallback": "none" }
```

or:

```json
{ "fallback": false }
```

Custom fallback:

```json
{ "fallback": ["ollama-llama3.2", "claude-sonnet"] }
```

Every chat completion includes `requested_model`, `used_model`, `used_worker`, `fallback_used`, `fallback_reason`, and `attempts`.

## Chat Completion

### `POST /v1/chat/completions`

Use for stateless chat, coding, analysis, classification, summarization, and local Ollama calls.

Request fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `model` | string | No | Defaults to runtime default chat model. |
| `messages` | array | Yes | Non-empty chat message list. |
| `fallback` | string, array, boolean | No | Defaults to `"default"`. |
| `temperature` | number | No | Passed through where supported. |
| `max_tokens` | number | No | Passed through where supported. Ollama maps this to `num_predict`. |
| `stream` | boolean | No | Sends SSE. Current stream emits full content chunks, not token-by-token provider streaming. |
| `status_events` | boolean | No | When streaming, emits named `status` events for current action updates. |

Example:

```powershell
$body = @{
  model = "ollama-llama3.2"
  fallback = "default"
  messages = @(
    @{ role = "system"; content = "You are concise." },
    @{ role = "user"; content = "Explain local LLM routing in one sentence." }
  )
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:18088/v1/chat/completions `
  -ContentType "application/json" `
  -Body $body
```

Response:

```json
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "model": "ollama-llama3.2",
  "requested_model": "ollama-llama3.2",
  "used_model": "ollama-llama3.2",
  "used_worker": "ollama-local",
  "fallback_used": false,
  "fallback_reason": null,
  "attempts": [
    {
      "model": "ollama-llama3.2",
      "worker": "ollama-local",
      "failure_domain": "ollama:http://ollama:11434",
      "status": "succeeded"
    }
  ],
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "..."
      }
    }
  ]
}
```

Read assistant text from:

```text
choices[0].message.content
```

## Stateful Conversations

### `POST /v1/conversations/messages`

Use when the app does not want to store chat history itself.

Request fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `project_id` | string | Required unless `conversation_id` is used | Stable app id. |
| `conversation_key` | string | Required unless `conversation_id` is used | Stable workflow/thread key. |
| `conversation_id` | string | No | Continue an existing conversation by id. |
| `title` | string | No | Title used on first create. |
| `default_model` | string | No | Conversation default model. |
| `model` | string | No | Per-turn model override. |
| `fallback` | string, array, boolean | No | Defaults to `"default"`. |
| `message` | object | Required unless `messages` is used | One new message. |
| `messages` | array | Required unless `message` is used | Batch of new input messages. |
| `context` | object | No | Stable app-provided context stored outside chat turns. |
| `workspace` | object | No | Optional workspace retrieval/tool mode. |
| `metadata` | object | No | Stored with the conversation on create. |

Response includes:

- `conversation`: summarized stored conversation.
- `workspace`: retrieved workspace data when a workspace request is supplied.
- `chat_completion`: normal chat completion response plus conversation identifiers.

### `POST /v1/conversations/:conversationId/messages`

Same turn behavior as `/v1/conversations/messages`, but the conversation is resolved by id.

### Conversation Reads

```http
POST /v1/conversations
GET /v1/conversations?project_id=<project>
GET /v1/conversations/:conversationId
```

`POST /v1/conversations` is idempotent for the same `project_id + conversation_key`.

## Image Generation

### `POST /v1/images/generations`

Current supported model:

```json
{ "model": "chatgpt-image-browser" }
```

Response returns an `asset_id` and relative `url`.

### `GET /v1/assets/:assetId`

Returns a generated local asset. Assets are stored under `./data/assets` with JSON metadata sidecars.

## Health And Admin

### `GET /health`

Returns:

- `status`
- LLMHQ instance identity
- auth mode
- provider workers, including configured Claude, Codex, Ollama, and ChatGPT browser workers

### `GET /admin/settings`

Returns editable runtime settings and the rebuilt model list.

### `PUT /admin/settings`

Validates settings, writes `LLMHQ_SETTINGS_FILE`, and hot-swaps the live registry.

Settings can edit:

- `defaultModel`
- `workers.claude[]`
- `workers.codex[]`
- `workers.ollama[]`
- `models.<alias>.enabled`
- `models.<alias>.provider`
- `models.<alias>.cliModel`
- capabilities, outputs, and fallback chains

### `POST /admin/provider-probe`

Runs one minimal request per provider and reports usability. Ollama probe verifies that its configured native model can answer; if not pulled, it reports `model_not_installed`.

## Error Shape

```json
{
  "error": {
    "code": "model_not_installed",
    "message": "Ollama model llama3.2 is not installed. Pull it inside the Ollama container, then retry.",
    "retryable": false,
    "auth_status": null,
    "diagnostic": "model not found",
    "details": {},
    "attempts": []
  }
}
```

Common codes:

| Code | Meaning |
| --- | --- |
| `invalid_request` | Request shape is invalid. |
| `unknown_model` | Requested LLMHQ alias does not exist. |
| `model_not_installed` | Ollama native model has not been pulled. |
| `auth_required` | Provider login/session is missing or invalid. |
| `rate_limited` | Provider account is rate limited. |
| `worker_timeout` | Provider worker timed out. |
| `provider_error` | Provider worker failed for another reason. |

## Environment Variables

| Variable | Description |
| --- | --- |
| `LLMHQ_HOST`, `LLMHQ_PORT` | API bind address and port inside the runtime. |
| `LLMHQ_AUTH_MODE`, `LLMHQ_API_KEYS` | Wrapper auth mode and bearer keys. |
| `LLMHQ_SETTINGS_FILE` | Runtime model settings JSON path. |
| `LLMHQ_DEFAULT_CHAT_MODEL` | Default model when a request omits `model`. |
| `LLMHQ_CLAUDE_*` | Claude CLI command, workers, profile paths, and native model names. |
| `LLMHQ_CODEX_*` | Codex CLI command, workers, workdir, and native model name. |
| `LLMHQ_OLLAMA_ENABLED` | Enables Ollama aliases. |
| `LLMHQ_OLLAMA_BASE_URL` | Default Ollama base URL. Compose sets `http://ollama:11434`. |
| `LLMHQ_OLLAMA_WORKERS` | Comma-separated endpoint workers, for example `ollama-local=http://ollama:11434`. |
| `LLMHQ_OLLAMA_DEFAULT_MODEL` | Native model backing `ollama-llama3.2`. |
| `LLMHQ_OLLAMA_CODER_MODEL` | Native model backing optional `ollama-qwen2.5-coder`. |
| `LLMHQ_OLLAMA_TIMEOUT_MS` | Ollama worker timeout. |
| `LLMHQ_EXPERIMENTAL_CHATGPT_BROWSER` | Enables browser-backed image generation. |

## Operational Verification

```powershell
docker compose up -d --build
docker compose exec llmhq npm run ollama:pull -- llama3.2
docker compose exec llmhq npm run doctor
Invoke-RestMethod http://127.0.0.1:18088/health | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:18088/v1/models | ConvertTo-Json -Depth 8
```

