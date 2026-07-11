export function workstreamsFromState(state) {
  return Array.isArray(state?.workstreams) ? state.workstreams : [];
}

export function workstreamLinksFromState(state) {
  return Array.isArray(state?.context_links) ? state.context_links : [];
}

export function ensureWorkstreamState(state) {
  if (!Array.isArray(state.workstreams)) state.workstreams = [];
  if (!Array.isArray(state.context_links)) state.context_links = [];
  return state;
}

export function findWorkstreamInState(state, id) {
  return workstreamsFromState(state).find((item) => item.id === id) || null;
}

export function findWorkstreamLinkInState(state, id) {
  return workstreamLinksFromState(state).find((item) => item.id === id) || null;
}
