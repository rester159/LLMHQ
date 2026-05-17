import Fastify from "fastify";

const DEFAULT_PROXY_TARGET = "http://10.0.5.202:18089";

export async function buildProxyApp({
  fastify,
  targetUrl = process.env.LLMHQ_PROXY_TARGET || DEFAULT_PROXY_TARGET,
  fetchImpl = fetch,
} = {}) {
  const app = fastify || Fastify({ logger: true });
  const target = normalizeBaseUrl(targetUrl);

  app.all("/*", async (request, reply) => {
    const upstream = await fetchImpl(proxyUrl(target, request.raw.url || request.url), {
      method: request.method,
      headers: proxyHeaders(request.headers),
      body: proxyBody(request),
    });

    if (request.url === "/health" && upstream.ok) {
      const summary = await upstream.json();
      return reply
        .code(200)
        .header("x-llmhq-proxy-target", target)
        .send(summary.health || summary);
    }

    reply.code(upstream.status || 502).header("x-llmhq-proxy-target", target);
    const contentType = upstream.headers?.get?.("content-type");
    if (contentType) {
      reply.header("content-type", contentType);
    }
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });

  return app;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_PROXY_TARGET).replace(/\/+$/, "");
}

function proxyUrl(target, rawUrl) {
  const url = new URL(rawUrl || "/", target);
  url.pathname = proxyPath(url.pathname);
  return url;
}

function proxyPath(pathname) {
  if (pathname === "/health") {
    return "/admin/api/summary";
  }
  if (pathname === "/admin/settings") {
    return "/admin/api/settings";
  }
  if (pathname === "/admin/settings/reload") {
    return "/admin/api/settings/reload";
  }
  if (pathname === "/admin/provider-probe") {
    return "/admin/api/provider-probe";
  }
  if (pathname === "/admin/provider-login") {
    return "/admin/api/provider-login";
  }
  if (pathname.startsWith("/admin/provider-login/")) {
    return `/admin/api${pathname}`;
  }
  return pathname;
}

function proxyHeaders(headers) {
  const forwarded = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = key.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding"].includes(normalized)) {
      continue;
    }
    forwarded[key] = value;
  }
  return forwarded;
}

function proxyBody(request) {
  if (["GET", "HEAD"].includes(request.method)) {
    return undefined;
  }
  if (request.body === undefined) {
    return undefined;
  }
  if (Buffer.isBuffer(request.body) || typeof request.body === "string") {
    return request.body;
  }
  return JSON.stringify(request.body);
}
