import Fastify from "fastify";
import { fileURLToPath } from "node:url";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:8080";

export async function buildAdminApp({
  fastify,
  llmhqBaseUrl = process.env.LLMHQ_ADMIN_API_BASE_URL || DEFAULT_API_BASE_URL,
  fetchImpl = fetch,
} = {}) {
  const app = fastify || Fastify({ logger: true });
  const apiBaseUrl = normalizeBaseUrl(llmhqBaseUrl);

  app.get("/", async (_request, reply) => {
    return reply.redirect("/admin");
  });

  app.get("/health", async () => {
    return { status: "ok", service: "llmhq-admin", api_base_url: apiBaseUrl };
  });

  app.get("/admin", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(adminHtml({ apiBaseUrl }));
  });

  app.get("/admin/api/summary", async (_request, reply) => {
    try {
      const [health, models, settings] = await Promise.all([
        fetchJson(fetchImpl, apiBaseUrl, "/health"),
        fetchJson(fetchImpl, apiBaseUrl, "/v1/models"),
        fetchJson(fetchImpl, apiBaseUrl, "/admin/settings"),
      ]);

      return reply.send({
        status: "ok",
        fetched_at: new Date().toISOString(),
        api_base_url: apiBaseUrl,
        health,
        models: Array.isArray(models?.data) ? models.data : [],
        settings: settings?.settings || null,
        editable: settings?.editable !== false,
      });
    } catch (error) {
      return reply.code(502).send({
        status: "error",
        error: {
          code: "llmhq_unreachable",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.put("/admin/api/settings", async (request, reply) => {
    try {
      const saved = await fetchJson(fetchImpl, apiBaseUrl, "/admin/settings", {
        method: "PUT",
        body: request.body?.settings || request.body || {},
      });
      const health = await fetchJson(fetchImpl, apiBaseUrl, "/health");
      return reply.send({
        status: "ok",
        fetched_at: new Date().toISOString(),
        api_base_url: apiBaseUrl,
        health,
        models: Array.isArray(saved?.models) ? saved.models : [],
        settings: saved?.settings || null,
        editable: saved?.editable !== false,
      });
    } catch (error) {
      return reply.code(502).send({
        status: "error",
        error: {
          code: "llmhq_settings_save_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post("/admin/api/settings/reload", async (_request, reply) => {
    try {
      const reloaded = await fetchJson(fetchImpl, apiBaseUrl, "/admin/settings/reload", { method: "POST" });
      const health = await fetchJson(fetchImpl, apiBaseUrl, "/health");
      return reply.send({
        status: "ok",
        fetched_at: new Date().toISOString(),
        api_base_url: apiBaseUrl,
        health,
        models: Array.isArray(reloaded?.models) ? reloaded.models : [],
        settings: reloaded?.settings || null,
        editable: reloaded?.editable !== false,
      });
    } catch (error) {
      return reply.code(502).send({
        status: "error",
        error: {
          code: "llmhq_settings_reload_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post("/admin/api/provider-probe", async (request, reply) => {
    try {
      const probe = await fetchJson(fetchImpl, apiBaseUrl, "/admin/provider-probe", {
        method: "POST",
        body: request.body || {},
      });
      const health = await fetchJson(fetchImpl, apiBaseUrl, "/health");
      const models = await fetchJson(fetchImpl, apiBaseUrl, "/v1/models");
      return reply.send({
        status: probe.status || "ok",
        fetched_at: new Date().toISOString(),
        api_base_url: apiBaseUrl,
        health,
        models: Array.isArray(models?.data) ? models.data : [],
        results: Array.isArray(probe?.results) ? probe.results : [],
      });
    } catch (error) {
      return reply.code(502).send({
        status: "error",
        error: {
          code: "llmhq_provider_probe_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.post("/admin/api/provider-login", async (request, reply) => {
    try {
      const login = await fetchJson(fetchImpl, apiBaseUrl, "/admin/provider-login", {
        method: "POST",
        body: request.body || {},
      });
      return reply.send(login);
    } catch (error) {
      return reply.code(502).send({
        status: "error",
        error: {
          code: "llmhq_provider_login_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  app.get("/admin/api/provider-login/:sessionId", async (request, reply) => {
    try {
      const login = await fetchJson(fetchImpl, apiBaseUrl, `/admin/provider-login/${encodeURIComponent(request.params.sessionId)}`);
      return reply.send(login);
    } catch (error) {
      return reply.code(502).send({
        status: "error",
        error: {
          code: "llmhq_provider_login_status_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  return app;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_API_BASE_URL).replace(/\/+$/, "");
}

async function fetchJson(fetchImpl, baseUrl, pathname, options = {}) {
  const headers = {
    accept: "application/json",
    ...(options.headers || {}),
  };
  const init = {
    method: options.method || "GET",
    headers,
  };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  const response = await fetchImpl(`${baseUrl}${pathname}`, init);
  if (!response.ok) {
    let details = null;
    try {
      details = await response.json();
    } catch {
      details = null;
    }
    throw new Error(details?.error?.message || `${pathname} returned ${response.status}`);
  }
  return response.json();
}

function adminHtml({ apiBaseUrl }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>LLMHQ Admin</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --surface: #ffffff;
      --surface-alt: #eef2f7;
      --text: #111827;
      --muted: #5b6472;
      --line: #d7dde7;
      --blue: #1d4ed8;
      --green: #15803d;
      --amber: #b45309;
      --red: #b91c1c;
      --shadow: 0 12px 30px rgba(17, 24, 39, 0.08);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 28px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
      position: sticky;
      top: 0;
      z-index: 1;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    main {
      width: min(1280px, 100%);
      margin: 0 auto;
      padding: 24px;
      display: grid;
      gap: 18px;
    }
    .status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 14px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 4px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--surface-alt);
      color: var(--muted);
      font-weight: 650;
      font-size: 13px;
      white-space: nowrap;
    }
    .pill.ok { color: var(--green); background: #ecfdf3; border-color: #b8e2c1; }
    .pill.warn { color: var(--amber); background: #fff7ed; border-color: #fed7aa; }
    .pill.bad { color: var(--red); background: #fef2f2; border-color: #fecaca; }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 18px;
    }
    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    section.wide { grid-column: 1 / -1; }
    .section-head {
      padding: 16px 18px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    h2 {
      margin: 0;
      font-size: 15px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    .metric {
      padding: 18px;
      display: grid;
      gap: 4px;
    }
    .metric strong {
      font-size: 28px;
      line-height: 1.15;
      letter-spacing: 0;
    }
    .metric span, .hint {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 720px;
    }
    th, td {
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 14px;
      line-height: 1.4;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      font-weight: 750;
      background: #fbfcfe;
    }
    tr:last-child td { border-bottom: 0; }
    code {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      background: #f1f5f9;
      border: 1px solid #dce4ee;
      border-radius: 6px;
      padding: 2px 6px;
      white-space: nowrap;
      font-size: 12px;
    }
    .tokens {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .token {
      display: inline-flex;
      align-items: center;
      padding: 3px 7px;
      border-radius: 6px;
      background: #eef2ff;
      color: #3730a3;
      font-size: 12px;
      font-weight: 650;
    }
    .empty {
      padding: 18px;
      color: var(--muted);
      font-size: 14px;
    }
    .error {
      border: 1px solid #fecaca;
      background: #fff1f2;
      color: var(--red);
      border-radius: 8px;
      padding: 14px 16px;
      display: none;
    }
    .mono-line {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 520px;
    }
    button {
      min-height: 34px;
      border: 1px solid #c8d1df;
      border-radius: 7px;
      background: var(--surface);
      color: var(--text);
      font-weight: 700;
      padding: 6px 12px;
      cursor: pointer;
    }
    button:hover { border-color: var(--blue); color: var(--blue); }
    button.primary {
      border-color: var(--blue);
      background: var(--blue);
      color: #ffffff;
    }
    button.primary:hover { color: #ffffff; filter: brightness(0.96); }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    .settings-editor {
      padding: 16px 18px 18px;
      display: grid;
      gap: 10px;
    }
    .tool-panel {
      padding: 16px 18px 18px;
      display: grid;
      gap: 10px;
    }
    .action-state {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .action-state.ok { color: var(--green); }
    .action-state.bad { color: var(--red); }
    .log-output {
      min-height: 150px;
      max-height: 320px;
      overflow: auto;
      margin: 0;
      padding: 12px;
      border: 1px solid #dce4ee;
      border-radius: 8px;
      background: #0f172a;
      color: #e5e7eb;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.5;
    }
    textarea {
      width: 100%;
      min-height: 420px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text);
      background: #fbfcfe;
    }
    textarea:focus {
      outline: 2px solid rgba(29, 78, 216, 0.18);
      border-color: var(--blue);
    }
    .save-state {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    .save-state.ok { color: var(--green); }
    .save-state.bad { color: var(--red); }
    @media (max-width: 900px) {
      header { align-items: flex-start; flex-direction: column; padding: 16px; }
      main { padding: 16px; }
      .grid { grid-template-columns: 1fr; }
      .metric strong { font-size: 24px; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>LLMHQ Admin</h1>
      <div class="status-row">
        <span id="gateway-status" class="pill warn">Loading</span>
        <span>API <code>${escapeHtml(apiBaseUrl)}</code></span>
      </div>
    </div>
    <button id="refresh" type="button">Refresh</button>
  </header>

  <main>
    <div id="error" class="error"></div>

    <div class="grid">
      <section>
        <div class="section-head"><h2>Gateway</h2></div>
        <div class="metric">
          <strong id="auth-mode">-</strong>
          <span>Auth mode</span>
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Workers</h2></div>
        <div class="metric">
          <strong id="worker-count">-</strong>
          <span>Configured provider workers</span>
        </div>
      </section>
      <section>
        <div class="section-head"><h2>Models</h2></div>
        <div class="metric">
          <strong id="model-count">-</strong>
          <span>Available model aliases</span>
        </div>
      </section>
    </div>

    <section class="wide">
      <div class="section-head">
        <h2>Model Fallback Chains</h2>
        <span id="fetched-at" class="hint"></span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Alias</th>
              <th>CLI model</th>
              <th>Capabilities</th>
              <th>Output</th>
              <th>Fallback</th>
            </tr>
          </thead>
          <tbody id="models-body"></tbody>
        </table>
      </div>
    </section>

    <section class="wide">
      <div class="section-head">
        <h2>Provider Login</h2>
        <div class="actions">
          <button id="start-codex-login" type="button">Start Codex Device Login</button>
          <button id="probe-providers-top" type="button">Probe Providers</button>
        </div>
      </div>
      <div class="tool-panel">
        <div id="provider-login-state" class="action-state">Codex login runs inside the LLMHQ container and prints a device-code URL here.</div>
        <pre id="provider-login-log" class="log-output">No provider login session started.</pre>
      </div>
    </section>

    <section class="wide">
      <div class="section-head">
        <h2>Runtime Settings</h2>
        <div class="actions">
          <button id="probe-providers" type="button">Probe Providers</button>
          <button id="reload-settings" type="button">Reload</button>
          <button id="save-settings" class="primary" type="button">Save Settings</button>
        </div>
      </div>
      <div class="settings-editor">
        <textarea id="settings-json" spellcheck="false" aria-label="LLMHQ runtime settings JSON"></textarea>
        <div id="settings-state" class="save-state">Settings are loaded from the gateway.</div>
      </div>
    </section>

    <section id="provider-probe-section" class="wide">
      <div class="section-head">
        <h2>Provider Probe</h2>
        <span id="probe-state" class="hint">One minimal request per provider</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Status</th>
              <th>Worker</th>
              <th>Elapsed</th>
              <th>Attempts</th>
            </tr>
          </thead>
          <tbody id="probe-body">
            <tr><td colspan="5" class="empty">Run provider probe to verify login usability.</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="wide">
      <div class="section-head"><h2>Provider Accounts</h2></div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Worker</th>
              <th>Status</th>
              <th>Command</th>
              <th>Capabilities</th>
              <th>Profile</th>
            </tr>
          </thead>
          <tbody id="workers-body"></tbody>
        </table>
      </div>
    </section>

    <section class="wide">
      <div class="section-head"><h2>Integration Endpoints</h2></div>
      <div class="table-wrap">
        <table>
          <tbody>
            <tr><th>Container apps</th><td><code>http://llmhq:8080</code></td></tr>
            <tr><th>Server-local apps</th><td><code>http://127.0.0.1:18088</code></td></tr>
            <tr><th>Unraid WebUI</th><td><code>http://[IP]:[PORT:18089]/admin</code></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </main>

  <script>
    const statusEl = document.getElementById("gateway-status");
    const errorEl = document.getElementById("error");
    const refreshEl = document.getElementById("refresh");
    const saveSettingsEl = document.getElementById("save-settings");
    const reloadSettingsEl = document.getElementById("reload-settings");
    const probeProvidersEl = document.getElementById("probe-providers");
    const probeProvidersTopEl = document.getElementById("probe-providers-top");
    const startCodexLoginEl = document.getElementById("start-codex-login");
    const settingsEditorEl = document.getElementById("settings-json");
    const settingsStateEl = document.getElementById("settings-state");
    const probeStateEl = document.getElementById("probe-state");
    const providerLoginStateEl = document.getElementById("provider-login-state");
    const providerLoginLogEl = document.getElementById("provider-login-log");
    let settingsDirty = false;
    let providerLoginPollTimer = null;
    let providerLoginSessionId = null;

    refreshEl.addEventListener("click", loadSummary);
    saveSettingsEl.addEventListener("click", saveSettings);
    reloadSettingsEl.addEventListener("click", reloadSettings);
    probeProvidersEl.addEventListener("click", probeProviders);
    probeProvidersTopEl.addEventListener("click", probeProviders);
    startCodexLoginEl.addEventListener("click", startCodexLogin);
    settingsEditorEl.addEventListener("input", () => {
      settingsDirty = true;
      setSettingsState("Unsaved settings edits.", "");
    });
    loadSummary();

    async function loadSummary() {
      setStatus("Loading", "warn");
      errorEl.style.display = "none";
      try {
        const response = await fetch("/admin/api/summary", { cache: "no-store" });
        const summary = await response.json();
        if (!response.ok) {
          throw new Error(summary?.error?.message || "Admin summary failed");
        }
        renderSummary(summary);
        renderSettings(summary.settings);
        setStatus("Online", "ok");
      } catch (error) {
        setStatus("Offline", "bad");
        errorEl.textContent = error.message || String(error);
        errorEl.style.display = "block";
      }
    }

    function renderSummary(summary) {
      const providers = Array.isArray(summary.health?.providers) ? summary.health.providers : [];
      const models = Array.isArray(summary.models) ? summary.models : [];
      document.getElementById("auth-mode").textContent = summary.health?.auth_mode || "-";
      document.getElementById("worker-count").textContent = providers.length;
      document.getElementById("model-count").textContent = models.length;
      document.getElementById("fetched-at").textContent = summary.fetched_at ? new Date(summary.fetched_at).toLocaleString() : "";
      saveSettingsEl.disabled = summary.editable === false;
      renderModels(models);
      renderWorkers(providers);
    }

    function renderSettings(settings) {
      if (!settings || settingsDirty) {
        return;
      }
      settingsEditorEl.value = JSON.stringify(settings, null, 2);
      setSettingsState("Settings are loaded from the gateway.", "");
    }

    async function saveSettings() {
      let parsed;
      try {
        parsed = JSON.parse(settingsEditorEl.value || "{}");
      } catch (error) {
        setSettingsState("Invalid JSON: " + error.message, "bad");
        return;
      }

      setSettingsState("Saving settings...", "");
      saveSettingsEl.disabled = true;
      try {
        const response = await fetch("/admin/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ settings: parsed }),
        });
        const summary = await response.json();
        if (!response.ok) {
          throw new Error(summary?.error?.message || "Settings save failed");
        }
        settingsDirty = false;
        renderSummary(summary);
        renderSettings(summary.settings);
        setSettingsState("Saved. LLMHQ runtime was updated.", "ok");
        setStatus("Online", "ok");
      } catch (error) {
        setSettingsState(error.message || String(error), "bad");
      } finally {
        saveSettingsEl.disabled = false;
      }
    }

    async function reloadSettings() {
      settingsDirty = false;
      setSettingsState("Reloading settings...", "");
      try {
        const response = await fetch("/admin/api/settings/reload", { method: "POST" });
        const summary = await response.json();
        if (!response.ok) {
          throw new Error(summary?.error?.message || "Settings reload failed");
        }
        renderSummary(summary);
        renderSettings(summary.settings);
        setStatus("Online", "ok");
      } catch (error) {
        setSettingsState(error.message || String(error), "bad");
      }
    }

    async function probeProviders() {
      setSettingsState("Probing providers...", "");
      setProbeState("Probing providers...", "");
      probeProvidersEl.disabled = true;
      probeProvidersTopEl.disabled = true;
      try {
        const response = await fetch("/admin/api/provider-probe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result?.error?.message || "Provider probe failed");
        }
        renderWorkers(Array.isArray(result.health?.providers) ? result.health.providers : []);
        renderProbe(result.results || []);
        document.getElementById("provider-probe-section").scrollIntoView({ behavior: "smooth", block: "start" });
        setSettingsState(
          result.status === "ok" ? "Provider probe passed." : "Provider probe found unavailable provider sessions.",
          result.status === "ok" ? "ok" : "bad",
        );
        setProbeState(
          result.status === "ok" ? "Provider probe passed." : "Provider probe found unavailable provider sessions.",
          result.status === "ok" ? "ok" : "bad",
        );
      } catch (error) {
        setSettingsState(error.message || String(error), "bad");
        setProbeState(error.message || String(error), "bad");
      } finally {
        probeProvidersEl.disabled = false;
        probeProvidersTopEl.disabled = false;
      }
    }

    async function startCodexLogin() {
      startCodexLoginEl.disabled = true;
      setProviderLoginState("Starting Codex device login...", "");
      providerLoginLogEl.textContent = "Starting Codex device login...";
      try {
        const response = await fetch("/admin/api/provider-login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider: "codex", worker: "codex-1", mode: "device" }),
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result?.error?.message || "Provider login failed to start");
        }
        providerLoginSessionId = result.session?.id;
        renderProviderLogin(result.session);
        pollProviderLogin();
      } catch (error) {
        setProviderLoginState(error.message || String(error), "bad");
      } finally {
        startCodexLoginEl.disabled = false;
      }
    }

    async function pollProviderLogin() {
      if (!providerLoginSessionId) {
        return;
      }
      clearTimeout(providerLoginPollTimer);
      try {
        const response = await fetch("/admin/api/provider-login/" + encodeURIComponent(providerLoginSessionId), { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result?.error?.message || "Provider login status failed");
        }
        renderProviderLogin(result.session);
        if (result.session?.status === "running") {
          providerLoginPollTimer = setTimeout(pollProviderLogin, 1500);
        }
      } catch (error) {
        setProviderLoginState(error.message || String(error), "bad");
      }
    }

    function renderProviderLogin(session) {
      if (!session) {
        return;
      }
      providerLoginLogEl.textContent = session.output || "Waiting for Codex login output...";
      providerLoginLogEl.scrollTop = providerLoginLogEl.scrollHeight;
      if (session.status === "running") {
        setProviderLoginState("Codex device login is running. Open the printed URL, enter the code, and finish Google login.", "");
      } else if (session.status === "completed") {
        setProviderLoginState("Codex login completed. Run Provider Probe to verify codex-gpt-5.5.", "ok");
      } else {
        setProviderLoginState("Codex login did not complete: " + session.status + ".", "bad");
      }
    }

    function renderModels(models) {
      const body = document.getElementById("models-body");
      body.innerHTML = "";
      if (!models.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">No model aliases returned.</td></tr>';
        return;
      }
      for (const model of models) {
        const fallback = Array.isArray(model.fallback) && model.fallback.length ? model.fallback : ["none"];
        body.append(row([
          code(model.id),
          model.cli_model ? code(model.cli_model) : '<span class="hint">not set</span>',
          tokens(model.capabilities),
          tokens(model.output),
          fallback.map((item) => item === "none" ? '<span class="hint">none</span>' : code(item)).join(" ")
        ]));
      }
    }

    function renderWorkers(workers) {
      const body = document.getElementById("workers-body");
      body.innerHTML = "";
      if (!workers.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">No provider workers returned.</td></tr>';
        return;
      }
      for (const worker of workers) {
        body.append(row([
          code(worker.id),
          statusBadge(worker.status),
          worker.command ? code(worker.command) : '<span class="hint">browser</span>',
          tokens(worker.capabilities),
          worker.profileDir ? '<div class="mono-line">' + code(worker.profileDir) + '</div>' : '<span class="hint">not set</span>'
        ]));
      }
    }

    function renderProbe(results) {
      const body = document.getElementById("probe-body");
      body.innerHTML = "";
      if (!Array.isArray(results) || !results.length) {
        body.innerHTML = '<tr><td colspan="5" class="empty">No probe results returned.</td></tr>';
        return;
      }
      for (const result of results) {
        const attempts = Array.isArray(result.attempts) ? result.attempts : [];
        body.append(row([
          code(result.model),
          result.ok ? '<span class="pill ok">ok</span>' : '<span class="pill bad">' + escapeHtml(result.code || "failed") + '</span>',
          result.used_worker ? code(result.used_worker) : '<span class="hint">none</span>',
          typeof result.elapsed_ms === "number" ? escapeHtml(String(result.elapsed_ms)) + " ms" : '<span class="hint">unknown</span>',
          attempts.length ? code(JSON.stringify(attempts)) : '<span class="hint">none</span>'
        ]));
      }
    }

    function row(cells) {
      const tr = document.createElement("tr");
      tr.innerHTML = cells.map((cell) => "<td>" + cell + "</td>").join("");
      return tr;
    }

    function tokens(values) {
      if (!Array.isArray(values) || !values.length) return '<span class="hint">none</span>';
      return '<div class="tokens">' + values.map((value) => '<span class="token">' + escapeHtml(String(value)) + '</span>').join("") + '</div>';
    }

    function code(value) {
      return "<code>" + escapeHtml(String(value)) + "</code>";
    }

    function statusBadge(value) {
      const normalized = String(value || "unknown");
      const kind = normalized === "configured" || normalized === "ready" ? "ok" : normalized === "unhealthy" || normalized === "unavailable" ? "bad" : "warn";
      return '<span class="pill ' + kind + '">' + escapeHtml(normalized) + '</span>';
    }

    function setStatus(text, kind) {
      statusEl.textContent = text;
      statusEl.className = "pill " + kind;
    }

    function setSettingsState(text, kind) {
      settingsStateEl.textContent = text;
      settingsStateEl.className = "save-state" + (kind ? " " + kind : "");
    }

    function setProbeState(text, kind) {
      probeStateEl.textContent = text;
      probeStateEl.className = "action-state" + (kind ? " " + kind : "");
    }

    function setProviderLoginState(text, kind) {
      providerLoginStateEl.textContent = text;
      providerLoginStateEl.className = "action-state" + (kind ? " " + kind : "");
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char],
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = process.env.LLMHQ_ADMIN_HOST || "0.0.0.0";
  const port = Number.parseInt(process.env.LLMHQ_ADMIN_PORT || "8090", 10);
  const app = await buildAdminApp({ fastify: Fastify({ logger: true }) });
  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
