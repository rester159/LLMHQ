export function authenticateRequest({ apiKeys, authMode = "token" }) {
  const allowed = new Set(apiKeys);

  return async function authHook(request, reply) {
    if (request.url === "/health") {
      return;
    }

    if (authMode === "none") {
      return;
    }

    if (authMode !== "token") {
      return reply.code(500).send({
        error: {
          code: "invalid_auth_mode",
          message: `Unsupported LLMHQ_AUTH_MODE: ${authMode}`,
        },
      });
    }

    const authorization = request.headers.authorization || "";
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match || !allowed.has(match[1])) {
      return reply.code(401).send({
        error: {
          code: "unauthorized",
          message: "Missing or invalid LLMHQ bearer token.",
        },
      });
    }
  };
}
