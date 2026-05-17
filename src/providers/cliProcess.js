import { spawn } from "node:child_process";
import { ProviderError } from "../errors.js";

export function runCli({ command, args = [], input = "", env = {}, cwd = process.cwd(), timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const shell = shouldUseShell(command);
    const child = spawn(shell ? buildShellCommand(command, args) : command, shell ? [] : args, {
      cwd,
      env: { ...process.env, ...env },
      shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError("worker_spawn_failed", error.message));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new ProviderError("worker_timeout", `CLI worker timed out after ${timeoutMs}ms.`, { stderr }));
        return;
      }
      if (code !== 0) {
        reject(classifyCliFailure(stderr || stdout, code));
        return;
      }
      resolve({ stdout, stderr, code });
    });

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

function shouldUseShell(command) {
  if (process.platform !== "win32") {
    return false;
  }
  return !command.toLowerCase().endsWith(".exe");
}

function buildShellCommand(command, args) {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function quoteShellArg(value) {
  const text = String(value);
  if (text === "") {
    return '""';
  }
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(["^&|<>])/g, "^$1")}"`;
}

export function classifyCliFailure(output, exitCode = 1) {
  const text = output || "";
  const sanitizedOutput = sanitizeDiagnostic(text);
  const lower = text.toLowerCase();

  if (lower.includes("login") || lower.includes("auth") || lower.includes("oauth") || lower.includes("unauthorized")) {
    return new ProviderError("auth_required", "Provider CLI is not authenticated.", {
      exitCode,
      output: sanitizedOutput,
    });
  }

  if (lower.includes("rate limit") || lower.includes("too many requests") || lower.includes("usage limit")) {
    return new ProviderError("rate_limited", "Provider CLI is rate limited.", {
      exitCode,
      output: sanitizedOutput,
    });
  }

  return new ProviderError("provider_error", "Provider CLI failed.", {
    exitCode,
    output: sanitizedOutput,
  });
}

function sanitizeDiagnostic(value) {
  return String(value || "")
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "sk-[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[jwt-redacted]")
    .slice(0, 2000);
}
