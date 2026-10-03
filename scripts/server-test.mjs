import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer } from "./serve.mjs";

let server, base, fixture;
before(async () => {
  server = await createServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  fixture = await mkdtemp(resolve("fixtures/server-test-"));
});
after(async () => {
  await new Promise((r) => server.close(r));
  await rm(fixture, { recursive: true, force: true });
});
function request(path, method = "GET", headers = {}) {
  return new Promise((resolveResult, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      let body = "";
      res.on("data", (x) => (body += x));
      res.on("end", () =>
        resolveResult({ status: res.statusCode, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}
for (const [path, type] of [
  ["/", "text/html"],
  ["/fixtures/source-app/", "text/html"],
  ["/fixtures/source-app/source.js", "text/javascript"],
  ["/fixtures/source-app/source.css", "text/css"],
  ["/fixtures/consumer-app/", "text/html"],
])
  test(`serves ${path} with correct type`, async () => {
    const r = await request(path);
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"], new RegExp(type));
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.ok(r.body.length > 0);
  });
test("HEAD has no response body", async () => {
  const r = await request("/fixtures/source-app/", "HEAD");
  assert.equal(r.status, 200);
  assert.equal(r.body, "");
});
test("POST is rejected", async () => {
  const r = await request("/fixtures/source-app/", "POST");
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, "GET, HEAD");
});
test("remote Host rejected", async () =>
  assert.equal(
    (await request("/", "GET", { Host: "attacker.invalid" })).status,
    421,
  ));
for (const path of [
  "/package.json",
  "/fixtures/%2e%2e%2fpackage.json",
  "/fixtures/%00",
  "/fixtures/%ZZ",
  "/fixtures/missing",
])
  test(`does not expose ${path}`, async () =>
    assert.equal((await request(path)).status, 404));
test("symlink cannot expose private project files", async () => {
  await symlink(resolve("package.json"), resolve(fixture, "leak.json"));
  assert.equal(
    (await request(`/fixtures/${fixture.split("/").at(-1)}/leak.json`)).status,
    404,
  );
});
test("occupied port rejects instead of hanging", async () => {
  await assert.rejects(createServer(server.address().port), {
    code: "EADDRINUSE",
  });
});
