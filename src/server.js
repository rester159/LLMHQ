import Fastify from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildProxyApp } from "./proxyApp.js";

const config = loadConfig();
const proxyTarget = String(process.env.LLMHQ_PROXY_TARGET || "").trim();
const app = proxyTarget
  ? await buildProxyApp({
      fastify: Fastify({ logger: true }),
      targetUrl: proxyTarget,
    })
  : await buildApp({
      fastify: Fastify({ logger: true }),
      config,
    });

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
