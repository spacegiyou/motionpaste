import { spawnSync } from "node:child_process";
import { mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { archivePath, version } from "./release-info.mjs";
import {
  snapshotInputs,
  validateEvidence,
  deriveReleaseSummary,
  validateReleaseSummary,
} from "./verification-integrity.mjs";
import {
  EVIDENCE_SCHEMA,
  REQUIRED_STAGES,
  validateStageContent,
} from "./evidence-content-guard.mjs";
import { isDeepStrictEqual } from "node:util";

export async function runStages(
  stages,
  {
    reportPath,
    logPath,
    execute = spawnSync,
    cwd = process.cwd(),
    releaseVersion = version,
  },
) {
  await mkdir(dirname(reportPath), { recursive: true });
  await mkdir(dirname(logPath), { recursive: true });
  const report = {
    status: "RUNNING",
    productVerdict: "NOT_EVALUATED",
    scope:
      "Automated local supported-scope release checks; not public release or universal compatibility.",
    startedAt: new Date().toISOString(),
    version: releaseVersion,
    evidenceSchema: EVIDENCE_SCHEMA,
    stages: [],
  };
  const save = () =>
    writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await save();
  await writeFile(logPath, "");
  for (const stage of stages) {
    for (const path of stage.evidencePaths ?? [])
      await rm(path, { force: true });
    const start = Date.now();
    const result = await execute(stage.command, stage.args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    const output =
      (result.stdout ?? "") +
      (result.stderr ?? "") +
      (result.error ? String(result.error) : "");
    await appendFile(logPath, `\n=== ${stage.name} ===\n${output}`);
    const passed = result.status === 0 && !result.error && !result.signal;
    report.stages.push({
      name: stage.name,
      status: passed ? "PASS" : "FAIL",
      exitCode: result.status,
      signal: result.signal,
      error: result.error ? String(result.error) : undefined,
      durationMs: Date.now() - start,
    });
    console.log(`${passed ? "PASS" : "FAIL"} ${stage.name}`);
    if (!passed) {
      report.status = "FAIL";
      report.productVerdict = "FAIL";
      report.finishedAt = new Date().toISOString();
      await save();
      return report;
    }
    await save();
  }
  report.status = "PASS";
  report.productVerdict = "NOT_EVALUATED";
  report.finishedAt = new Date().toISOString();
  await save();
  return report;
}

export async function verifyRelease({
  root = process.cwd(),
  archive = archivePath,
  releaseVersion = version,
  execute = spawnSync,
} = {}) {
  const output = resolve(root, "artifacts/verification");
  const reportPath = resolve(output, "RUN_REPORT.json");
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "FINAL_REPORT.json"),
    JSON.stringify(
      {
        status: "RUNNING",
        productVerdict: "RUNNING",
        version: releaseVersion,
        runReport: "RUN_REPORT.json",
      },
      null,
      2,
    ) + "\n",
  );
  const codeHashes = await snapshotInputs(root);
  const evidenceForStage = {
    "extension-e2e": "browser-report.json",
    authorization: "authorization-report.json",
    "worker-lifecycle": "worker-lifecycle-report.json",
    "browser-guards": "browser-negative-report.json",
    "archive-smoke": "independent-report.json",
    "studio-regressions": "studio-report.json",
    "downloaded-export-parity": "export-parity-report.json",
  };
  const plan = [
    ["format", "format:check"],
    ["lint", "lint"],
    ["typecheck", "typecheck"],
    ["unit", "test"],
    ["verification-runner", "test:runner"],
    ["server", "test:server"],
    ["coverage", "coverage"],
    ["build", "build"],
    ["extension-e2e", "test:browser"],
    ["authorization", "test:authorization"],
    ["worker-lifecycle", "test:worker-lifecycle"],
    ["browser-guards", "test:negative"],
    ["archive-smoke", "test:archive"],
    ["studio-regressions", "test:studio"],
    ["downloaded-export-parity", "test:export"],
  ].map(([name, script]) => ({
    name,
    command: "npm",
    args: ["run", script],
    evidencePaths: evidenceForStage[name]
      ? [resolve(output, evidenceForStage[name])]
      : [],
  }));
  if (
    !isDeepStrictEqual(
      plan.map((stage) => stage.name),
      REQUIRED_STAGES,
    )
  )
    throw Error("Release stage plan differs from reviewed contract.");
  const report = await runStages(plan, {
    reportPath,
    logPath: resolve(output, "verification.log"),
    execute,
    cwd: root,
    releaseVersion,
  });
  return finalizeReleaseReport(report, { root, archive, codeHashes });
}

// Shared production promotion boundary. Tests inject synthetic reports here;
// the CLI passes the report produced by actual subprocess stages above.
export async function finalizeReleaseReport(
  report,
  { root = process.cwd(), archive = archivePath, codeHashes },
) {
  const output = resolve(root, "artifacts/verification");
  const reportPath = resolve(output, "RUN_REPORT.json");
  if (report.status === "PASS") {
    try {
      const hash = createHash("sha256")
        .update(await readFile(resolve(root, archive)))
        .digest("hex");
      validateStageContent(report);
      const evidence = await validateEvidence(
        output,
        hash,
        report.startedAt,
        undefined,
        report.finishedAt,
      );
      if (!isDeepStrictEqual(codeHashes, await snapshotInputs(root)))
        throw Error("Source changed during verification.");
      if (Object.hasOwn(report, "summary"))
        validateReleaseSummary(report, evidence);
      report.summary = deriveReleaseSummary(report, evidence);
      report.archiveSHA256 = hash;
      report.codeHashes = codeHashes;
      report.productVerdict = "PASS";
    } catch (error) {
      report.status = "FAIL";
      report.productVerdict = "FAIL";
      report.evidenceError = String(error);
    }
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  await writeFile(
    resolve(output, "FINAL_REPORT.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`RELEASE ${report.status}: ${reportPath}`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await verifyRelease();
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
