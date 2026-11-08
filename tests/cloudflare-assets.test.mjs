import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const ignoredAssets = await readFile(new URL("../.assetsignore", import.meta.url), "utf8");

test("Cloudflare static Worker declares a Preview configuration", () => {
  assert.equal(config.name, "ocodejs-cli");
  assert.equal(config.assets.directory, ".");
  assert.deepEqual(config.previews, {});
});

test("Cloudflare static assets exclude server-side source and repository metadata", () => {
  for (const path of [
    ".github/",
    "ai-control-center/",
    "auth-server/",
    "auth-worker/",
    "scripts/",
    "secrets/",
    "tests/",
    "node_modules/",
    "wrangler.jsonc",
    "package.json",
    ".env"
  ]) {
    assert.ok(ignoredAssets.split(/\r?\n/).includes(path), "missing asset exclusion " + path);
  }
});
