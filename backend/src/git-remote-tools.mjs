/**
 * git-remote-tools.mjs — compatibility facade for git remote reader handlers.
 */

export { handleResolveRepo, handleFetch, handleStatus } from "./git-remote-repo-handlers.mjs";
export { handleListFiles, handleReadFile } from "./git-remote-file-handlers.mjs";
export { handleChangedFiles, handleDiff, handleShowCommit, handleCompareLocal } from "./git-remote-diff-handlers.mjs";
