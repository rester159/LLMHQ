# Contributing

LLMHQ is currently a small local-first gateway. Keep changes scoped, tested, and explicit about provider behavior.

## Development

```powershell
npm install
npm test
npm run doctor
```

For Docker:

```powershell
docker compose up -d --build
docker compose logs -f llmhq
```

## Guidelines

- Do not commit `.env`, `data`, provider profiles, OAuth/session files, or generated assets.
- Keep provider failures visible in API responses.
- Keep model aliases stable unless a breaking change is documented.
- Prefer focused tests in `test/app.test.js` for route and fallback behavior.
- Mark browser-automation behavior as experimental unless it has a stable provider API behind it.

