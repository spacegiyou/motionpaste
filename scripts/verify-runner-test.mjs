import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStages,
  verifyRelease,
  finalizeReleaseReport,
} from "./verify-release.mjs";
import { closeLifecycleContext } from "./worker-lifecycle-test.mjs";
import { EVIDENCE_SCHEMA, REQUIRED_STAGES } from "./evidence-content-guard.mjs";
import {
  evidenceFixtures,
  syntheticLifecycleFixture,
} from "../tests/fixtures/evidence-fixtures.mjs";
import { authorizeSourcePackage } from "./package-source.mjs";
import { createHash } from "node:crypto";
import {
  validateEvidence,
  validatePackageProof,
} from "./verification-integrity.mjs";

async function run(stages) {
  const root = await mkdtemp(join(tmpdir(), "motionpaste-runner-"));
  try {
    const reportPath = join(root, "RUN_REPORT.json");
    const result = await runStages(stages, {
      reportPath,
      logPath: join(root, "log.txt"),
    });
    assert.deepEqual(
      JSON.parse(await readFile(reportPath, "utf8")),
      JSON.parse(JSON.stringify(result)),
    );
    return result;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("missing executable leaves a failure report and stops following work", async () => {
  const result = await run([
    {
      name: "missing-tool",
      command: "motionpaste_nonexistent_executable_7821",
      args: [],
    },
    {
      name: "must-not-run",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    },
  ]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.productVerdict, "FAIL");
  assert.equal(result.stages.length, 1);
  assert.match(result.stages[0].error, /ENOENT/);
});
test("nonzero tool exit cannot become PASS", async () => {
  const result = await run([
    {
      name: "bad-test",
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
    },
  ]);
  assert.equal(result.status, "FAIL");
  assert.equal(result.stages[0].exitCode, 7);
});
test("passing a local command is insufficient to claim product ready", async () => {
  const result = await run([
    {
      name: "local-test",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
    },
  ]);
  assert.equal(result.status, "PASS");
  assert.equal(result.productVerdict, "NOT_EVALUATED");
});

test("no-op successful stage cannot reuse an earlier evidence file", async () => {
  const root = await mkdtemp(join(tmpdir(), "motionpaste-stale-"));
  try {
    const evidence = join(root, "evidence.json");
    await writeFile(
      evidence,
      JSON.stringify({
        status: "PASS",
        archiveSHA256: "hash",
        measuredAt: new Date().toISOString(),
      }),
    );
    const result = await runStages(
      [
        {
          name: "noop",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
          evidencePaths: [evidence],
        },
      ],
      { reportPath: join(root, "run.json"), logPath: join(root, "log") },
    );
    assert.equal(result.productVerdict, "NOT_EVALUATED");
    await assert.rejects(
      validateEvidence(root, "hash", result.startedAt, [
        ["evidence.json", true],
      ]),
      { code: "ENOENT" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale, failed or different-archive evidence is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "motionpaste-evidence-"));
  const start = "2026-10-03T01:00:00.000Z";
  try {
    for (const report of [
      {
        status: "PASS",
        archiveSHA256: "hash",
        measuredAt: "2026-10-02T01:00:00.000Z",
      },
      { status: "FAIL", archiveSHA256: "hash", measuredAt: start },
      { status: "PASS", archiveSHA256: "other", measuredAt: start },
      { status: "PASS", archiveSHA256: "hash" },
    ]) {
      await writeFile(join(root, "evidence.json"), JSON.stringify(report));
      await assert.rejects(
        validateEvidence(root, "hash", start, [["evidence.json", true]]),
      );
    }
    const report = (await evidenceFixtures())["browser-report.json"];
    report.archiveSHA256 = "hash";
    report.measuredAt = start;
    await writeFile(join(root, "browser-report.json"), JSON.stringify(report));
    await validateEvidence(
      root,
      "hash",
      start,
      [["browser-report.json", true]],
      start,
    );
    for (const window of [
      ["invalid", start],
      [start, "invalid"],
      [start, "2026-10-02T01:00:00Z"],
      ["2026-10-04T01:00:00Z", "2026-10-04T02:00:00Z"],
    ])
      await assert.rejects(
        validateEvidence(
          root,
          "hash",
          window[0],
          [["browser-report.json", true]],
          window[1],
        ),
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source package requires verified version, archive and unchanged code", () => {
  const proof = {
    status: "PASS",
    productVerdict: "PASS",
    version: "test",
    evidenceSchema: EVIDENCE_SCHEMA,
    startedAt: "2026-10-03T00:00:00Z",
    finishedAt: "2026-10-03T00:01:00Z",
    stages: REQUIRED_STAGES.map((name) => ({
      name,
      status: "PASS",
      exitCode: 0,
      signal: null,
      durationMs: 1,
    })),
    archiveSHA256: "archive",
    codeHashes: { "src/core.ts": "source" },
  };
  const expected = {
    version: "test",
    archiveHash: "archive",
    codeHashes: proof.codeHashes,
  };
  validatePackageProof(proof, expected);
  for (const edit of [
    { stages: [] },
    { status: "FAIL" },
    { status: "RUNNING" },
    { productVerdict: "NOT_EVALUATED" },
    { version: "wrong" },
    { archiveSHA256: "changed" },
    { codeHashes: { "src/core.ts": "changed" } },
  ])
    assert.throws(() => validatePackageProof({ ...proof, ...edit }, expected));
});

// These are validator/promotion/packaging integration simulations, not browser executions.
async function integrationFixture() {
  const root = await mkdtemp(join(tmpdir(), "motionpaste-promotion-"));
  for (const path of [
    "src",
    "tests",
    "scripts",
    "fixtures",
    "extension",
    "artifacts/verification",
    "artifacts/release",
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const path of [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "eslint.config.mjs",
    ".prettierignore",
  ])
    await writeFile(join(root, path), "{}\n");
  const archive = join(root, "artifacts/release/synthetic.zip");
  await writeFile(
    archive,
    "Explicit synthetic archive used only to test evidence gates.",
  );
  const archiveHash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  const originals = await evidenceFixtures();
  const byScript = {
    "test:browser": "browser-report.json",
    "test:authorization": "authorization-report.json",
    "test:worker-lifecycle": "worker-lifecycle-report.json",
    "test:negative": "browser-negative-report.json",
    "test:archive": "independent-report.json",
    "test:studio": "studio-report.json",
    "test:export": "export-parity-report.json",
  };
  const output = join(root, "artifacts/verification");
  const previous = {
    status: "PASS",
    productVerdict: "PASS",
    staleMarker: "must be replaced",
  };
  await writeFile(join(output, "RUN_REPORT.json"), JSON.stringify(previous));
  await writeFile(join(output, "FINAL_REPORT.json"), JSON.stringify(previous));
  return { root, archive, archiveHash, originals, output, byScript };
}
async function simulateRelease(fixture, mutate = () => {}, options = {}) {
  let calls = 0;
  return verifyRelease({
    root: fixture.root,
    archive: fixture.archive,
    releaseVersion: "synthetic-validator-test",
    execute: async (_command, args) => {
      calls++;
      if (calls === 1) {
        const final = JSON.parse(
          await readFile(join(fixture.output, "FINAL_REPORT.json"), "utf8"),
        );
        assert.equal(final.productVerdict, "RUNNING");
        assert.equal(final.staleMarker, undefined);
      }
      const file = fixture.byScript[args[1]];
      if (file && !(options.noop && file === options.noop)) {
        const at = new Date().toISOString();
        const report =
          file === "worker-lifecycle-report.json"
            ? syntheticLifecycleFixture(at)
            : structuredClone(fixture.originals[file]);
        report.measuredAt = at;
        report.archiveSHA256 = fixture.archiveHash;
        mutate(file, report);
        await writeFile(join(fixture.output, file), JSON.stringify(report));
      }
      return {
        status: 0,
        signal: null,
        stdout: "Explicit synthetic subprocess result for gate integration.\n",
        stderr: "",
      };
    },
  });
}
test("production promotion path rejects malformed evidence and removes prior PASS; packaging uses the same gates", async () => {
  const mutations = {
    "empty checks": (file, report) => {
      if (file === "browser-report.json") report.checks = [];
    },
    "nested failure": (file, report) => {
      if (file === "studio-report.json") report.checks[0].status = "FAIL";
    },
    "lifecycle events from another target": (file, report) => {
      if (file === "worker-lifecycle-report.json")
        report.lifecycleCycles[0].serviceWorkerEvents[2].targetId =
          "foreign-target";
    },
    "raw mismatch hidden by PASS": (file, report) => {
      if (file === "export-parity-report.json")
        report.cases[0].samples[0].exported.matrix[0] += 1;
    },
    "empty executed matrix": (file, report) => {
      if (file === "export-parity-report.json") {
        report.cases = [];
        report.fixtureCount = 0;
      }
    },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const fixture = await integrationFixture();
    try {
      const report = await simulateRelease(fixture, mutate);
      assert.equal(report.status, "FAIL", label);
      assert.equal(report.productVerdict, "FAIL", label);
      for (const file of ["RUN_REPORT.json", "FINAL_REPORT.json"]) {
        const saved = JSON.parse(
          await readFile(join(fixture.output, file), "utf8"),
        );
        assert.equal(saved.productVerdict, "FAIL");
        assert.equal(saved.staleMarker, undefined);
      }
      await assert.rejects(
        authorizeSourcePackage({
          root: fixture.root,
          archive: fixture.archive,
          releaseVersion: "synthetic-validator-test",
        }),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});
test("production promotion clears stale evidence when a successful subprocess emits none", async () => {
  const fixture = await integrationFixture();
  try {
    await writeFile(
      join(fixture.output, "browser-report.json"),
      JSON.stringify(fixture.originals["browser-report.json"]),
    );
    const report = await simulateRelease(fixture, () => {}, {
      noop: "browser-report.json",
    });
    assert.equal(report.productVerdict, "FAIL");
    assert.match(report.evidenceError, /ENOENT/);
    await assert.rejects(
      authorizeSourcePackage({
        root: fixture.root,
        archive: fixture.archive,
        releaseVersion: "synthetic-validator-test",
      }),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
test("production packaging rechecks content and complete stages even after an earlier synthetic valid promotion", async () => {
  const fixture = await integrationFixture();
  try {
    const proof = await simulateRelease(fixture);
    assert.equal(proof.productVerdict, "PASS", proof.evidenceError);
    const options = {
      root: fixture.root,
      archive: fixture.archive,
      releaseVersion: "synthetic-validator-test",
    };
    await authorizeSourcePackage(options);
    const path = join(fixture.output, "FINAL_REPORT.json");
    for (const change of [
      (report) => (report.stages = []),
      (report) => report.stages.pop(),
      (report) => (report.stages[0].status = "SKIP"),
      (report) => (report.stages[0].exitCode = 1),
    ]) {
      const invalid = structuredClone(proof);
      change(invalid);
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(authorizeSourcePackage(options));
    }
    await writeFile(path, JSON.stringify(proof));
    const lifecyclePath = join(fixture.output, "worker-lifecycle-report.json");
    const lifecycleText = await readFile(lifecyclePath, "utf8");
    const invalidLifecycle = JSON.parse(lifecycleText);
    invalidLifecycle.lifecycleCycles[0].serviceWorkerEvents[2].targetId =
      "foreign-target";
    await writeFile(lifecyclePath, JSON.stringify(invalidLifecycle));
    await assert.rejects(
      authorizeSourcePackage(options),
      /another target|restarted target/,
    );
    await writeFile(lifecyclePath, lifecycleText);
    const evidencePath = join(fixture.output, "export-parity-report.json");
    const invalid = JSON.parse(await readFile(evidencePath, "utf8"));
    invalid.cases[0].negativeControl.status = "PASS";
    await writeFile(evidencePath, JSON.stringify(invalid));
    await assert.rejects(authorizeSourcePackage(options), /No-op control/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

const reviewedMutations = {
  "lifecycle check.error with PASS": {
    file: "worker-lifecycle-report.json",
    mutate: (report) => (report.checks[0].error = "Injected review failure"),
  },
  "lifecycle cleanupFailure with PASS": {
    file: "worker-lifecycle-report.json",
    mutate: (report) => (report.cleanupFailure = "Injected cleanup failure"),
  },
  "lifecycle forcedStops summary inflated": {
    file: "worker-lifecycle-report.json",
    mutate: (report) => (report.summary.forcedStops = 999999),
  },
  "final exportTimepoints summary inflated": {
    file: "FINAL_REPORT.json",
    mutate: (report) => (report.summary.exportTimepoints = 999999),
  },
};
for (const [name, mutation] of Object.entries(reviewedMutations))
  test(`review regression rejects ${name} in actual promotion and packaging gates`, async () => {
    const fixture = await integrationFixture();
    try {
      const proof = await simulateRelease(fixture);
      assert.equal(proof.productVerdict, "PASS", proof.evidenceError);
      const options = {
        root: fixture.root,
        archive: fixture.archive,
        releaseVersion: "synthetic-validator-test",
      };
      // Both gates first accept the unmodified observations, including intended
      // negativeControl.status=FAIL, before the independent mutations below.
      await authorizeSourcePackage(options);
      const path = join(fixture.output, mutation.file);
      const invalid = JSON.parse(await readFile(path, "utf8"));
      mutation.mutate(invalid);
      await writeFile(path, JSON.stringify(invalid));
      await assert.rejects(authorizeSourcePackage(options));
      const candidate =
        mutation.file === "FINAL_REPORT.json"
          ? invalid
          : structuredClone(proof);
      const result = await finalizeReleaseReport(candidate, {
        root: fixture.root,
        archive: fixture.archive,
        codeHashes: proof.codeHashes,
      });
      assert.equal(result.status, "FAIL");
      assert.equal(result.productVerdict, "FAIL");
      for (const file of ["RUN_REPORT.json", "FINAL_REPORT.json"])
        assert.equal(
          JSON.parse(await readFile(join(fixture.output, file), "utf8"))
            .productVerdict,
          "FAIL",
        );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
test("actual lifecycle cleanup helper marks rejected close as FAIL and nonzero exit", async () => {
  const report = { status: "PASS" },
    processState = { exitCode: 0 };
  await closeLifecycleContext(
    {
      close: async () => {
        throw Error("injected browser close failure");
      },
    },
    report,
    processState,
  );
  assert.equal(report.status, "FAIL");
  assert.match(report.cleanupFailure, /injected browser close failure/);
  assert.equal(processState.exitCode, 1);
  const success = { status: "PASS" },
    successProcess = { exitCode: 0 };
  await closeLifecycleContext(
    { close: async () => {} },
    success,
    successProcess,
  );
  assert.deepEqual(success, { status: "PASS" });
  assert.equal(successProcess.exitCode, 0);
});
