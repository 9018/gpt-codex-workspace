# Delayed tool discovery

GPTWork now builds a canonical read-only catalog from the assembled MCP tool registry. `tool_search` returns bounded ranked descriptors and `tool_describe` returns exact descriptors, optionally including input schemas. Handlers are never exposed by the catalog.

Set `GPTWORK_DELAYED_TOOL_DISCOVERY=true` to make `tools/list` expose only bootstrap tools (`health_check`, `runtime_status`, `open_project_context`, `tool_search`, and `tool_describe`). Tool invocation still uses the existing mode-authorized callable registry, so delayed discovery changes schema exposure rather than weakening authorization. The default is `false` for compatibility.
