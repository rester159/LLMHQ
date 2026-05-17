# LLMHQ

LLMHQ is a private local gateway for shared LLM access across apps running on the same Unraid/server host.

This first slice implements a local chat/coding gateway for Claude Code and Codex CLI workers, plus an experimental ChatGPT image-generation route as a browser-backed worker. The browser route is intentionally marked experimental because it depends on the ChatGPT web UI session staying logged in and the UI remaining automatable.

## What Is Implemented

- `POST /v1/images/generations` accepts a prompt and returns a stored local image asset.
- `POST /v1/chat/completions` accepts OpenAI-style chat requests for regular LLM/coding activity.
- `POST /v1/conversations/messages` lets LLMHQ own chat history by project/workflow key.
- `POST /v1/conversations` creates or resolves a named project conversation.
- `GET /v1/models` lists configured models and fallback chains.
- `GET /v1/conversations` lists stored conversations, optionally filtered by `project_id`.
- `GET /v1/assets/:assetId` serves generated assets from local disk.
- `GET /health` reports gateway instance identity and worker health.
- `GET /admin` serves the server admin WebUI.
- Bearer API keys gate requests by default. Configure keys with `LLMHQ_API_KEYS`.
- Same-server deployments can set `LLMHQ_AUTH_MODE=none` when LLMHQ is bound only to localhost or a private Docker network.
- The real ChatGPT browser worker is disabled unless `LLMHQ_EXPERIMENTAL_CHATGPT_BROWSER=1`.

## Documentation

- [API documentation](docs/api-documentation.md)
- [Technical architecture](planning/technical-architecture.md)
- [Product requirements](planning/prd.md)
- [App refactoring prompt](docs/refactoring-prompt.md)
- [Security notes](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## Setup

```powershell
npm install
Copy-Item .env.example .env
npm run key:generate my-first-app
npm run doctor
npm run login:claude -- claude-1
npm run login:codex -- codex-1
npm run login:chatgpt:vnc
npm test
npm start
```

The generated key is the wrapper key. Put it in `.env` as `LLMHQ_API_KEYS=...`, then pass it from product apps as `Authorization: Bearer ...`.

For the quickest same-server path, set this instead:

```env
LLMHQ_HOST=127.0.0.1
LLMHQ_AUTH_MODE=none
```

Then product apps on the same host can call LLMHQ without an `Authorization` header. In the default Compose setup, LLMHQ also runs a small server-local network sync service that connects the `llmhq` container to user-defined Docker bridge networks on the same server. Product containers can use `http://llmhq:8080` without joining a special LLMHQ network themselves. Host-native processes can use the loopback-only port `http://127.0.0.1:18088`. The Unraid WebUI entry opens the admin UI at `http://[IP]:[PORT:18089]/admin`.

The WebUI container also proxies generic `/v1/*` API requests to the internal gateway. This gives desktop validation runners and browser-visible tools one deliberate LAN URL for the same working Unraid instance:

```env
LLMHQ_BASE_URL=http://<server-ip>:18089
```

Same-server containers should still prefer `http://llmhq:8080`; the WebUI proxy is for callers that are not on the Unraid Docker networks and would otherwise accidentally resolve a different local `llmhq` container.

`npm run login:chatgpt:vnc` opens a persistent Playwright browser profile at `LLMHQ_CHATGPT_PROFILE_DIR` and exposes it through noVNC. If you publish the noVNC port for local setup, open `http://127.0.0.1:7900/vnc.html?autoconnect=1&resize=scale`. Log in manually with Google, then press Enter in the terminal. LLMHQ will reuse that browser profile for image generation.

`npm run login:claude -- claude-1` and `npm run login:codex -- codex-1` log each subscription CLI into its own persistent profile.

Google/SSO login is expected to be interactive. LLMHQ does not store your Google password; it only preserves the OAuth/session tokens that the official CLIs save in each worker profile directory. If Claude needs an SSO-style flow, set `LLMHQ_CLAUDE_LOGIN_ARGS=--sso` before running the Claude login command. If Codex supports device-code auth in your environment, set `LLMHQ_CODEX_LOGIN_ARGS=--device-auth` before running the Codex login command.

For Unraid/container setup, the practical flow is:

```powershell
docker compose up -d --build
docker compose exec llmhq npm run login:claude -- claude-1
docker compose exec llmhq npm run login:codex -- codex-1
docker compose exec llmhq npm run login:chatgpt:vnc
docker compose exec llmhq npm run doctor
```

Follow the OAuth URL/device-code prompts from your normal browser. The resulting tokens live under `./data/profiles/...`, so keep `./data` backed up and persistent.

If a downstream app receives `auth_required` with `auth_status` such as `token_invalidated` or `refresh_token_reused`, the app is calling LLMHQ correctly and the provider worker profile needs re-login inside LLMHQ. Do not copy Codex auth files between machines or containers; refresh-token reuse can invalidate a session. Re-run the LLMHQ Codex login for the affected worker and then use the WebUI Provider Probe to confirm the route.

## Chat/Coding Calls

From each host-native product app, configure only the LLMHQ base URL:

```env
LLMHQ_BASE_URL=http://127.0.0.1:18088
```

If the product app is another container on the same server, use the LLMHQ service/container name instead:

```env
LLMHQ_BASE_URL=http://llmhq:8080
```

Then call the wrapper over HTTP.

## Admin WebUI

The Compose deployment publishes a browser-facing admin UI and `/v1/*` API proxy on:

```text
http://<server-ip>:18089/admin
```

The `llmhq` and `llmhq-webui` containers include the Unraid label:

```yaml
net.unraid.docker.webui: "http://[IP]:[PORT:18089]/admin"
```

That makes the WebUI action available from the Unraid Docker container menu. The UI shows gateway status, configured provider accounts, model aliases, fallback chains, provider login actions, and the editable runtime settings JSON. Saving runtime settings writes `LLMHQ_SETTINGS_FILE` and hot-swaps the live model registry without restarting LLMHQ.

```powershell
$body = @{
  model = "claude-sonnet"
  fallback = "default"
  messages = @(
    @{ role = "system"; content = "You are a concise coding assistant." },
    @{ role = "user"; content = "Review this function for bugs." }
  )
  stream = $false
} | ConvertTo-Json -Depth 5

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:18088/v1/chat/completions `
  -ContentType "application/json" `
  -Body $body
```

Available v1 chat model aliases:

- `claude-haiku`
- `claude-sonnet`
- `claude-opus`
- `codex-gpt-5.5`
- `codex-gpt-5.5-vision`

Fallback is explicit. If `claude-opus` fails and `claude-sonnet` succeeds, the response includes `requested_model`, `used_model`, `llmhq`, `fallback_used`, `fallback_reason`, and `attempts`.

Use `codex-gpt-5.5` for Codex text/code turns. Use `codex-gpt-5.5-vision` for Codex image-input turns that include `image_url` message parts pointing at local image paths. Use `chatgpt-image-browser` through `/v1/images/generations` for image output.

For live "current action" UI, send `stream = $true` and `status_events = $true`. LLMHQ will emit named SSE `status` events with generic fields like `stage`, `message`, `model`, `worker`, and `created` before the final assistant chunk.

## Conversation Storage

Apps can choose either mode:

- Stateless: app sends the full `messages` array to `/v1/chat/completions`.
- Stateful: app sends `project_id + conversation_key` to `/v1/conversations/messages`, and LLMHQ stores/replays the chat history.
- Stateful with app context: app also sends a generic `context` object with stable application context. LLMHQ stores that context separately from chat turns and prepends it to future model calls for the same conversation.

For apps that do not want to store chat context, use a stable key per workflow:

```env
LLMHQ_PROJECT_ID=soundpulse
LLMHQ_CONVERSATION_KEY=strategy-generator
```

Then call:

```powershell
$body = @{
  project_id = "soundpulse"
  conversation_key = "strategy-generator"
  title = "Strategy Generator"
  default_model = "claude-sonnet"
  context = @{
    summary = "Workflow-level context that should stay stable across turns."
    metadata = @{
      app = "soundpulse"
      workflow = "strategy-generator"
    }
    messages = @(
      @{ role = "system"; content = "Use the application-provided strategy context before chat history." }
    )
  }
  fallback = "default"
  message = @{
    role = "user"
    content = "Create a release strategy for this song."
  }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:18088/v1/conversations/messages `
  -ContentType "application/json" `
  -Body $body
```

LLMHQ will create the conversation on the first call, reuse it on later calls with the same `project_id + conversation_key`, append the user/assistant turn, and return:

```json
{
  "conversation": {
    "id": "conv_...",
    "project_id": "soundpulse",
    "conversation_key": "strategy-generator",
    "context_message_count": 2,
    "message_count": 2
  },
  "chat_completion": {
    "choices": [
      {
        "message": {
          "role": "assistant",
          "content": "..."
        }
      }
    ],
    "used_model": "claude-sonnet",
    "fallback_used": false,
    "context_message_count": 2
  }
}
```

If the app already has a `conversation.id`, it can continue directly:

```http
POST /v1/conversations/{conversation_id}/messages
```

To inspect stored conversations:

```http
GET /v1/conversations?project_id=soundpulse
GET /v1/conversations/{conversation_id}
```

## Generate An Image

```powershell
$body = @{
  model = "chatgpt-image-browser"
  prompt = "Create a square product photo of a matte black mechanical keyboard on a clean desk"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:18088/v1/images/generations `
  -ContentType "application/json" `
  -Body $body
```

## Operational Notes

- The default Compose setup exposes the gateway to same-server containers as `http://llmhq:8080` by automatically connecting the `llmhq` container to user-defined Docker bridge networks.
- The default Compose setup also publishes a host-local port as `http://127.0.0.1:18088`; it is bound to loopback and is not exposed to the LAN.
- The default Compose setup publishes the admin WebUI on `http://<server-ip>:18089/admin`, proxies `/v1/*` through the same port for deliberate LAN validation, and adds the Unraid `net.unraid.docker.webui` label.
- Runtime model aliases, provider profile directories, provider-native model arguments, default model, and fallback chains are stored in `./data/settings.json` by default and can be edited through the admin WebUI.
- The admin WebUI includes Provider Login for Claude and Codex device auth, plus Provider Probe for visible provider-session checks. Provider Probe sends a minimal request per provider and exposes `auth_required` as an LLMHQ/provider-session problem before product apps hit it.
- Provider failure responses include `retryable`, `auth_status`, and sanitized `diagnostic` fields so product apps can report provider account problems accurately instead of treating them as payload format errors.
- If a provider worker fails with sticky state such as `auth_required`, LLMHQ marks that worker unavailable briefly and skips other aliases using the same failure domain so fallback can reach a different provider faster. Downstream apps should log `llmhq.instance_id` and `attempts[].failure_domain` so app failures can be matched to the exact LLMHQ process and provider profile that served them.
- Claude and Codex workers use persistent profile directories under `./data/profiles/...`.
- Stored conversations live under `./data/conversations`.
- Run `npm run doctor` or `docker compose exec llmhq npm run doctor` to verify CLI availability.
- On Windows, if `codex` resolves to a Microsoft Store shim and reports `Access is denied`, set `LLMHQ_CODEX_COMMAND` to the real binary path, for example `C:\Users\edang\AppData\Local\OpenAI\Codex\bin\codex.exe`.
- This route does not bypass login, captcha, bot checks, or subscription limits.
- If the browser session is logged out, the worker reports `auth_required`.
- The captured image is fetched from the rendered ChatGPT page when possible. If that fails, the worker falls back to a screenshot of the rendered image element.
- For Unraid, this should run behind a private Docker network or host-local port only.

## Docker/Unraid

```powershell
docker compose build
docker compose up -d
docker compose logs -f llmhq
```

Other product containers on the same server can use:

```env
LLMHQ_BASE_URL=http://llmhq:8080
```

The `llmhq-network-sync` sidecar watches Docker events and connects the `llmhq` container to user-defined bridge networks with the `llmhq` network alias. This keeps app containers isolated on their own networks while making LLMHQ reachable from each app network. It mounts `/var/run/docker.sock` so it should only run on a trusted local server.

Host-native processes on the same server can use:

```env
LLMHQ_BASE_URL=http://127.0.0.1:18088
```

For Unraid-style layouts where source and data live in sibling folders, set:

```env
LLMHQ_DATA_DIR=/mnt/user/appdata/llmhq/data
```
