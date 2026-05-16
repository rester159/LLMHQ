# Security

LLMHQ is designed for private same-server use.

## Supported Deployment Boundary

Recommended deployment:

- Bind the host API to `127.0.0.1:8080`.
- Connect product containers through the private `llmhq_private` Docker network.
- Keep noVNC login exposed only on `127.0.0.1:7900`.

Do not expose LLMHQ directly to the internet.

## Secrets And Sessions

Do not commit:

- `.env`
- `data/`
- provider CLI profiles
- ChatGPT browser profiles
- generated assets
- API keys or OAuth/session tokens

Provider sessions are stored under `./data` when using the default Compose setup.

## Auth Modes

`LLMHQ_AUTH_MODE=none` is only appropriate for localhost or private Docker networks.

Use `LLMHQ_AUTH_MODE=token` and `LLMHQ_API_KEYS` if the service is reachable outside a trusted local boundary.

## Reporting Issues

For private deployments, rotate wrapper keys and provider sessions if credentials may have been exposed.

