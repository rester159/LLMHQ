# LLMHQ Refactoring Prompt

Use this prompt when refactoring an existing app that currently calls ChatGPT, OpenAI, Claude, Anthropic, Codex, or another LLM provider directly for regular chat, coding, analysis, summarization, classification, planning, or text generation.

This prompt is intentionally for regular LLM activity, not image generation.

```text
You are refactoring this app to use my local LLMHQ gateway instead of calling provider APIs or local provider CLIs directly.

Goal:
- Replace direct ChatGPT/OpenAI/Claude/Anthropic/Codex calls with LLMHQ HTTP calls.
- Keep the app behavior the same from the user's perspective.
- Keep model choice configurable.
- Use LLMHQ's default fallback behavior unless a specific call explicitly disables fallback.
- Do not introduce provider credentials into this app. The provider login state lives in LLMHQ.

LLMHQ connection:
- Add env var LLMHQ_BASE_URL.
- Default for host-local apps running directly on the LLMHQ server: http://127.0.0.1:18088
- Default for Docker containers on the same server: http://llmhq:8080
- If LLMHQ_API_KEY is present, send Authorization: Bearer ${LLMHQ_API_KEY}.
- If LLMHQ_API_KEY is absent, call without Authorization because same-server LLMHQ may run with LLMHQ_AUTH_MODE=none.
- Do not use 127.0.0.1 from inside a product app container; that points to the product app container itself, not LLMHQ.

Default model behavior:
- Add env var LLMHQ_DEFAULT_MODEL.
- Default it to claude-sonnet.
- Every LLM call should use:
  - the request-specific model if provided by the app/user,
  - otherwise LLMHQ_DEFAULT_MODEL,
  - otherwise claude-sonnet.
- Supported regular LLM model aliases are:
  - claude-haiku
  - claude-sonnet
  - claude-opus
  - codex-gpt-5.5

Fallback behavior:
- Send fallback: "default" on normal calls.
- If the app has a strict requirement to fail instead of falling back, send fallback: "none".
- Preserve and surface these response fields in logs or metadata where practical:
  - requested_model
  - used_model
  - used_worker
  - fallback_used
  - fallback_reason
  - attempts
- If fallback_used is true, do not treat it as a failed request. It is a successful request with degraded or alternate provider execution.

Stateless calls:
- If the app already stores full chat history, call:
  POST ${LLMHQ_BASE_URL}/v1/chat/completions
- Body shape:
  {
    "model": selectedModel,
    "fallback": "default",
    "messages": [
      { "role": "system", "content": "..." },
      { "role": "user", "content": "..." }
    ],
    "temperature": optionalTemperature,
    "max_tokens": optionalMaxTokens,
    "stream": false
  }
- Read the assistant text from response.choices[0].message.content.

Stateful calls:
- If the app does not reliably store chat context, use LLMHQ's conversation layer:
  POST ${LLMHQ_BASE_URL}/v1/conversations/messages
- Add env var LLMHQ_PROJECT_ID. Default it to a stable lowercase app name.
- Choose a stable conversation_key per workflow, feature, user thread, or automation.
- Body shape:
  {
    "project_id": process.env.LLMHQ_PROJECT_ID || "<app-name>",
    "conversation_key": "<stable-workflow-or-thread-key>",
    "title": "<human readable title>",
    "default_model": selectedModel,
    "model": selectedModel,
    "fallback": "default",
    "message": {
      "role": "user",
      "content": userPrompt
    },
    "metadata": {
      "source": "<app-name>",
      "feature": "<feature-name>"
    }
  }
- Read the assistant text from response.chat_completion.choices[0].message.content.
- Store response.conversation.id only if the app already has a natural place for it. Otherwise, keep using project_id + conversation_key.

Implementation requirements:
- Create a small LLMHQ client module instead of scattering fetch calls throughout the app.
- Keep the client API close to the app's current LLM helper interface so call sites change minimally.
- Centralize timeout, base URL, API key header, selected model, fallback, and error handling in that client.
- Normalize provider errors into the app's existing error shape.
- Preserve streaming behavior only if the app already depends on streaming. If not, use non-streaming calls.
- Remove unused direct provider SDK imports, CLI spawning, API key env vars, and provider-specific wrapper code after migration.
- Update documentation and example env files.
- Add tests for:
  - base URL and Authorization header behavior,
  - stateless chat request shape,
  - stateful conversation request shape if used,
  - fallback metadata handling,
  - provider error handling.

Do not:
- Do not call OpenAI, Anthropic, Claude CLI, Codex CLI, or ChatGPT directly from this app after the refactor.
- Do not store provider OAuth/session tokens in this app.
- Do not hardcode 127.0.0.1 if the app can run in Docker; keep LLMHQ_BASE_URL configurable.
- Do not hide fallback. Log or surface it enough that I can tell when the requested model failed.

After refactoring:
- Run the app's existing tests.
- Add or update a small smoke test that points at LLMHQ_BASE_URL.
- Show me exactly which files changed and which old provider paths were removed.
```

## Minimal Client Contract

The app-side client should expose one or both of these methods:

```ts
type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatOptions = {
  model?: "claude-haiku" | "claude-sonnet" | "claude-opus" | "codex-gpt-5.5";
  fallback?: "default" | "none" | false | string | string[];
  temperature?: number;
  maxTokens?: number;
};

async function completeChat(messages: LlmMessage[], options?: ChatOptions): Promise<{
  content: string;
  requestedModel: string;
  usedModel: string;
  fallbackUsed: boolean;
  attempts: unknown[];
}>;

async function sendConversationMessage(input: {
  projectId: string;
  conversationKey: string;
  content: string;
  title?: string;
  model?: ChatOptions["model"];
  fallback?: ChatOptions["fallback"];
  metadata?: Record<string, unknown>;
}): Promise<{
  content: string;
  conversationId: string;
  usedModel: string;
  fallbackUsed: boolean;
  attempts: unknown[];
}>;
```
