# External Control Adapter

## Overview

The External Control Adapter layer is a pluggable contract that allows
GPTWork to integrate with external control surfaces (such as GitHub Issues)
without making any one external system a hard requirement.

**Core principle:** GPTWork state store is always the source of truth.
External systems never replace core state.  Adapters only mirror, import,
and read — they do not own state.

## Architecture

```
  ┌─────────────────────────────────────────────┐
  │           createAdapterRegistry()           │
  │  (single registry per server instance)      │
  ├─────────────────────────────────────────────┤
  │  │        │        │        │              │
  │  │ "github │"linear"│"gitlab"│ "dashboard" │
  │  │ -issues│ (future)│(future)│  (future)   │
  │  ▼        ▼        ▼        ▼              │
  │  GitHub   Linear   GitLab   Custom Web     │
  │  Adapter  Adapter  Adapter  Adapter        │
  └─────────────────────────────────────────────┘
                     │
                     ▼
          GPTWork Core State Store
          (source of truth)
```

## Contract

Every adapter must implement the `ExternalControlAdapter` contract:

| Property/Method    | Type       | Description                                         |
|--------------------|------------|-----------------------------------------------------|
| `name`             | `string`   | Human-readable adapter name (e.g. "github-issues")  |
| `enabled`          | `boolean`  | Whether the adapter is configured and can operate   |
| `mirrorState(state)` | `async fn` | Push local state outward to the external system    |
| `importState(store, opts?)` | `async fn` | Pull tasks/issues inward from the external system |
| `readCommands(store, opts?)` | `async fn` | Read control commands (comments, labels) from external system |
| `status()`         | `fn`       | Return adapter status and configuration info        |
| `getDiagnostics()` | `fn`       | (Optional) Return detailed diagnostics               |

### mirrorState

```js
mirrorState(state) → Promise<{
  ok: boolean,
  count: number,
  details: object
}>
```

Pushes local state (tasks, ChatGPT requests, status changes) to the external
system.  For GitHub Issues, this creates/updates issues and posts result
comments.

### importState

```js
importState(store, opts?) → Promise<{
  imported: Array<object>,
  skipped: Array<object>,
  diagnostics: object
}>
```

Imports new tasks from the external system.  For GitHub Issues, this scans
open issues with gptwork-task labels and creates corresponding tasks in the
state store.

### readCommands

```js
readCommands(store, opts?) → Promise<{
  commands: Array<{ type: string, ... }>,
  imported: Array<object>,
  details: object
}>
```

Reads control commands (comments, reactions, label changes) from the external
system.  For GitHub Issues, this imports ChatGPT responses from issue comments
and marks the corresponding requests as answered.

## Files

| File                                        | Description                                      |
|---------------------------------------------|--------------------------------------------------|
| `backend/src/external-control-adapter.mjs`  | Contract definitions and adapter registry        |
| `backend/src/webhook-service.mjs`           | Webhook registration and reserved events         |
| `backend/src/github-adapter.mjs`            | GitHub Issues adapter (`createGithubControlAdapter`) |
| `backend/test/external-control-adapter.test.mjs` | Tests for contract, registry, and adapters |

## Usage

### 1. Create and configure a registry

```js
import { createAdapterRegistry } from "./external-control-adapter.mjs";
import { createGithubControlAdapter } from "./github-adapter.mjs";

const registry = createAdapterRegistry();

// Register GitHub Issues adapter (optional — disabled when not configured)
const github = createGithubControlAdapter({
  githubRepo: process.env.GPTWORK_GITHUB_REPO,
  githubToken: process.env.GPTWORK_GITHUB_TOKEN,
  githubEnabled: process.env.GPTWORK_GITHUB_ENABLED,  // "true" | "false" | undefined
});
registry.register("github-issues", github);
```

### 2. Mirror state outward

```js
const state = await store.load();
const results = await registry.mirrorAllState(state);
```

### 3. Import state inward

```js
const result = await registry.importAllState(store, { limit: 50 });
```

### 4. Read commands

```js
const result = await registry.readAllCommands(store);
```

### 5. Check status

```js
const status = registry.statusAll();
// {
//   adapter_count: 1,
//   enabled_count: 1,
//   adapters: {
//     "github-issues": { enabled: true, ..., api_sync_enabled: true }
//   }
// }
```

## Graceful Degradation

- **No adapters enabled**: all bulk operations return empty results.
  The system runs identically with or without external integrations.
- **Adapter errors**: a failing adapter never blocks other adapters or
  the core workflow.  Errors are captured in per-adapter result fields.
- **Disabled adapter**: registered but disabled adapters are silently
  skipped by all bulk operations.

## Adding a New Adapter

1. Create a new module (e.g. `backend/src/linear-adapter.mjs`).
2. Export a factory function that returns an object conforming to the
   `ExternalControlAdapter` contract.
3. Call `validateAdapter(yourAdapter)` in tests to confirm contract compliance.
4. Register it: `registry.register("linear", yourAdapter)`.

## Webhook Reservation

The `webhook-service.mjs` module defines the webhook contract and reserved
event names:

| Event Constant          | Event Name               | Description                     |
|-------------------------|--------------------------|---------------------------------|
| GITHUB_ISSUES           | `github:issues`          | GitHub issue opened/closed      |
| GITHUB_ISSUE_COMMENT    | `github:issue_comment`   | GitHub comment created          |
| GITHUB_PING             | `github:ping`            | GitHub webhook verification     |
| TASK_UPDATED            | `task:updated`           | Internal task update event      |
| GOAL_UPDATED            | `goal:updated`           | Internal goal update event      |
| HEALTH_CHECK            | `system:health_check`    | System health probe             |

Actual webhook HTTP endpoints and signature verification are **not yet
implemented** — this is a contract reservation for future milestones.

## Design Decisions

1. **Registry over static import.**  Adapters are registered at runtime so
   the set of active integrations is configurable per deployment.

2. **Per-adapter isolation.**  Every adapter call is wrapped in try-catch.
   A crashing adapter never takes down the registry or other adapters.

3. **Disabled adapters are transparent.**  They are visible in
   `getAllAdapters()` and `statusAll()` but skipped by all bulk operations.

4. **No implicit state ownership.**  Adapters never write core state directly.
   They go through the store/load-save cycle, preserving the invariant that
   GPTWork state store is the source of truth.

5. **Webhook is a separate concern.**  The webhook registry lives in its own
   module because webhook handling is server-infrastructure, not business
   logic.  It also has its own event namespace and lifecycle.
