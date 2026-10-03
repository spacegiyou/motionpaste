import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
export const version = pkg.version;
export const archiveName = `motionpaste-${version}.zip`;
export const archivePath = resolve("artifacts/release", archiveName);
export const sourceArchiveName = `motionpaste-source-${version}.zip`;
