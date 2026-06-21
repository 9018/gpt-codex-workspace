/**
 * repo-registry.mjs — compatibility facade for repo registry helpers.
 */

export {
  parseGitHubUrl,
  deriveCanonicalRelPath,
  deriveCanonicalPath,
  deriveWorktreeRelPath,
  deriveWorktreePath,
  deriveTmpRelPath,
  deriveTmpPath,
  isTempClone,
  isCanonicalPath,
  detectStaleTempClones,
} from "./repo-registry-paths.mjs";

export { RepoRegistry } from "./repo-registry-class.mjs";
export { _gitExec, _detectGitBranch, getRepoStatus } from "./repo-registry-git.mjs";
