import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

test("CLI Hub exposes an accessible GitHub login dialog", () => {
  for (const id of ["auth-trigger","auth-overlay","auth-title","auth-close","auth-status","auth-github","auth-pat-form","auth-pat-token","auth-logout","auth-disconnect"]) {
    assert.match(html, new RegExp('id="' + id + '"'));
  }
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /aria-live="polite"/);
});

test("auth client uses credentialed HTTPS API requests and CSRF headers", () => {
  assert.match(html, /https:\/\/auth\.ocodejs\.dev/);
  assert.match(html, /credentials:"include"/);
  assert.match(html, /X-Ocode-CSRF/);
  assert.match(html, /\/auth\/github/);
  assert.match(html, /\/auth\/session/);
  assert.match(html, /\/auth\/pat/);
  assert.match(html, /\/auth\/logout/);
  assert.match(html, /\/auth\/disconnect/);
});

test("PAT input is password-only and never persisted in browser storage", () => {
  assert.match(html, /id="auth-pat-token"[^>]*type="password"/);
  assert.match(html, /input\.value=""/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^\n]*(?:token|pat)/i);
  assert.doesNotMatch(html, /sessionStorage\.setItem\([^\n]*(?:token|pat)/i);
});

test("auth dialog keeps square-corner dark visual styling and mobile layout", () => {
  assert.match(html, /\.auth-dialog\s*\{[^}]*background:#080b10/s);
  assert.match(html, /\.auth-button\s*\{[^}]*border:/s);
  assert.match(html, /@media\(max-width:480px\)\{\.auth-overlay/s);
});

test("inline application scripts remain syntactically valid", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(source => source.trim());
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new Function(source));
});
