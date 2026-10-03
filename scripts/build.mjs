import { archivePath, archiveName } from "./release-info.mjs";
import { build } from "esbuild";
import {
  mkdir,
  rm,
  copyFile,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const out = resolve("dist/extension");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const [entry, name, format] of [
  ["src/extension/worker.ts", "worker.js", "esm"],
  ["src/extension/picker.ts", "picker.js", "iife"],
  ["src/extension/popup.ts", "popup.js", "iife"],
  ["src/studio/studio.ts", "studio.js", "iife"],
]) {
  await build({
    entryPoints: [entry],
    outfile: `${out}/${name}`,
    bundle: true,
    format,
    target: "chrome120",
    legalComments: "none",
    minify: false,
  });
}
for (const [src, name] of [
  ["extension/manifest.json", "manifest.json"],
  ["src/extension/popup.html", "popup.html"],
  ["src/extension/popup.css", "popup.css"],
  ["src/studio/studio.html", "studio.html"],
  ["src/studio/studio.css", "studio.css"],
  ["LICENSE", "LICENSE"],
])
  await copyFile(src, `${out}/${name}`);
const manifest = {};
for (const name of (await readdir(out)).sort())
  manifest[name] = createHash("sha256")
    .update(await readFile(`${out}/${name}`))
    .digest("hex");
await writeFile(
  `${out}/SHA256SUMS.json`,
  JSON.stringify(manifest, null, 2) + "\n",
);
await mkdir("artifacts/release", { recursive: true });
const archive = archivePath;
await rm(archive, { force: true });
execFileSync("zip", ["-X", "-q", archive, ...(await readdir(out)).sort()], {
  cwd: out,
});
const sha = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(`${archive}.sha256`, `${sha}  ${archiveName}\n`);
console.log(
  `Built unpacked extension: ${out}\nZIP: ${archive}\nSHA256: ${sha}`,
);
