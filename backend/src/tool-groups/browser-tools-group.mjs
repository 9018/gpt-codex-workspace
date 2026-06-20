/**
 * Lightweight HTTP browser MCP tool registration group.
 *
 * Extracted from gptwork-server.mjs as part of P4 tool group extraction.
 * Each tool wraps a method from the browser-http.mjs module.
 *
 * Dependencies:
 *   tool   - MCP tool factory from gptwork-server.mjs
 *   schema - schema factory from gptwork-server.mjs
 *   browser - Browser registry instance created via createBrowserRegistry()
 */
export function createBrowserToolsGroup({ tool, schema, browser }) {
  return {
    browser_new_session: tool(
      "Create a lightweight HTTP browser session (no JS execution, no real rendering).",
      schema({ headless: "boolean", viewport_width: "integer", viewport_height: "integer" }),
      async (args) => browser.newSession(args),
    ),
    browser_list_sessions: tool(
      "List browser sessions.",
      schema({}),
      async () => browser.listSessions(),
    ),
    browser_goto: tool(
      "Navigate a browser session to a URL. Performs a server-side HTTP GET; page JavaScript is not executed.",
      schema({ session_id: "string", url: "string" }, ["session_id", "url"]),
      async ({ session_id, url }) => browser.goto(session_id, url),
    ),
    browser_get_text: tool(
      "Extract visible inner text.",
      schema({ session_id: "string", max_chars: "integer" }, ["session_id"]),
      async ({ session_id, max_chars }) => browser.getText(session_id, max_chars),
    ),
    browser_get_html: tool(
      "Extract HTML.",
      schema({ session_id: "string", max_chars: "integer" }, ["session_id"]),
      async ({ session_id, max_chars }) => browser.getHtml(session_id, max_chars),
    ),
  };
}
