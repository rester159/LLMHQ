# Security

LLMHQ is designed for private same-server use.

## Supported Deployment Boundary

Recommended deployment:

- Bind the host API to a loopback-only port such as `127.0.0.1:18088`.
- Let the `llmhq-network-sync` sidecar connect the `llmhq` container to same-server app networks with the `llmhq` alias.
- Expose only the read-only admin WebUI to the LAN, such as `http://<server-ip>:18089/admin`.
- Keep noVNC login exposed only on `127.0.0.1:7900`.

Do not expose LLMHQ directly to the internet.

The default Compose setup mounts `/var/run/docker.sock` into `llmhq-network-sync` so it can attach LLMHQ to local Docker networks automatically. Docker socket access is host-admin equivalent; run this only on a trusted local server. Disable the sidecar or keep explicit networks if the deployment boundary is not trusted.

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

The admin WebUI service is separate from the private API port. It exposes read-only status/model summaries and does not proxy chat, image, or conversation mutation endpoints.

## Reporting Issues

For private deployments, rotate wrapper keys and provider sessions if credentials may have been exposed.
