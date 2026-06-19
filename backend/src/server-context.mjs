export const OPTION_SOURCE_MAP = [
  ['statePath', 'statePath'],
  ['defaultWorkspaceRoot', 'workspaceRoot'],
  ['requireAuth', 'requireAuth'],
  ['codexHome', 'codexHome'],
  ['codexExecArgs', 'codexExecArgs'],
  ['codexExecTimeout', 'codexExecTimeout'],
  ['codexFirstOutputTimeout', 'codexFirstOutputTimeout'],
  ['codexStallThreshold', 'codexStallThreshold'],
  ['maxReadBytes', 'maxReadBytes'],
  ['maxShellOutputBytes', 'maxShellOutputBytes'],
  ['barkEnabled', 'barkEnabled'],
  ['barkUrl', 'barkUrl'],
  ['barkKey', 'barkKey'],
  ['barkGroup', 'barkGroup'],
  ['barkSound', 'barkSound'],
  ['barkLevel', 'barkLevel'],
  ['barkIconUrl', 'barkIconUrl'],
  ['barkClickUrl', 'barkClickUrl'],
  ['defaultRepo', 'defaultRepo'],
  ['defaultBranch', 'defaultBranch'],
  ['defaultRepoPath', 'defaultRepoPath'],
  ['defaultRemote', 'defaultRemote'],
];

export function applyOptionSourceOverrides(sources = {}, options = {}) {
  for (const [optionKey, sourceKey] of OPTION_SOURCE_MAP) {
    if (options[optionKey] !== undefined) {
      sources[sourceKey] = 'options';
    }
  }
  return sources;
}

export function createServerContext({
  config,
  store,
  browser,
  github,
  bark,
  barkConfigSource,
  envLoadResult,
  earlyEnvResult,
} = {}) {
  return {
    config,
    store,
    browser,
    github,
    bark,
    barkConfigSource,
    envLoadResult,
    earlyEnvResult,
  };
}
