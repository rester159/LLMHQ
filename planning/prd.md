# LLMHQ Product Requirements Document

## Summary

LLMHQ is a private local gateway that centralizes LLM access for apps running on the same server. It gives each app a stable API contract while keeping provider CLIs, login profiles, fallback behavior, chat history, and generated assets in one managed service.

## Problem

Multiple product apps currently repeat the same provider setup:

- Install model CLIs or provider wrappers per app.
- Store credentials or browser sessions per app.
- Rebuild fallback behavior per app.
- Store or drop chat context inconsistently.
- Debug provider logout or model changes separately in every app.

This creates operational drift, brittle setup, and duplicated maintenance.

## Goals

- Provide one local API for chat, coding, vision-capable LLM calls, and experimental image generation.
- Let apps select a model explicitly while preserving a default fallback chain.
- Store conversation history centrally when apps do not want to manage it themselves.
- Keep provider login state persistent in one server-side data directory.
- Keep the service private to the host or Docker network by default.
- Return enough metadata for apps to know when fallback happened.

## Non-Goals

- Do not expose LLMHQ publicly on the internet.
- Do not bypass provider subscriptions, login flows, captchas, or rate limits.
- Do not hide provider failures from calling apps.
- Do not require every app to adopt stateful conversations if it already owns chat history.
- Do not make the experimental ChatGPT browser image path look as stable as official APIs.

## Users

- Local product apps running on the same Unraid/server host.
- Developer/admin operating the server.
- Future apps that need LLM calls without provider-specific setup.

## Current Capabilities

| Capability | Status |
| --- | --- |
| Local chat API | Implemented through `POST /v1/chat/completions`. |
| Stateful chat layer | Implemented through `/v1/conversations/messages`. |
| Model aliases | Implemented through `/v1/models`. |
| Explicit model selection | Implemented. |
| Default fallback | Implemented. |
| Claude CLI worker | Implemented with persistent profile. |
| Codex CLI worker | Implemented with persistent profile. |
| ChatGPT browser image worker | Implemented as experimental. |
| Local generated assets | Implemented through `/v1/assets/:assetId`. |
| Same-server auth-free mode | Implemented with `LLMHQ_AUTH_MODE=none`. |
| Bearer API keys | Implemented for non-private deployments. |

## Functional Requirements

### Chat Completion

Apps must be able to send OpenAI-style chat requests:

```http
POST /v1/chat/completions
```

The request must include `messages`. The request may include `model`, `fallback`, `temperature`, `max_tokens`, and `stream`.

The response must include:

- `requested_model`
- `used_model`
- `used_worker`
- `fallback_used`
- `fallback_reason`
- `attempts`
- assistant message content

### Model Selection

Apps must be able to select one of the supported model aliases:

- `claude-haiku`
- `claude-sonnet`
- `claude-opus`
- `codex-gpt-5.5`
- `chatgpt-image-browser` for image generation only

If `model` is omitted for chat, the service uses `LLMHQ_DEFAULT_CHAT_MODEL`, currently `claude-sonnet`.

### Fallback

Fallback must be explicit and observable.

Default behavior:

- `claude-haiku` falls back to `claude-sonnet`, then `codex-gpt-5.5`.
- `claude-sonnet` falls back to `codex-gpt-5.5`.
- `claude-opus` falls back to `claude-sonnet`, then `codex-gpt-5.5`.
- `codex-gpt-5.5` falls back to `claude-sonnet`.

Apps may disable fallback with:

```json
{ "fallback": "none" }
```

or:

```json
{ "fallback": false }
```

Apps may force a custom fallback model by passing `fallback`.

### Stateful Conversations

Apps must be able to let LLMHQ own chat context by sending:

```http
POST /v1/conversations/messages
```

Required fields:

- `project_id`
- `conversation_key`
- `message`

Optional fields:

- `title`
- `default_model`
- `model`
- `fallback`
- `metadata`

LLMHQ must create the conversation on first use and append future turns to the same conversation when the same `project_id + conversation_key` is used.

### Conversation Inspection

Apps and admin tools must be able to list and inspect stored conversations:

```http
GET /v1/conversations?project_id=...
GET /v1/conversations/:conversationId
```

### Image Generation

Apps may request images through:

```http
POST /v1/images/generations
```

The currently supported model is:

```json
{ "model": "chatgpt-image-browser" }
```

The response must return a local `asset_id` and a URL under `/v1/assets/:assetId`.

This route is experimental and may fail with `auth_required`, provider UI errors, rate limits, or timeouts.

### Health

The service must expose:

```http
GET /health
```

Health must report configured providers and profile paths without exposing secrets.

## Network Requirements

Default Compose behavior:

- Bind host API to `127.0.0.1:8080`.
- Attach the service to private Docker network `llmhq_private`.
- Let same-network product containers use `http://llmhq:8080`.
- Expose noVNC login helper only on `127.0.0.1:7900`.

## Security Requirements

- Use `LLMHQ_AUTH_MODE=none` only for host-local or private Docker network access.
- Use bearer API keys if the service is reachable outside that boundary.
- Do not store Google passwords.
- Store provider session state only in persistent profile folders under `./data`.
- Do not log full credentials, bearer keys, or OAuth tokens.

## Reliability Requirements

- Provider failures must not silently disappear.
- Every successful response after a fallback must identify the original requested model and the final used model.
- Every failed response should include provider attempts where possible.
- CLI/browser profiles must be persistent across container restarts.
- Docker service should use `restart: unless-stopped`.

## Performance Requirements

- Product apps should use the Docker service name `http://llmhq:8080` when on the same Docker network.
- Host apps should use `http://127.0.0.1:8080`.
- LLMHQ should avoid heavy app-side proxy logic. Apps should send one local HTTP request and let LLMHQ manage routing.

## Acceptance Criteria

- `GET /health` returns `status: "ok"` and lists Claude, Codex, and configured ChatGPT image worker.
- `GET /v1/models` returns all model aliases and fallback chains.
- A stateless chat request to `claude-sonnet` returns a valid chat completion.
- A stateless chat request to `codex-gpt-5.5` returns a valid chat completion.
- A stateful request to `/v1/conversations/messages` creates or reuses a conversation and appends the turn.
- `GET /v1/conversations?project_id=...` returns stored conversations for that project.
- An image request either returns a stored asset or returns a clear provider error such as `auth_required`.
- A provider failure surfaces in `attempts` and uses fallback when fallback is enabled.

## Future Work

- Add a small admin UI for model health, login status, conversations, and assets.
- Add per-project quotas and usage logs.
- Add per-project API keys if LLMHQ is used beyond a fully private network.
- Add a formal vision endpoint for image input once the target provider contract is stable.
- Add backup/restore instructions for `./data`.
- Add retention policy controls for conversations and generated assets.

