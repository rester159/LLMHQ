# Workspaces API Contract

Status: implemented for answer-mode registration, scoped tokens, and
`app_context_provider` retrieval. Agentic workspace execution is still planned.

This document defines how any application should give LLMHQ scoped, durable
context. A workspace is the generic unit of app-provided context. It may be a
repo clone, a chat/action log, a campaign database, a document collection, or a
mixed set of sources.

The key rule is explicitness:

```text
No workspace reference in the request means no workspace context is used.
```

LLMHQ must never guess that a conversation belongs to a repo, campaign, user, or
application context unless the caller provides a valid workspace reference.

## Why This Exists

LLMHQ is a shared gateway used by multiple unrelated applications. It cannot
globally load context from one app and risk exposing it to another. Every app
needs a standard way to say:

- which workspace this request belongs to
- what kind of workspace it is
- where LLMHQ can retrieve context from
- what permissions are allowed
- whether the call is answer-only or agentic execution

Riff needs this for repo-aware coding behavior. In the preferred Riff shape,
Riff owns the canonical clone and exposes a workspace provider API; LLMHQ does
not keep a second clone. WorldState may need this for long campaign/chat/action
logs. Other apps may use it for documents, workflows, or product-specific
databases.

## Vocabulary

- `app_id`: stable integration id, such as `riff` or `worldstate`.
- `tenant_id`: deployment/customer/organization boundary.
- `owner_subject`: app user/account id when applicable.
- `workspace_id`: app-defined durable id for the context universe.
- `workspace_token`: opaque LLMHQ-issued capability for one workspace.
- `workspace_type`: generic class, such as `repo`, `log`, `database`, or
  `document_corpus`.
- `source`: a backing context source, such as a filesystem root or app callback.
- `mode`: how the model may use the workspace for this request.

## Workspace Lifecycle

```text
1. App registers or updates a workspace.
2. LLMHQ validates source descriptors and stores policy.
3. LLMHQ returns a workspace_token.
4. App stores that token in its own database.
5. App includes the token in LLMHQ calls.
6. LLMHQ retrieves or executes only inside that workspace's policy.
7. App refreshes the workspace when source content changes.
8. App or admin revokes the token when access should stop.
```

## Workspace Identity

Workspace identity is the tuple:

```text
app_id + tenant_id + owner_subject + workspace_id
```

The same `workspace_id` string may exist in many apps or tenants. It is only
unique inside the full tuple.

Examples:

```text
Riff repo branch:
  app_id: riff
  tenant_id: unraid-main
  owner_subject: user:1
  workspace_id: repo:17:branch:main
  workspace_type: repo

WorldState campaign:
  app_id: worldstate
  tenant_id: unraid-main
  owner_subject: user:1
  workspace_id: campaign:cmp_123
  workspace_type: database
```

## Workspace Types

### Repo

Use for Git repositories or source trees.

Preferred source when another app owns the clone:

```json
{
  "type": "app_context_provider",
  "kind": "repo",
  "provider_id": "riff-repo-workspace-provider-v1",
  "base_url": "http://riff:3000",
  "workspace_id": "repo:17:branch:main",
  "branch": "main",
  "commit": "abc123"
}
```

Optional source when LLMHQ is deliberately mounted into the same canonical
workspace:

```json
{
  "type": "filesystem",
  "kind": "git_repo",
  "root": "/workspaces/1/17",
  "branch": "main",
  "commit": "abc123"
}
```

Expected capabilities:

- file tree
- safe text search
- read file chunks
- optional shell execution
- optional writes
- changed-file reporting

For code-changing work, avoid two independent clones. Either the owning app
exposes write/tool operations through a provider API, or both systems are using
the exact same canonical workspace mount.

### Log

Use for chat logs, audit logs, or action/event streams.

Typical sources:

```json
{
  "type": "app_context_provider",
  "kind": "log",
  "provider_id": "worldstate-campaign-log-v1",
  "streams": ["chat_messages", "actions", "quest_events"]
}
```

Expected capabilities:

- recent records
- topic search
- time-window search
- action/entity lookup
- rolling summaries

### Database

Use when app-specific schema knowledge should stay in the app.

Typical sources:

```json
{
  "type": "app_context_provider",
  "kind": "database",
  "provider_id": "worldstate-campaign-context-v1",
  "base_url": "http://worldstate:8000/internal/llmhq"
}
```

LLMHQ calls the provider instead of directly reading the app database.

## App Context Provider Auth

Provider callbacks use server-to-server bearer tokens. Configure LLMHQ with a
comma-separated provider token map:

```env
LLMHQ_WORKSPACE_PROVIDER_TOKENS=riff-repo-workspace-provider-v1=shared-secret
```

When a registered source has `type: "app_context_provider"`, LLMHQ calls:

```http
POST {base_url}/internal/llmhq/workspaces/{workspace_id}/retrieve
Authorization: Bearer <token for provider_id>
Content-Type: application/json
```

Request body:

```json
{
  "query": "user prompt text",
  "limits": {
    "max_chunks": 8,
    "max_chars": 18000
  }
}
```

Response body:

```json
{
  "workspace_id": "repo:17:branch:main",
  "chunks": [
    {
      "id": "file:planning/PRD.md",
      "kind": "file",
      "title": "planning/PRD.md",
      "content": "bounded excerpt",
      "metadata": {
        "path": "planning/PRD.md"
      }
    }
  ],
  "next_cursor": null
}
```

LLMHQ injects returned chunks as a system context message before the user's
turn. The raw workspace envelope is used only by LLMHQ routing/retrieval and is
not passed to the model as user text.

LLMHQ may also call workspace tools through the same provider when the model
needs to inspect or modify the workspace during its reasoning loop:

```http
POST {base_url}/internal/llmhq/workspaces/{workspace_id}/tools
Authorization: Bearer <token for provider_id>
Content-Type: application/json
```

Request body:

```json
{
  "tool": "search",
  "input": {
    "query": "posting limits",
    "path": "planning",
    "max_results": 40
  }
}
```

Initial Riff tools:

- `list`: list scoped workspace directory entries.
- `search`: search text files inside the scoped workspace.
- `read`: read a bounded line range from one text file.
- `diff`: return the current workspace diff.
- `apply_patch`: apply a unified diff inside the workspace.

Riff remains the workspace authority. It validates paths, blocks denied
directories and secret-like files, applies patches inside its canonical clone,
and still owns commit/push.

### Document Corpus

Use for uploaded documents, synced folders, or product knowledge bases.

Typical sources:

```json
{
  "type": "object_store",
  "kind": "document_corpus",
  "prefix": "docs/customer-123/project-456"
}
```

## Permissions

Every workspace token must carry explicit permissions.

```json
{
  "read": true,
  "search": true,
  "write": false,
  "shell": false,
  "network": false,
  "git": {
    "status": true,
    "diff": true,
    "commit": false,
    "push": false
  }
}
```

Permissions are enforced by LLMHQ on every retrieval, tool, and execution call.

## Register Workspace

Planned endpoint:

```http
POST /v1/workspaces
Authorization: Bearer <app_api_key>
Content-Type: application/json
```

Request:

```json
{
  "app_id": "riff",
  "tenant_id": "unraid-main",
  "owner_subject": "user:1",
  "workspace_id": "repo:17:branch:main",
  "workspace_type": "repo",
  "display_name": "rester159/riff main",
  "sources": [
    {
      "type": "app_context_provider",
      "kind": "repo",
      "provider_id": "riff-repo-workspace-provider-v1",
      "base_url": "http://riff:3000",
      "workspace_id": "repo:17:branch:main",
      "branch": "main",
      "commit": "abc123"
    }
  ],
  "permissions": {
    "read": true,
    "search": true,
    "write": false,
    "shell": false
  },
  "metadata": {
    "repo_full_name": "rester159/riff"
  }
}
```

Response:

```json
{
  "workspace_token": "ws_live_...",
  "workspace_id": "repo:17:branch:main",
  "workspace_type": "repo",
  "status": "registered",
  "index_status": "queued",
  "created_at": "2026-05-18T17:00:00.000Z",
  "updated_at": "2026-05-18T17:00:00.000Z"
}
```

Rules:

- Registration is idempotent for
  `app_id + tenant_id + owner_subject + workspace_id`.
- LLMHQ returns the existing workspace unless the caller requests token
  rotation.
- LLMHQ validates each source descriptor before marking the workspace ready.
- Filesystem roots are canonicalized and checked against allowed root prefixes.
- Tokens are stored hashed at rest.

## Refresh Workspace

Planned endpoint:

```http
POST /v1/workspaces/{workspace_token}/refresh
Authorization: Bearer <app_api_key>
Content-Type: application/json
```

Request:

```json
{
  "reason": "git_pull",
  "source_version": {
    "branch": "main",
    "commit": "def456"
  },
  "changed_paths": ["planning/PRD_v0.2.md"],
  "priority": "interactive"
}
```

Response:

```json
{
  "workspace_token": "ws_live_...",
  "status": "registered",
  "index_status": "queued",
  "updated_at": "2026-05-18T17:05:00.000Z"
}
```

## Workspace-Aware Conversation Call

Planned extension to:

```http
POST /v1/conversations/messages
```

Request:

```json
{
  "project_id": "riff:rester159/riff",
  "conversation_key": "chat:1",
  "default_model": "claude-sonnet",
  "workspace": {
    "token": "ws_live_...",
    "mode": "answer",
    "retrieval": {
      "strategy": "auto",
      "max_chunks": 12,
      "max_chars": 24000,
      "include_recent_conversation": true,
      "include_source_citations": true
    }
  },
  "message": {
    "role": "user",
    "content": "What did the PRD say about platform posting limits?"
  }
}
```

Response additions:

```json
{
  "conversation": {
    "id": "conv_...",
    "project_id": "riff:rester159/riff",
    "conversation_key": "chat:1"
  },
  "workspace": {
    "workspace_id": "repo:17:branch:main",
    "mode": "answer",
    "index_status": "ready",
    "retrieved_chunks": [
      {
        "source_id": "file:planning/PRD_v0.2.md",
        "kind": "file",
        "range": "120-170",
        "reason": "matched platform posting limits"
      }
    ]
  },
  "chat_completion": {
    "choices": [
      {
        "message": {
          "role": "assistant",
          "content": "..."
        }
      }
    ]
  }
}
```

## Modes

### `answer`

The model may use retrieval context but cannot write files or run shell
commands.

Use for:

- explanations
- repo/document Q&A
- summaries
- recall from long logs
- source-grounded answers

### `agent`

The model may use workspace tools allowed by permissions.

Use for:

- code edits
- debugging
- running tests
- multi-step investigation
- file updates

Agent mode requires explicit workspace permissions. A request for `agent` mode
with a token that does not allow shell/write must fail clearly.

## App Context Provider Contract

For database/log workspaces, LLMHQ may call an app-owned retrieval provider.

Planned request:

```http
POST <provider_base_url>/retrieve
Authorization: Bearer <provider_secret>
Content-Type: application/json
```

Body:

```json
{
  "workspace_id": "campaign:cmp_123",
  "query": "What promises did the guard captain make?",
  "intent": "answer",
  "limits": {
    "max_chunks": 12,
    "max_chars": 20000
  },
  "cursor": null
}
```

Response:

```json
{
  "chunks": [
    {
      "id": "chat:msg_123",
      "kind": "chat_message",
      "title": "Turn 87",
      "content": "The guard captain promised...",
      "created_at": "2026-05-18T17:00:00.000Z",
      "metadata": {
        "campaign_id": "cmp_123",
        "action_id": "act_456"
      }
    }
  ],
  "next_cursor": null
}
```

This keeps app-specific schema logic in the app while letting LLMHQ use one
generic workspace protocol.

## Required Documentation for App Integrations

Every app integrating workspaces must document:

- `app_id`
- `tenant_id` strategy
- workspace id format
- workspace type
- source descriptors
- permissions requested
- when registration happens
- when refresh happens
- which LLMHQ call modes it uses
- failure behavior when workspace access is unavailable
- security boundaries and denied sources

Minimum integration checklist:

```text
1. Register workspace.
2. Store workspace_token.
3. Refresh workspace after source changes.
4. Include workspace token in LLMHQ calls.
5. Choose answer or agent mode explicitly.
6. Handle workspace errors without pretending context was available.
7. Test isolation across apps/users/workspaces.
```

## Error Codes

Planned workspace errors:

```json
{
  "error": {
    "code": "workspace_required",
    "message": "This request requires a workspace token."
  }
}
```

```json
{
  "error": {
    "code": "workspace_not_found",
    "message": "Workspace token is invalid or revoked."
  }
}
```

```json
{
  "error": {
    "code": "workspace_permission_denied",
    "message": "Workspace does not allow shell execution."
  }
}
```

```json
{
  "error": {
    "code": "workspace_source_unavailable",
    "message": "Workspace source could not be reached."
  }
}
```

## Security Rules

- Workspace token lookup must include token validation and revocation status.
- Filesystem roots must be canonicalized before access.
- Filesystem operations must stay under the registered root.
- `.git`, secrets, credentials, binary files, large generated outputs, and
  app-denied paths are excluded from retrieval by default.
- Shell execution must be disabled unless explicitly permitted.
- Write access must be disabled unless explicitly permitted.
- Network access must be disabled unless explicitly permitted.
- Every retrieval and execution event is audit logged.
- Workspace context must never be shared across apps or tenants.

## Implementation Milestones

1. Workspace registry and token model.
2. Filesystem repo source validation.
3. Repo tree/text retrieval.
4. Workspace field on `/v1/conversations/messages`.
5. Retrieval metadata in responses.
6. App context provider retrieval.
7. Agent mode execution and streaming events.
8. Rolling summaries and persistent indexes.
