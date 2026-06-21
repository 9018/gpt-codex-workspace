/**
 * github-adapter.mjs — compatibility facade for GitHub sync helpers.
 */

export { parseRepo, parseIssueNumber } from "./github-adapter-utils.mjs";
export { createGithubSync } from "./github-sync-factory.mjs";
export {
  checkDirectGitAvailable,
  checkSshAuthAvailable,
  checkGhCliAvailable,
  detectWorkspaceRepo,
  grabIssue,
  getStatusWithAsyncChecks,
  syncToGitHubResult,
} from "./github-connectivity.mjs";
