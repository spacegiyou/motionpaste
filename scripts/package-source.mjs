import { sourceArchiveName, archivePath, version } from "./release-info.mjs";
import {
  snapshotInputs,
  validateEvidence,
  validatePackageProof,
  validateReleaseSummary,
} from "./verification-integrity.mjs";
import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function authorizeSourcePackage({
  root = process.cwd(),
  archive = archivePath,
  releaseVersion = version,
} = {}) {
  const proof = JSON.parse(
    await readFile(
      resolve(root, "artifacts/verification/FINAL_REPORT.json"),
      "utf8",
    ),
  );
  validatePackageProof(proof, {
    version: releaseVersion,
    archiveHash: createHash("sha256")
      .update(await readFile(resolve(root, archive)))
      .digest("hex"),
    codeHashes: await snapshotInputs(root),
  });
  const evidence = await validateEvidence(
    resolve(root, "artifacts/verification"),
    proof.archiveSHA256,
    proof.startedAt,
    undefined,
    proof.finishedAt,
  );
  validateReleaseSummary(proof, evidence);
  return proof;
}

export async function packageSource() {
  await authorizeSourcePackage();

  const roots = [
    "src",
    "tests",
    "scripts",
    "fixtures",
    "extension",
    "docs",
    ".github",
  ];
  const files = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "eslint.config.mjs",
    ".gitignore",
    ".prettierignore",
    "README.md",
    "00_START_HERE_KO.md",
    "HANDOFF.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "LICENSE",
  ];
  async function collect(path) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.name === ".DS_Store") continue;
      const child = `${path}/${item.name}`;
      if (item.isDirectory()) await collect(child);
      else if (item.isFile()) files.push(child);
    }
  }
  for (const path of roots) await collect(path);
  await mkdir("artifacts/release", { recursive: true });
  const manifest = {};
  for (const file of files.sort())
    manifest[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  await writeFile(
    `artifacts/release/source-${version}-SHA256SUMS.json`,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const archive = resolve(`artifacts/release/${sourceArchiveName}`);
  await rm(archive, { force: true });
  execFileSync("zip", ["-X", "-q", archive, ...files]);
  const hash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${hash}  ${sourceArchiveName}\n`);
  console.log(`Source package ${archive}\nSHA256 ${hash}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await packageSource();
