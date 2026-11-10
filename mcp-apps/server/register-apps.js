import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";

export const OCODEJS_WORKSPACE_URI = "ui://ocodejs/workspace.html";

/**
 * Attach the read-only OCode.js Workspace MCP App to an existing MCP SDK v2 server.
 * Call this before connecting the server transport.
 */
export function registerOCodeJsMcpApps(server, options = {}) {
  const getWorkspaceSummary = options.getWorkspaceSummary ?? (async () => ({
    name: "OCode.js CLI Hub",
    status: "connected",
    capabilities: ["MCP tools", "MCP Apps UI resources"],
    note: "Demo read-only workspace summary. Replace getWorkspaceSummary with a trusted server-side data provider."
  }));

  registerAppTool(server, "ocodejs_workspace_overview", {
    title: "OCode.js Workspace Overview",
    description: "Open an interactive, read-only overview of the OCode.js workspace.",
    inputSchema: z.object({}),
    _meta: { ui: { resourceUri: OCODEJS_WORKSPACE_URI } }
  }, async () => {
    const summary = await getWorkspaceSummary();
    return {
      content: [{ type: "text", text: JSON.stringify(summary) }],
      structuredContent: summary
    };
  });

  registerAppResource(server, "OCode.js Workspace App", OCODEJS_WORKSPACE_URI, {
    description: "Interactive read-only OCode.js workspace panel",
    mimeType: RESOURCE_MIME_TYPE
  }, async () => ({
    contents: [{
      uri: OCODEJS_WORKSPACE_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: options.html ?? OCODEJS_WORKSPACE_HTML
    }]
  }));
}

const OCODEJS_WORKSPACE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:24px;font:14px system-ui;background:#080d18;color:#edf3ff}main{max-width:720px;margin:auto}article{border:1px solid #28436b;border-radius:12px;padding:18px;background:#0c1525}.muted{color:#9eb0ca}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#bcd5ff}</style></head>
<body><main><p class="muted">OCODE.JS / MCP APP</p><h1>Workspace overview</h1><article><strong id="name">Waiting for host data…</strong><p id="status" class="muted">Initializing MCP Apps bridge</p><pre id="details"></pre></article></main>
<script type="module">
import { App } from "https://esm.sh/@modelcontextprotocol/ext-apps@2.0.0";
import { PostMessageTransport } from "https://esm.sh/@modelcontextprotocol/ext-apps@2.0.0";
const app = new App({name:"OCode.js Workspace View",version:"1.0.0"},{});
app.ontoolresult = ({content,structuredContent}) => {
 const data = structuredContent || {content};
 document.querySelector("#name").textContent = data.name || "OCode.js Workspace";
 document.querySelector("#status").textContent = data.status || "Data received from MCP server";
 document.querySelector("#details").textContent = JSON.stringify(data,null,2);
};
app.onerror = error => { document.querySelector("#status").textContent = error.message || String(error); };
await app.connect(new PostMessageTransport(window.parent,window.parent));
</script></body></html>`;
