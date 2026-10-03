import http from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
export function createServer(port = 4173) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      res.end("Method not allowed");
      return;
    }
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? "")) {
      res.writeHead(421);
      res.end("Local requests only");
      return;
    }
    try {
      const pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      let file = resolve(
        root,
        "." + (pathname === "/" ? "/fixtures/source-app/" : pathname),
      );
      if (!file.startsWith(root + sep)) throw Error("Not found");
      // Only public build, fixtures and the browser test bundle are served.
      if (
        !["dist", "fixtures", "artifacts/.tmp"].some((p) =>
          file.startsWith(resolve(root, p) + sep),
        )
      )
        throw Error("Not found");
      if ((await stat(file)).isDirectory()) file = resolve(file, "index.html");
      file = await realpath(file);
      if (
        !["dist", "fixtures", "artifacts/.tmp"].some((p) =>
          file.startsWith(resolve(root, p) + sep),
        )
      )
        throw Error("Not found");
      const body = await readFile(file);
      res.writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
  return new Promise((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveReady(server));
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  await createServer(port);
  console.log(
    `Source app: http://127.0.0.1:${port}/fixtures/source-app/\nStudio: http://127.0.0.1:${port}/dist/extension/studio.html\nConsumer: http://127.0.0.1:${port}/fixtures/consumer-app/`,
  );
}
