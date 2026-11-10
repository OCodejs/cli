import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("MCP Apps Host uses the official AppBridge and sandboxed iframe", async () => {
  const html = await readFile(new URL("../pages/mcp-apps-host.html", import.meta.url), "utf8");
  assert.match(html, /@modelcontextprotocol\/ext-apps@2\.0\.0\/app-bridge/);
  assert.match(html, /new AppBridge\(/);
  assert.match(html, /new PostMessageTransport\(/);
  assert.match(html, /setAttribute\('sandbox','allow-scripts'\)/);
  assert.match(html, /resources\/read|readResource/);
});

test("MCP Apps Server registers a tool and matching UI resource", async () => {
  const source = await readFile(new URL("../mcp-apps/server/register-apps.js", import.meta.url), "utf8");
  assert.match(source, /registerAppTool\(/);
  assert.match(source, /registerAppResource\(/);
  assert.match(source, /ui:\s*\{\s*resourceUri:\s*OCODEJS_WORKSPACE_URI\s*\}/);
  assert.match(source, /RESOURCE_MIME_TYPE/);
  assert.match(source, /ocodejs_workspace_overview/);
});
