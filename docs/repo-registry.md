# Repo Registry: Canonical Multi-Repo Workspace Layout

## Problem

GPTWork/Codex can accidentally inspect a stale temporary clone (e.g., `.tmp-gh-check-*` directory) instead of the real working repository, producing misleading "local is behind" or "wrong HEAD" results. This happens because there is no canonical record of which local directory is the authoritative working copy.

## Solution

A **Repo Registry** (`<workspace>/.gptwork/repos.json`) records every registered GitHub repository with:

- Stable `repo_id` (`github.com/<owner>/<repo>`)
- Provider, host, owner, repo name
- Remote URL (SSH or HTTPS)
- Default branch
- Canonical local path
- Roles, tags, status metadata

All "is local latest", "ahead/behind", and "remote HEAD" logic uses the canonical repo registered in the registry, not a randomly discovered `.git` directory.

## Canonical Layout

```
<workspace>/
  repos/github.com/<owner>/<repo>/        canonical local clones
  worktrees/github.com/<owner>/<repo>/<task-id>/   git worktrees for task isolation
  tmp/codex/<task-id>/                    scratch/temp data
  .gptwork/repos.json                     repo registry file
```

### Canonical repo paths

- **repos/**: `workspace/repos/github.com/<owner>/<repo>`
- **worktrees/**: `workspace/worktrees/github.com/<owner>/<repo>/<task-or-run-id>`
- **tmp/**: `workspace/tmp/codex/<task-or-run-id>`

If moving an existing clone into `repos/` is risky, register the existing path as `canonical_path` in the registry and document the migration plan.

## URL Parsing

The registry parses both common GitHub URL formats:

| Format | Example |
|---|---|
| SSH | `git@github.com:owner/repo.git` |
| HTTPS | `https://github.com/owner/repo.git` |
| HTTPS (no .git) | `https://github.com/owner/repo` |
| with fragment | `https://github.com/owner/repo#main` |
| Owner/repo | `owner/repo` |

Output: `{ provider: "github", host: "github.com", owner, repo, repo_id: "github.com/owner/repo" }`

## MCP Tools

The following tools are available through the GPTWork MCP server:

### `register_repository`
Register a repository so it is discoverable by its canonical `repo_id`.

Parameters: `remote_url` (required), `canonical_path`, `default_branch`, `roles`, `tags`, `status`

### `list_repositories`
List all registered repositories with their metadata.

### `get_repository_status`
Get detailed status for a repository: local HEAD, remote HEAD, ahead/behind, has uncommitted changes, and detected stale temp clones.

If exactly one repo is registered, it is used by default. Multi-repo projects must specify `repo_id` or `owner` + `repo_name`.

### `resolve_canonical_repository`
Resolve which repository to use for the current task. Returns the canonical path, remote URL, and default branch. Call this before doing repository work.

- If exactly one repo is registered, returns it by default.
- If multiple repos exist and no `repo_id` is given, returns an error listing available repos.

### `detect_stale_clones`
Scan the workspace root for `.tmp-*` directories and report whether they contain git repos. Use this to identify stale temporary clones that should not be used as status sources.

## Using `repo_id` for Multi-Repo Tasks

When a workspace has multiple registered repositories, Codex must specify which one to use. The following identifiers are accepted:

1. Full `repo_id`: `github.com/owner/repo`
2. Owner/repo pair: `owner/repo`
3. GitHub URL: `https://github.com/owner/repo.git` or `git@github.com:owner/repo.git`
4. Unique repo name: `repo` (only if unambiguous)

**Before any repository operation**, call `resolve_canonical_repository({ repo_id })` to determine the canonical path.

## How Stale `.tmp-*` Clones Are Treated

- Directories starting with `.tmp` under the workspace root are considered **temporary**.
- The `detect_stale_clones` tool scans for them and reports their names, paths, and whether they contain a git repo.
- `get_repository_status` includes a `stale_temp_copies` field in its output.
- The system will **never** use a `.tmp-*` directory as the canonical status source.
- The old stale clone (`workspace/.tmp-gh-check-gpt-codex-workspace`) is documented in the registry context and reported by `detect_stale_clones`.

## How ChatGPT/Codex Should Inspect Latest Code

After this change, the recommended workflow for inspecting repository state:

1. Call `resolve_canonical_repository({})` to get the canonical repo path.
2. Call `get_repository_status({ repo_id })` to check local/remote HEAD, ahead/behind.
3. Before making changes, call `resolve_canonical_repository({})` to verify which repo you are working on.
4. Use `register_repository` to add any new repository before working with it.
5. Run `detect_stale_clones()` to verify no stale temp clones exist.

For multi-repo projects, always pass `repo_id` to avoid ambiguity.

## Canonical Path for `9018/gpt-codex-workspace`

The primary repository is registered as:

```json
{
  "repo_id": "github.com/9018/gpt-codex-workspace",
  "remote_url": "git@github.com:9018/gpt-codex-workspace.git",
  "default_branch": "main",
  "canonical_path": "/home/a9017/mcp/workspace/gpt-codex-workspace"
}
```

This makes the real working clone discoverable through the registry, preventing Codex from using the stale `.tmp-gh-check-gpt-codex-workspace/repo` clone for status checks.
