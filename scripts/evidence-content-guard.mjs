// Evidence consistency contract, not proof of independent or authentic execution.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const EVIDENCE_SCHEMA = "motionpaste-evidence-v1";
const contract = JSON.parse(
  readFileSync(new URL("./evidence-contract.json", import.meta.url), "utf8"),
);
assert.equal(contract.schemaVersion, 1, "Unknown evidence contract schema");
export const REQUIRED_STAGES = [
  "format",
  "lint",
  "typecheck",
  "unit",
  "verification-runner",
  "server",
  "coverage",
  "build",
  "extension-e2e",
  "authorization",
  "worker-lifecycle",
  "browser-guards",
  "archive-smoke",
  "studio-regressions",
  "downloaded-export-parity",
];
const limits = { opacity: 1e-5, matrix: 1e-5, rect: 0.002 };
const sha = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function finite(value, label) {
  assert.ok(
    typeof value === "number" && Number.isFinite(value),
    `${label}: finite number required`,
  );
}
function uniqueStrings(values, label) {
  assert.ok(
    Array.isArray(values) && values.length > 0,
    `${label}: nonempty array required`,
  );
  assert.ok(
    values.every((value) => typeof value === "string" && value.length > 0),
    `${label}: identifiers required`,
  );
  assert.equal(
    new Set(values).size,
    values.length,
    `${label}: duplicate identifiers`,
  );
}
function requiredIds(values, required, label) {
  uniqueStrings(values, label);
  for (const id of required)
    assert.ok(values.includes(id), `${label}: missing ${id}`);
}
export function validateRunWindow(startedAt, finishedAt) {
  const start = Date.parse(startedAt),
    finish = Date.parse(finishedAt);
  assert.ok(
    typeof startedAt === "string" && Number.isFinite(start),
    "Valid run startedAt required",
  );
  assert.ok(
    typeof finishedAt === "string" && Number.isFinite(finish),
    "Valid run finishedAt required",
  );
  assert.ok(finish >= start, "Run finishedAt precedes startedAt");
  return { start, finish };
}
export function validateStageContent(report) {
  validateRunWindow(report.startedAt, report.finishedAt);
  assert.equal(
    report.evidenceSchema,
    EVIDENCE_SCHEMA,
    "Explicit evidence schema required",
  );
  assert.ok(Array.isArray(report.stages), "stages array required");
  uniqueStrings(
    report.stages.map((stage) => stage.name),
    "stages",
  );
  assert.deepEqual(
    report.stages.map((stage) => stage.name),
    REQUIRED_STAGES,
    "Executed stages must match release plan in order",
  );
  for (const stage of report.stages) {
    assert.equal(stage.status, "PASS", `Stage ${stage.name} is not PASS`);
    assert.equal(stage.exitCode, 0, `Stage ${stage.name} exit`);
    assert.ok(
      stage.signal == null && stage.error == null,
      `Stage ${stage.name} has error/signal`,
    );
    finite(stage.durationMs, `${stage.name} durationMs`);
    assert.ok(stage.durationMs >= 0, "Stage duration must be nonnegative");
  }
}
function vector(values, length, label) {
  assert.ok(
    Array.isArray(values) && values.length === length,
    `${label}: vector length`,
  );
  values.forEach((value) => finite(value, label));
}
function errorsAt(sample) {
  assert.ok(
    sample && sample.source && sample.exported,
    "Paired raw sample required",
  );
  finite(sample.time, "sample time");
  assert.equal(sample.source.time, sample.time);
  assert.equal(sample.exported.time, sample.time);
  for (const side of [sample.source, sample.exported]) {
    finite(side.opacity, "opacity");
    assert.ok(side.opacity >= 0 && side.opacity <= 1, "Opacity out of range");
    vector(side.matrix, 6, "matrix");
    vector(side.rect, 6, "rectangle");
  }
  return {
    opacity: Math.abs(sample.source.opacity - sample.exported.opacity),
    matrix: Math.max(
      ...sample.source.matrix.map((value, index) =>
        Math.abs(value - sample.exported.matrix[index]),
      ),
    ),
    rect: Math.max(
      ...sample.source.rect.map((value, index) =>
        Math.abs(value - sample.exported.rect[index]),
      ),
    ),
  };
}
export function resolveExportFixturePlan(provider) {
  assert.equal(typeof provider, "function", "Fixture provider required");
  const fixtures = provider();
  validateExportFixturePlan(fixtures);
  return fixtures;
}
export function validateExportFixturePlan(fixtures) {
  assert.ok(Array.isArray(fixtures), "Export fixture array required");
  uniqueStrings(
    fixtures.map((fixture) => fixture.id),
    "Export fixtures",
  );
  assert.deepEqual(
    fixtures.map((fixture) => fixture.id),
    contract.exportFixtures.map((fixture) => fixture.id),
    "Export fixture identities differ from reviewed matrix",
  );
  for (const [index, fixture] of fixtures.entries())
    assert.equal(
      sha(fixture),
      contract.exportFixtures[index].fixtureSHA256,
      `Authored fixture changed: ${fixture.id}`,
    );
}
export function validateEvidenceContent(filename, report) {
  assert.equal(report.status, "PASS", `${filename}: root status`);
  for (const key of ["errors", "pageErrors"])
    if (key in report) {
      assert.ok(Array.isArray(report[key]), `${key}: array required`);
      assert.equal(report[key].length, 0, `${key}: contains failures`);
    }
  assert.ok(
    report.error == null &&
      report.failure == null &&
      report.cleanupFailure == null,
    `${filename}: failure field present`,
  );
  if (Object.hasOwn(contract.checks, filename)) {
    assert.ok(Array.isArray(report.checks), `${filename}: checks required`);
    requiredIds(
      report.checks.map((check) => check.name),
      contract.checks[filename],
      `${filename} checks`,
    );
    for (const check of report.checks) {
      assert.equal(check.status, "PASS", `${filename}: ${check.name}`);
      assert.ok(check.error == null, `${filename}: check error present`);
    }
    if (filename === "browser-report.json") {
      assert.equal(report.parityCases, 50);
      assert.equal(report.samplePoints, 1300);
      finite(report.maxAbsoluteError, "maxAbsoluteError");
      assert.ok(
        report.maxAbsoluteError >= 0 && report.maxAbsoluteError <= 0.002,
        "Internal parity error exceeds tolerance",
      );
      const parity = report.checks.find(
        (check) => check.name === "50 CSS/WAAPI parity cases × 26 sample times",
      );
      assert.equal(parity.details?.count, report.parityCases);
      assert.equal(parity.details?.samples, report.samplePoints);
      assert.equal(parity.details?.maxError, report.maxAbsoluteError);
    }
    return;
  }
  if (filename === "worker-lifecycle-report.json")
    return validateWorkerLifecycle(report);
  assert.equal(
    filename,
    "export-parity-report.json",
    "Unknown evidence file requires an explicit content contract",
  );
  assert.ok(Array.isArray(report.cases), "Export cases required");
  assert.equal(report.fixtureCount, contract.exportFixtures.length);
  validateExportFixturePlan(report.cases.map((entry) => entry.authoredFixture));
  assert.deepEqual(
    report.cases.map((entry) => entry.id),
    contract.exportFixtures.map((entry) => entry.id),
    "Executed export case identities differ from planned matrix",
  );
  for (const [key, limit] of Object.entries(limits)) {
    finite(report.tolerances?.[key], `${key} tolerance`);
    assert.ok(
      report.tolerances[key] >= 0 && report.tolerances[key] <= limit,
      "Tolerance weakened",
    );
  }
  let total = 0;
  const aggregate = { opacity: 0, matrix: 0, rect: 0 };
  for (const [index, entry] of report.cases.entries()) {
    assert.equal(entry.status, "PASS", `case ${entry.id}`);
    assert.equal(
      entry.fixtureSHA256,
      contract.exportFixtures[index].fixtureSHA256,
    );
    assert.equal(entry.comparison?.status, "PASS");
    assert.equal(entry.comparison.mismatchCount, 0);
    assert.ok(
      Array.isArray(entry.samples) && entry.samples.length > 0,
      "Raw samples required",
    );
    assert.deepEqual(
      entry.samples.map((sample) => sample.time),
      contract.exportFixtures[index].times,
      "Complete reviewed timepoint schedule required",
    );
    assert.equal(entry.comparison.timepointCount, entry.samples.length);
    const caseMax = { opacity: 0, matrix: 0, rect: 0 };
    for (const sample of entry.samples)
      for (const [key, error] of Object.entries(errorsAt(sample))) {
        assert.ok(
          error <= report.tolerances[key],
          `Observed ${key} mismatch in ${entry.id}`,
        );
        caseMax[key] = Math.max(caseMax[key], error);
        aggregate[key] = Math.max(aggregate[key], error);
      }
    for (const key of Object.keys(caseMax)) {
      finite(entry.comparison.maxAbsoluteError?.[key], "case maximum");
      assert.ok(
        Math.abs(entry.comparison.maxAbsoluteError[key] - caseMax[key]) <=
          1e-12,
        "Case maximum differs from raw samples",
      );
    }
    // Intentional no-op controls must FAIL; do not recursively reject every FAIL string.
    const negative = entry.negativeControl;
    assert.equal(negative?.status, "FAIL", "No-op control must be rejected");
    assert.equal(negative.timepointCount, entry.samples.length);
    assert.ok(
      Number.isInteger(negative.mismatchCount) &&
        negative.mismatchCount >= 10 &&
        negative.mismatchCount <= entry.samples.length,
      "Invalid negative-control mismatch count",
    );
    for (const key of Object.keys(limits)) {
      finite(negative.maxAbsoluteError?.[key], "negative-control maximum");
      assert.ok(negative.maxAbsoluteError[key] >= 0);
    }
    assert.ok(
      Object.keys(limits).some(
        (key) => negative.maxAbsoluteError[key] > report.tolerances[key],
      ),
      "No-op maximum must exceed tolerance",
    );
    assert.ok(
      Array.isArray(negative.firstMismatches) &&
        negative.firstMismatches.length === Math.min(8, negative.mismatchCount),
      "Negative-control observations required",
    );
    uniqueStrings(
      negative.firstMismatches.map((sample) => String(sample.time)),
      "negative-control timepoints",
    );
    for (const sample of negative.firstMismatches) {
      assert.ok(
        contract.exportFixtures[index].times.includes(sample.time),
        "Unknown negative-control sample time",
      );
      for (const key of Object.keys(limits)) {
        finite(sample.errors?.[key], "negative-control error");
        assert.ok(
          sample.errors[key] >= 0 &&
            sample.errors[key] <= negative.maxAbsoluteError[key],
        );
      }
      assert.ok(
        Object.keys(limits).some(
          (key) => sample.errors[key] > report.tolerances[key],
        ),
        "Listed mismatch must exceed tolerance",
      );
    }
    total += entry.samples.length;
  }
  assert.equal(report.summary?.passedCases, report.cases.length);
  assert.equal(report.summary.failedCases, 0);
  assert.equal(report.summary.pairedTimepoints, total);
  assert.equal(report.summary.rejectedNoOpControls, report.cases.length);
  for (const key of Object.keys(aggregate)) {
    finite(report.summary.maxAbsoluteError?.[key], "summary maximum");
    assert.ok(
      Math.abs(report.summary.maxAbsoluteError[key] - aggregate[key]) <= 1e-12,
      "Summary maximum differs from raw samples",
    );
  }
}
const lifecycleIds = [
  "archive-integrity",
  "pending-token-survives-restart",
  "consumed-token-rejected-after-restart",
  "cross-tab-token-rejected-after-restart",
  "navigation-token-rejected-after-restart",
  "expired-token-rejected-after-restart",
  "missing-token-rejected-and-reapproval-works",
];
function validateWorkerLifecycle(report) {
  const cycleIds = [
    "pending",
    "consumed",
    "cross-tab",
    "navigation",
    "expired",
    "missing",
  ];
  assert.ok(Array.isArray(report.checks), "Lifecycle checks required");
  requiredIds(
    report.checks.map((check) => check.id),
    lifecycleIds,
    "Lifecycle check IDs",
  );
  for (const check of report.checks) {
    assert.equal(check.status, "PASS", `Lifecycle ${check.id}`);
    assert.ok(
      check.error == null,
      `Lifecycle ${check.id}: check error present`,
    );
  }
  const details = Object.fromEntries(
    report.checks.map((check) => [check.id, check.details]),
  );
  const pending = details[lifecycleIds[1]];
  assert.equal(pending.captureCountBefore, 0);
  assert.equal(pending.captureCountAfter, 1);
  for (const key of [
    "pendingSessionRetainedWhileStopped",
    "consumedAfterRestart",
    "actualPickerClick",
  ])
    assert.equal(pending[key], true);
  for (const id of lifecycleIds.slice(2)) {
    const item = details[id];
    assert.equal(item.response?.ok, false, `Lifecycle ${id}: denial required`);
    assert.match(item.response.error, /start again|start capture again/i);
    assert.equal(item.frameId, 0);
    assert.ok(
      typeof item.documentId === "string" && item.documentId.length > 0,
    );
    assert.ok(
      Number.isInteger(item.captureCountBefore) && item.captureCountBefore >= 0,
    );
    assert.equal(
      item.captureCountAfter,
      item.captureCountBefore,
      "Denied result cannot create a capture",
    );
  }
  assert.equal(details[lifecycleIds[2]].consumedSessionStillAbsent, true);
  for (const key of [
    "differentTab",
    "differentDocument",
    "bothApprovalsPreservedAfterWrongTabAttempt",
  ])
    assert.equal(details[lifecycleIds[3]][key], true);
  assert.equal(details[lifecycleIds[4]].browserDocumentIdChanged, true);
  assert.equal(details[lifecycleIds[4]].newDocumentResultRejected, true);
  const expired = details[lifecycleIds[5]];
  assert.equal(expired.expiredTimestampInjectedByTrustedTestContext, true);
  assert.equal(expired.actualFiveMinuteWait, false);
  assert.equal(expired.expiredSessionPurged, true);
  finite(expired.injectedExpiresAt, "Injected expiry timestamp");
  const missing = details[lifecycleIds[6]];
  assert.equal(missing.reapprovalFromRealToolbar, true);
  assert.equal(missing.reapprovedTokenConsumed, true);
  assert.equal(missing.reapprovedCaptureCount, missing.captureCountAfter + 1);

  assert.equal(report.method?.debuggerAttached, true);
  assert.equal(report.method.naturalIdleTermination, false);
  assert.equal(report.method.wholeBrowserRestart, false);
  const { start, finish } = validateRunWindow(
    report.measuredAt,
    report.finishedAt,
  );
  assert.ok(
    Array.isArray(report.lifecycleCycles),
    "Actual lifecycle observations required",
  );
  assert.deepEqual(
    report.lifecycleCycles.map((cycle) => cycle.id),
    cycleIds,
    "Lifecycle scenario identities required",
  );
  for (const [index, cycle] of report.lifecycleCycles.entries()) {
    assert.equal(
      report.checks.find((check) => check.id === lifecycleIds[index + 1])
        ?.details?.cycleId,
      cycle.id,
    );
    assert.equal(cycle.status, "PASS");
    assert.ok(
      cycle.error == null && cycle.failure == null,
      "Lifecycle cycle error present",
    );
    assert.ok(
      typeof cycle.oldTargetId === "string" && cycle.oldTargetId.length > 0,
    );
    assert.ok(
      typeof cycle.newTargetId === "string" && cycle.newTargetId.length > 0,
    );
    // Chromium may reuse the target ID and Playwright Worker wrapper after an actual restart.
    assert.equal(cycle.targetAbsentAfterStop, true);
    assert.equal(cycle.newGlobalMarkerAbsent, true);
    assert.equal(cycle.storageRetainedExactly, true);
    const digest = cycle.storageBeforeStop?.exactStorageSHA256;
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(cycle.storageAfterStop?.exactStorageSHA256, digest);
    assert.deepEqual(cycle.storageAfterStop, cycle.storageBeforeStop);
    assert.match(
      cycle.storageAfterRestart?.exactStorageSHA256,
      /^[a-f0-9]{64}$/,
    );
    const requested = Date.parse(cycle.requestedAt),
      stopped = Date.parse(cycle.stoppedAt),
      restarted = Date.parse(cycle.restartedAt);
    assert.ok(
      start <= requested &&
        requested <= stopped &&
        stopped <= restarted &&
        restarted <= finish,
      "Lifecycle timestamps out of order",
    );
    assert.ok(
      typeof cycle.versionId === "string" && cycle.versionId.length > 0,
    );
    assert.ok(
      Array.isArray(cycle.serviceWorkerEvents),
      "Browser lifecycle events required",
    );
    const events = cycle.serviceWorkerEvents.filter(
      (event) => event.versionId === cycle.versionId,
    );
    // Event collection continues during sentinel/storage checks after restartedAt.
    // Bound trailing notifications to this cycle while checking the required
    // stop/start/run witnesses against their actual observation milestones.
    const cycleEnd =
      index + 1 < report.lifecycleCycles.length
        ? Date.parse(report.lifecycleCycles[index + 1].requestedAt)
        : finish;
    assert.ok(
      restarted <= cycleEnd && cycleEnd <= finish,
      "Lifecycle cycles overlap or exceed report window",
    );
    let previous = requested;
    for (const event of events) {
      const at = Date.parse(event.observedAt);
      assert.ok(
        Number.isFinite(at) && previous <= at && at <= cycleEnd,
        "Lifecycle event timestamp out of order",
      );
      previous = at;
      if (event.targetId != null) {
        const target = ["starting", "running"].includes(event.runningStatus)
          ? cycle.newTargetId
          : cycle.oldTargetId;
        assert.equal(
          event.targetId,
          target,
          "Lifecycle event belongs to another target",
        );
      }
    }
    const stopIndex = events.findIndex(
      (event) => event.runningStatus === "stopped",
    );
    const startingIndex = events.findIndex(
      (event, i) => i > stopIndex && event.runningStatus === "starting",
    );
    const runningIndex = events.findIndex(
      (event, i) => i > startingIndex && event.runningStatus === "running",
    );
    assert.ok(
      stopIndex >= 0 &&
        startingIndex > stopIndex &&
        runningIndex > startingIndex,
      "Actual stopped → starting → running observations required",
    );
    const stopTime = Date.parse(events[stopIndex].observedAt);
    const startingTime = Date.parse(events[startingIndex].observedAt);
    const runningTime = Date.parse(events[runningIndex].observedAt);
    assert.ok(
      requested <= stopTime && stopTime <= stopped,
      "Stopped witness must follow the request and precede stoppedAt",
    );
    assert.ok(
      stopped <= startingTime &&
        startingTime <= runningTime &&
        runningTime <= restarted,
      "Restart witnesses must follow stoppedAt and precede restartedAt",
    );
    assert.equal(
      events[runningIndex].targetId,
      cycle.newTargetId,
      "Running witness must identify the restarted target",
    );
  }
  assert.deepEqual(
    report.summary,
    deriveLifecycleSummary(report),
    "Lifecycle summary differs from validated scenarios",
  );
}

export function deriveLifecycleSummary(report) {
  return {
    checks: report.checks.length,
    forcedStops: report.lifecycleCycles.length,
    confirmedRestarts: report.lifecycleCycles.filter(
      (cycle) => cycle.status === "PASS",
    ).length,
    actualPickerCaptures:
      report.checks.filter((check) => check.details?.actualPickerClick === true)
        .length +
      report.checks.filter(
        (check) => check.details?.reapprovalFromRealToolbar === true,
      ).length,
    rejectedCapturesAfterRestart: report.checks.filter(
      (check) => check.details?.response?.ok === false,
    ).length,
  };
}
