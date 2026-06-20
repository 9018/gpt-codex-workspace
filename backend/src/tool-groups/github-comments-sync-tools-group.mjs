/**
 * Scoped MCP tool group: GitHub comments sync tool.
 * Polls GitHub Issues for new comments and imports ChatGPT responses as answers
 * to coordination requests. Preserves auth context behavior, GitHub adapter 
 * behavior, and response shapes exactly.
 */
export function createGithubCommentsSyncToolsGroup({ tool, schema, store, github }) {
  return {
    sync_github_comments: tool("Poll GitHub Issues for new comments and import ChatGPT responses as answers to coordination requests. After ChatGPT responds to a question via GitHub Issue comment, use this to bring the answer back into the system.", schema({}), async () => {
      const responses = await github.importResponsesFromComments(store);
      return { checked_issues: github.getKnownIssues().length, responses_found: responses.length, responses: responses.map((r) => ({ request_id: r.request_id, from: r.user })) };
    }),
  };
}
