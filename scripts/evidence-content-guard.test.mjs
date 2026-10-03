import test from "node:test";
import assert from "node:assert/strict";
import {
  evidenceFixtures,
  syntheticLifecycleFixture,
} from "../tests/fixtures/evidence-fixtures.mjs";
import {
  validateEvidenceContent,
  validateStageContent,
  resolveExportFixturePlan,
  EVIDENCE_SCHEMA,
  REQUIRED_STAGES,
} from "./evidence-content-guard.mjs";
const reports = await evidenceFixtures();
const final = {
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
};
for (const [file, report] of Object.entries(reports))
  test(`public historical evidence fixture accepted: ${file}`, () =>
    validateEvidenceContent(file, report));
test("explicit beta.3 stage contract accepted", () =>
  validateStageContent(final));
for (const file of Object.keys(reports).filter(
  (file) => file !== "export-parity-report.json",
)) {
  for (const [name, mutate] of Object.entries({
    "empty checks": (report) => (report.checks = []),
    "nested FAIL": (report) => (report.checks[0].status = "FAIL"),
    "replacement of required check": (report) =>
      (report.checks[0].name = "unreviewed replacement"),
    "duplicate checks": (report) =>
      (report.checks[1].name = report.checks[0].name),
  }))
    test(`${name} rejected: ${file}`, () => {
      const report = structuredClone(reports[file]);
      mutate(report);
      assert.throws(() => validateEvidenceContent(file, report));
    });
}
const file = "export-parity-report.json";
const mutations = {
  "empty fixture set": (report) => {
    report.cases = [];
    report.fixtureCount = 0;
    report.summary.passedCases = 0;
    report.summary.failedCases = 0;
    report.summary.rejectedNoOpControls = 0;
  },
  "nested case FAIL": (report) => (report.cases[0].status = "FAIL"),
  "duplicate cases": (report) => (report.cases[1].id = report.cases[0].id),
  "changed fixture despite same ID": (report) =>
    (report.cases[0].authoredFixture.timing.duration = 1),
  "replacement fixture identity": (report) =>
    (report.cases[0].id = "replacement"),
  "missing raw samples": (report) => (report.cases[0].samples = []),
  "dropped sample with corrected totals": (report) => {
    report.cases[0].samples.pop();
    report.cases[0].comparison.timepointCount--;
    report.summary.pairedTimepoints--;
  },
  "duplicated sample at constant count": (report) =>
    (report.cases[0].samples[1] = report.cases[0].samples[0]),
  "raw opacity mismatch despite PASS": (report) =>
    (report.cases[0].samples[0].exported.opacity += 0.3),
  "raw matrix mismatch despite PASS": (report) =>
    (report.cases[0].samples[0].exported.matrix[0] += 0.3),
  "raw rectangle mismatch despite PASS": (report) =>
    (report.cases[0].samples[0].exported.rect[0] += 4),
  "JSON NaN becomes null": (report) =>
    (report.cases[0].samples[0].exported.opacity = JSON.parse(
      JSON.stringify(NaN),
    )),
  "JSON Infinity becomes null": (report) =>
    (report.cases[0].samples[0].exported.matrix[0] = JSON.parse(
      JSON.stringify(Infinity),
    )),
  "no-op falsely PASS": (report) =>
    (report.cases[0].negativeControl.status = "PASS"),
  "no-op lacks observations": (report) =>
    (report.cases[0].negativeControl.firstMismatches = []),
  "no-op impossible count": (report) =>
    (report.cases[0].negativeControl.mismatchCount = 99999),
  "wrong summary": (report) => report.summary.pairedTimepoints++,
  "wrong case maximum": (report) =>
    (report.cases[0].comparison.maxAbsoluteError.opacity = 0.000001),
  "wrong aggregate maximum": (report) =>
    (report.summary.maxAbsoluteError.matrix = 0.000001),
  "inflated tolerance": (report) => (report.tolerances.rect = 100),
  "hidden page errors": (report) => report.pageErrors.push("runtime failure"),
};
for (const [name, mutate] of Object.entries(mutations))
  test(name, () => {
    const report = structuredClone(reports[file]);
    mutate(report);
    assert.throws(() => validateEvidenceContent(file, report));
  });
for (const [name, mutate] of Object.entries({
  "empty stages": (report) => (report.stages = []),
  "missing stage": (report) => report.stages.pop(),
  "duplicate stage": (report) =>
    (report.stages[1].name = report.stages[0].name),
  "skipped stage": (report) => (report.stages[0].status = "SKIP"),
  "blocked stage": (report) => (report.stages[0].status = "BLOCKED"),
  "nonzero exit": (report) => (report.stages[0].exitCode = 1),
  "signal despite exit0": (report) => (report.stages[0].signal = "SIGTERM"),
  "error despite exit0": (report) => (report.stages[0].error = "failed"),
  "negative duration": (report) => (report.stages[0].durationMs = -1),
  "invalid start": (report) => (report.startedAt = "invalid"),
  "invalid finish": (report) => (report.finishedAt = "invalid"),
  "inverted window": (report) => (report.finishedAt = "2026-10-02T00:00:00Z"),
  "missing schema": (report) => delete report.evidenceSchema,
}))
  test(name, () => {
    const report = structuredClone(final);
    mutate(report);
    assert.throws(() => validateStageContent(report));
  });
test("actual export matrix provider rejects empty or duplicate fixtures before browser setup", () => {
  const fixtures = reports[file].cases.map((entry) => entry.authoredFixture);
  assert.deepEqual(
    resolveExportFixturePlan(() => fixtures),
    fixtures,
  );
  assert.throws(() => resolveExportFixturePlan(() => []));
  assert.throws(() =>
    resolveExportFixturePlan(() => [fixtures[0], fixtures[0]]),
  );
});
test("unknown evidence requires an explicit content contract", () =>
  assert.throws(() =>
    validateEvidenceContent("unknown.json", { status: "PASS" }),
  ));
test("internal parity maxima and counts match summary", () => {
  for (const mutate of [
    (report) => (report.maxAbsoluteError = 99),
    (report) => (report.samplePoints = 1299),
    (report) =>
      delete report.checks.find((check) =>
        check.name.startsWith("50 CSS/WAAPI"),
      ).details,
  ]) {
    const report = structuredClone(reports["browser-report.json"]);
    mutate(report);
    assert.throws(() => validateEvidenceContent("browser-report.json", report));
  }
});

for (const [name, change] of Object.entries({
  "missing lifecycle scenario": (report) => report.lifecycleCycles.pop(),
  "empty lifecycle events": (report) =>
    (report.lifecycleCycles[0].serviceWorkerEvents = []),
  "target never disappeared": (report) =>
    (report.lifecycleCycles[0].targetAbsentAfterStop = false),
  "globals retained": (report) =>
    (report.lifecycleCycles[0].newGlobalMarkerAbsent = false),
  "storage changed while stopped": (report) =>
    (report.lifecycleCycles[0].storageAfterStop = {
      ...report.lifecycleCycles[0].storageAfterStop,
      exactStorageSHA256: "1".repeat(64),
    }),
  "no stopped state": (report) =>
    report.lifecycleCycles[0].serviceWorkerEvents.shift(),
  "wrong event identity": (report) =>
    (report.lifecycleCycles[0].serviceWorkerEvents[0].versionId = "other"),
  "denied token accepted": (report) =>
    (report.checks[2].details.response.ok = true),
  "capture created on denial": (report) =>
    report.checks[2].details.captureCountAfter++,
  "natural idle claim": (report) =>
    (report.method.naturalIdleTermination = true),
}))
  test(name, () => {
    const report = syntheticLifecycleFixture();
    change(report);
    assert.throws(() =>
      validateEvidenceContent("worker-lifecycle-report.json", report),
    );
  });
test("synthetic stopped-starting-running metadata permits Chromium reused target ID", () =>
  validateEvidenceContent(
    "worker-lifecycle-report.json",
    syntheticLifecycleFixture(),
  ));

function lifecycleWithDistinctCycleTimes() {
  const report = syntheticLifecycleFixture();
  const start = Date.parse(report.measuredAt);
  const at = (offset) => new Date(start + offset).toISOString();
  report.finishedAt = at(70);
  for (const [index, cycle] of report.lifecycleCycles.entries()) {
    cycle.requestedAt = at(index * 10 + 1);
    cycle.stoppedAt = at(index * 10 + 3);
    cycle.restartedAt = at(index * 10 + 6);
    for (const [i, event] of cycle.serviceWorkerEvents.entries())
      event.observedAt = at(index * 10 + [2, 4, 5][i]);
  }
  return report;
}
test("causal lifecycle windows accept a trailing duplicate running notification", () => {
  const report = lifecycleWithDistinctCycleTimes();
  const cycle = report.lifecycleCycles[0];
  cycle.serviceWorkerEvents.push({
    ...cycle.serviceWorkerEvents[2],
    observedAt: new Date(Date.parse(cycle.restartedAt) + 1).toISOString(),
  });
  validateEvidenceContent("worker-lifecycle-report.json", report);
});
for (const [name, mutate] of Object.entries({
  "reused prior-cycle lifecycle events": (report) => {
    report.lifecycleCycles[1].serviceWorkerEvents = structuredClone(
      report.lifecycleCycles[0].serviceWorkerEvents,
    );
  },
  "lifecycle events before their request": (report) => {
    for (const cycle of report.lifecycleCycles)
      for (const event of cycle.serviceWorkerEvents)
        event.observedAt = report.measuredAt;
  },
  "stopped witness after stop milestone": (report) =>
    (report.lifecycleCycles[0].serviceWorkerEvents[0].observedAt =
      report.lifecycleCycles[0].serviceWorkerEvents[1].observedAt),
  "starting witness before stopped milestone": (report) =>
    (report.lifecycleCycles[0].serviceWorkerEvents[1].observedAt =
      report.lifecycleCycles[0].serviceWorkerEvents[0].observedAt),
  "running witness after restart milestone": (report) =>
    (report.lifecycleCycles[0].serviceWorkerEvents[2].observedAt = new Date(
      Date.parse(report.lifecycleCycles[0].restartedAt) + 1,
    ).toISOString()),
  "running witness from another target": (report) =>
    (report.lifecycleCycles[0].serviceWorkerEvents[2].targetId =
      "foreign-target"),
  "running witness without target identity": (report) =>
    delete report.lifecycleCycles[0].serviceWorkerEvents[2].targetId,
}))
  test(name, () => {
    const report = lifecycleWithDistinctCycleTimes();
    mutate(report);
    assert.throws(() =>
      validateEvidenceContent("worker-lifecycle-report.json", report),
    );
  });

test("lifecycle PASS cannot hide a check error or cleanup failure", () => {
  for (const change of [
    (report) => (report.checks[0].error = "hidden failure"),
    (report) => (report.cleanupFailure = "close rejected"),
  ]) {
    const report = syntheticLifecycleFixture();
    change(report);
    assert.throws(() =>
      validateEvidenceContent("worker-lifecycle-report.json", report),
    );
  }
});
test("every lifecycle summary count is derived from validated observations", () => {
  const baseline = syntheticLifecycleFixture();
  validateEvidenceContent("worker-lifecycle-report.json", baseline);
  for (const key of Object.keys(baseline.summary)) {
    const report = structuredClone(baseline);
    report.summary[key] = 999999;
    assert.throws(() =>
      validateEvidenceContent("worker-lifecycle-report.json", report),
    );
  }
  const missing = structuredClone(baseline);
  delete missing.summary;
  assert.throws(() =>
    validateEvidenceContent("worker-lifecycle-report.json", missing),
  );
});
