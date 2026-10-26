import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { build } from "esbuild";

// These synthetic build files exercise the actual static-serving middleware.
// The Docker smoke separately verifies the real Vite build inside the image.
const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = '<!doctype html><html><body>Admin fixture<script type="module" src="/assets/admin-fixture.js"></script></body></html>';
const javascript = 'document.body.dataset.fixture = "loaded";';
const privateSentinel = "ADMIN_UI_PRIVATE_FIXTURE_MUST_NOT_BE_SERVED";
let temporary, dist, mountAdminUi, server;

before(async () => {
  temporary = await mkdtemp(path.join(apiRoot, ".admin-ui-test-"));
  const entry = path.join(temporary, "middleware.mjs");
  await build({
    entryPoints: [path.join(apiRoot, "src/middleware/adminUi.ts")],
    outfile: entry, bundle: true, platform: "node", format: "esm", target: "node22",
    external: ["express"], logLevel: "silent",
  });
  ({ mountAdminUi } = await import(pathToFileURL(entry).href));
  dist = path.join(temporary, "dist");
  await mkdir(path.join(dist, "assets"), { recursive: true });
  await writeFile(path.join(dist, "index.html"), html);
  await writeFile(path.join(dist, "assets/admin-fixture.js"), javascript);
  await writeFile(path.join(dist, ".env"), privateSentinel);
  await writeFile(path.join(dist, "source.ts"), privateSentinel);
  await writeFile(path.join(dist, "assets/.env"), privateSentinel);
  await writeFile(path.join(temporary, "outside.txt"), privateSentinel);

  const app = express();
  app.get("/api/status", (_request, response) => response.json({ fixture: "api-preserved" }));
  mountAdminUi(app, dist);
  app.use((_request, response) => response.status(404).json({ error: "fixture-not-found" }));
  app.use((error, _request, response, _next) => response.status(error.status ?? 500).json({ error: "fixture-error" }));
  server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
});

after(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

function request(pathname, method = "GET") {
  // Pass the literal path through Node HTTP so encoded traversal is not
  // normalized away by a URL/fetch client before it reaches Express.
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port: server.address().port, path: pathname, method }, incoming => {
      let body = "";
      incoming.setEncoding("utf8");
      incoming.on("data", chunk => { body += chunk; });
      incoming.on("error", reject);
      incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers, body }));
    });
    outgoing.setTimeout(5000, () => outgoing.destroy(new Error("Admin UI fixture HTTP timeout")));
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("GET /admin and /admin/ serve the built HTML without caching or redirecting", async () => {
  for (const pathname of ["/admin", "/admin/", "/admin?section=monitoring"]) {
    const response = await request(pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers["content-type"], /^text\/html\b/i);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers.location, undefined);
    assert.equal(response.body, html);
  }
});

test("the built asset URL serves JavaScript and both document and asset support HEAD", async () => {
  const asset = await request("/assets/admin-fixture.js");
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /(?:application|text)\/javascript\b/i);
  assert.equal(asset.body, javascript);
  assert.equal(asset.headers["cache-control"], "no-store");
  for (const pathname of ["/admin", "/assets/admin-fixture.js"]) {
    const head = await request(pathname, "HEAD");
    assert.equal(head.status, 200, pathname);
    assert.equal(head.body, "");
    assert.equal(head.headers["cache-control"], "no-store");
    assert.ok(Number(head.headers["content-length"]) > 0);
  }
});

test("unknown assets, nested admin URLs and non-GET requests never fall back to HTML", async () => {
  for (const [pathname, method] of [["/", "GET"], ["/admin/unknown", "GET"], ["/assets/missing.js", "GET"],
    ["/assets", "GET"], ["/assets/", "GET"], ["/admin", "POST"], ["/assets/admin-fixture.js", "POST"]]) {
    const response = await request(pathname, method);
    assert.equal(response.status, 404, `${method} ${pathname}`);
    assert.equal(response.headers.location, undefined, "No static-directory redirect is exposed.");
    assert.deepEqual(JSON.parse(response.body), { error: "fixture-not-found" });
    assert.doesNotMatch(response.headers["content-type"] ?? "", /text\/html/i);
  }
});

test("private build files, dotfiles and literal encoded traversal cannot escape the assets root", async () => {
  for (const pathname of ["/.env", "/source.ts", "/admin/.env", "/admin/source.ts", "/assets/.env",
    "/assets/%2eenv", "/assets/../.env", "/assets/%2e%2e%2f.env", "/assets/%2e%2e%2fsource.ts",
    "/assets/%2e%2e%2f%2e%2e%2foutside.txt"]) {
    const response = await request(pathname);
    assert.ok([400, 403, 404].includes(response.status), pathname);
    assert.equal(response.body.includes(privateSentinel), false, pathname);
    assert.equal(response.body.includes(temporary), false, "Error responses must not expose local paths.");
    assert.doesNotMatch(response.headers["content-type"] ?? "", /text\/html/i);
  }
});

test("existing API responses remain JSON and are not replaced or reheadered by the admin middleware", async () => {
  const response = await request("/api/status");
  assert.equal(response.status, 200);
  assert.match(response.headers["content-type"], /^application\/json\b/i);
  assert.deepEqual(JSON.parse(response.body), { fixture: "api-preserved" });
  assert.equal(response.headers["cache-control"], undefined);
});

test("mounting refuses a missing or incomplete build before an HTTP listener is started", async () => {
  assert.throws(() => mountAdminUi(express(), path.join(temporary, "missing-build")));
  const noIndex = path.join(temporary, "no-index");
  await mkdir(path.join(noIndex, "assets"), { recursive: true });
  assert.throws(() => mountAdminUi(express(), noIndex));
  const noAssets = path.join(temporary, "no-assets");
  await mkdir(noAssets);
  await writeFile(path.join(noAssets, "index.html"), html);
  assert.throws(() => mountAdminUi(express(), noAssets));
});
