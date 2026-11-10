# OCode.js MCP Apps — Host + Server

This folder adds both MCP Apps roles using the official Model Context Protocol extension.

## 1. Host (GitHub Pages)

Open `https://zskbot.github.io/ocodejs-cli/pages/mcp-apps-host.html`.

- Connect to an MCP Streamable HTTP endpoint.
- Discover tools and call a selected tool with JSON arguments.
- If the tool advertises `_meta.ui.resourceUri`, read its `ui://` resource.
- Render the returned HTML in a sandboxed iframe and connect it through the official `AppBridge` / `PostMessageTransport` SDK.
- Forward tool input and result to the View.

The page imports the official browser ESM builds from esm.sh. Keep this host on HTTPS. A remote MCP server must explicitly allow the GitHub Pages origin through CORS. The browser cannot bypass authentication, CORS, or server transport requirements.

## 2. Server (Node.js MCP SDK v2)

`server/` contains an installable example module. It exports `registerOCodeJsMcpApps(server, options)`, which registers:

- Tool: `ocodejs_workspace_overview`
- UI resource: `ui://ocodejs/workspace.html`
- Tool metadata: `_meta.ui.resourceUri`
- UI MIME type: `text/html;profile=mcp-app`

Install dependencies in the MCP server project using the package.json in this folder, then import the module and call it before connecting the MCP transport:

```js
import { McpServer } from "@modelcontextprotocol/server";
import { registerOCodeJsMcpApps } from "./register-apps.js";

const server = new McpServer({ name: "OCode.js MCP", version: "1.0.0" });
registerOCodeJsMcpApps(server, {
  getWorkspaceSummary: async () => ({
    name: "OCode.js CLI Hub",
    status: "ready",
    capabilities: ["read-only workspace overview"]
  })
});
```

This is a server integration module, not a deployment of the separate production/staging MCP Worker. Import it into the actual backend, rebuild, and deploy that backend separately after reviewing its current code and secrets.

## Security and compatibility

- UI tool is read-only; no shell execution, filesystem writes, credentials, or deployment actions.
- Never expose bearer tokens in browser URLs or commit secrets.
- Validate the Host origin with CORS on the server; use authentication at the MCP transport layer.
- Render the View with a sandboxed iframe. Do not add `allow-same-origin` without a documented threat review.
- MCP Apps is progressive enhancement: non-Apps clients can still consume the tool's text/structured result.
- Host support differs by client. The OCode.js page is a developer/test host, not a replacement for every chat client's built-in host.

Official references:
- https://github.com/modelcontextprotocol/ext-apps
- https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/overview.md
- https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/quickstart.md
