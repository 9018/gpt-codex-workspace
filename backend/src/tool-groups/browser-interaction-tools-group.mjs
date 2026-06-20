/**
 * Browser interaction MCP tool registration group.
 *
 * Extracted from gptwork-server.mjs as part of P4 tool group extraction.
 * Each tool wraps a method from the browser-http.mjs module.
 *
 * Dependencies:
 *   tool   - MCP tool factory from gptwork-server.mjs
 *   schema - schema factory from gptwork-server.mjs
 *   browser - Browser registry instance created via createBrowserRegistry()
 */
export function createBrowserInteractionToolsGroup({ tool, schema, browser }) {
  const tools = {
    browser_close_session: tool(
      "Close a browser session.",
      schema({ session_id: "string" }, ["session_id"]),
      async ({ session_id }) => browser.closeSession(session_id),
    ),
    browser_current_state: tool(
      "Return current page URL and title.",
      schema({ session_id: "string" }, ["session_id"]),
      async ({ session_id }) => browser.currentState(session_id),
    ),
    browser_extract_links: tool(
      "Extract links.",
      schema({ session_id: "string", limit: "integer" }, ["session_id"]),
      async ({ session_id, limit }) => browser.extractLinks(session_id, limit),
    ),
    browser_click: tool(
      "Record a click target (lightweight HTTP browser; clicks do not trigger JS or navigation).",
      schema({ session_id: "string", selector: "string" }, ["session_id", "selector"]),
      async ({ session_id, selector }) => browser.click(session_id, selector),
    ),
    browser_fill: tool(
      "Record input fill target (lightweight HTTP browser; does not execute form JS).",
      schema({ session_id: "string", selector: "string", text: "string" }, ["session_id", "selector", "text"]),
      async ({ session_id, selector, text }) => browser.fill(session_id, selector, text),
    ),
    browser_press: tool(
      "Record key press (lightweight HTTP browser; does not execute JS).",
      schema({ session_id: "string", selector: "string", key: "string" }, ["session_id", "selector", "key"]),
      async ({ session_id, selector, key }) => browser.press(session_id, selector, key),
    ),
    browser_wait_for_selector: tool(
      "Wait for selector (lightweight HTTP browser; no JS or DOM mutation tracking).",
      schema({ session_id: "string", selector: "string" }, ["session_id", "selector"]),
      async ({ session_id, selector }) => browser.waitForSelector(session_id, selector),
    ),
    browser_scroll: tool(
      "Record scroll target (lightweight HTTP browser; does not execute JS).",
      schema({ session_id: "string", x: "integer", y: "integer" }, ["session_id"]),
      async ({ session_id, x, y }) => browser.scroll(session_id, x, y),
    ),
    browser_screenshot: tool(
      "[EXPERIMENTAL] Take a browser screenshot. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).",
      schema({ session_id: "string", path: "string" }, ["session_id"]),
      async ({ session_id, path = "" }) => ({ ok: false, session_id, path, error: "screenshots require a Playwright-enabled browser adapter" }),
    ),
    browser_set_input_files: tool(
      "[EXPERIMENTAL] Upload files to a browser input. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).",
      schema({ session_id: "string", selector: "string", path: "string" }, ["session_id", "selector", "path"]),
      async (args) => ({ ok: false, ...args, error: "file input automation requires a Playwright-enabled browser adapter" }),
    ),
    browser_click_and_download: tool(
      "[EXPERIMENTAL] Click an element and download its target. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).",
      schema({ session_id: "string", selector: "string", path: "string" }, ["session_id", "selector"]),
      async (args) => ({ ok: false, ...args, error: "download automation requires a Playwright-enabled browser adapter" }),
    ),
    browser_evaluate: tool(
      "[EXPERIMENTAL] Evaluate JavaScript in the browser page. Requires a Playwright-enabled browser adapter (not available in the default lightweight HTTP browser).",
      schema({ session_id: "string", script: "string" }, ["session_id", "script"]),
      async ({ session_id, script }) => browser.evaluate(session_id, script),
    ),
  };

  // Gate experimental browser placeholder tools behind env flags (hidden by default unless
  // GPTWORK_EXPOSE_PLACEHOLDER_TOOLS or GPTWORK_EXPERIMENTAL_BROWSER_TOOLS is set)
  const _exposePlaceholderTools = process.env.GPTWORK_EXPOSE_PLACEHOLDER_TOOLS === "true";
  if (!_exposePlaceholderTools && process.env.GPTWORK_EXPERIMENTAL_BROWSER_TOOLS !== "true") {
    delete tools.browser_screenshot;
    delete tools.browser_set_input_files;
    delete tools.browser_click_and_download;
    delete tools.browser_evaluate;
  }

  return tools;
}
