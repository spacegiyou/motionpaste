import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  validateEvidenceContent,
  validateStageContent,
  validateRunWindow,
} from "./evidence-content-guard.mjs";

export const expectedEvidence = [
  ["browser-report.json", true],
  ["authorization-report.json", true],
  ["worker-lifecycle-report.json", true],
  ["browser-negative-report.json", false],
  ["independent-report.json", true],
  ["studio-report.json", true],
  ["export-parity-report.json", true],
];
export async function snapshotInputs(root = process.cwd()) {
  const files = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "eslint.config.mjs",
    ".prettierignore",
  ];
  async function walk(path) {
    for (const entry of await readdir(resolve(root, path), {
      withFileTypes: true,
    })) {
      if (entry.name === ".DS_Store") continue;
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else throw Error(`Unexpected verification input: ${name}`);
    }
  }
  for (const path of ["src", "tests", "scripts", "fixtures", "extension"])
    await walk(path);
  const hashes = {};
  for (const file of files.sort())
    hashes[file] = createHash("sha256")
      .update(await readFile(resolve(root, file)))
      .digest("hex");
  return hashes;
}
export async function validateEvidence(
  directory,
  hash,
  startedAt,
  evidence = expectedEvidence,
  finishedAt = new Date().toISOString(),
) {
  const { start, finish } = validateRunWindow(startedAt, finishedAt);
  if (!Array.isArray(evidence) || evidence.length === 0)
    throw Error("Evidence plan must not be empty.");
  if (new Set(evidence.map(([file]) => file)).size !== evidence.length)
    throw Error("Duplicate evidence files.");
  const reports = {};
  for (const [file, needsHash] of evidence) {
    const report = JSON.parse(await readFile(resolve(directory, file), "utf8"));
    if (report.status !== "PASS") throw Error(`Evidence is not PASS: ${file}`);
    if (needsHash && report.archiveSHA256 !== hash)
      throw Error(`Archive evidence mismatch: ${file}`);
    if (
      !Number.isFinite(Date.parse(report.measuredAt)) ||
      Date.parse(report.measuredAt) < start ||
      Date.parse(report.measuredAt) > finish
    )
      throw Error(`Evidence timestamp outside run window: ${file}`);
    if (report.finishedAt !== undefined) {
      const window = validateRunWindow(report.measuredAt, report.finishedAt);
      if (window.finish > finish)
        throw Error(`Evidence finished after release run: ${file}`);
    }
    validateEvidenceContent(file, report);
    reports[file] = report;
  }
  return reports;
}
export function validatePackageProof(
  report,
  { version, archiveHash, codeHashes },
) {
  if (report.status !== "PASS" || report.productVerdict !== "PASS")
    throw Error("Packaging requires final supported-scope verification PASS.");
  if (report.version !== version || report.archiveSHA256 !== archiveHash)
    throw Error("Packaging version/archive differs from verified release.");
  validateStageContent(report);
  if (!isDeepStrictEqual(report.codeHashes, codeHashes))
    throw Error("Source changed after verification. Run npm run verify again.");
}

// Call only with reports returned by validateEvidence. Numerical summaries are
// derived from validated observations, not manually supplied completion counts.
export function deriveReleaseSummary(report, evidence) {
  return {
    pipelineStages: report.stages.length,
    extensionChecks: evidence["browser-report.json"].checks.length,
    cssWaapiCases: evidence["browser-report.json"].parityCases,
    cssWaapiTimepoints: evidence["browser-report.json"].samplePoints,
    authorizationChecks: evidence["authorization-report.json"].checks.length,
    workerLifecycleChecks:
      evidence["worker-lifecycle-report.json"].checks.length,
    forcedWorkerRestarts:
      evidence["worker-lifecycle-report.json"].summary.confirmedRestarts,
    browserGuardChecks: evidence["browser-negative-report.json"].checks.length,
    archiveChecks: evidence["independent-report.json"].checks.length,
    studioChecks: evidence["studio-report.json"].checks.length,
    exportFixtures: evidence["export-parity-report.json"].cases.length,
    exportTimepoints:
      evidence["export-parity-report.json"].summary.pairedTimepoints,
    detectedNoOpControls:
      evidence["export-parity-report.json"].summary.rejectedNoOpControls,
  };
}
export function validateReleaseSummary(report, evidence) {
  const expected = deriveReleaseSummary(report, evidence);
  if (!isDeepStrictEqual(report.summary, expected))
    throw Error("Release summary differs from validated evidence.");
}
