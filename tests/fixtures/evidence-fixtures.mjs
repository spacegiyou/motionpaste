// Historical beta.2 reports are test data, never new product evidence.
// The two archive paths were made relative for publication; other values are unchanged.
// These digests pin the public fixtures, not the private original report bytes.
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hashes = {
  "browser-report.json":
    "49d48faef8609970266fb7f74f49fe78e382900a68577c1b9ebd88944d9025a0",
  "authorization-report.json":
    "8819ac245a90c4c27073271c91c4b3f706cc2ed2ed0266f78b60efa0ca705421",
  "browser-negative-report.json":
    "647a443dec2dcb1b9fe78e013f07d79f771ff7857d56fae08b30792e685be698",
  "independent-report.json":
    "704b3930ddecd393b9627a589d1fe614c2b1c30ffe259b3a6fc4519db69040d2",
  "studio-report.json":
    "a083d5e60c2cd318521c33044268839bbada7ab97402f37bb156b05e3fbb15c4",
  "export-parity-report.json":
    "279d8a10429af829e511a8052b216dc3803031cabe26e6e2ebc2e05157a0223f",
};
export async function evidenceFixtures() {
  const base = new URL("./beta2-evidence/", import.meta.url);
  const reports = {};
  for (const [file, hash] of Object.entries(hashes)) {
    const bytes = await readFile(new URL(file, base));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      hash,
      "Public historical evidence fixture changed: " + file,
    );
    reports[file] = JSON.parse(bytes);
  }
  // Explicit synthetic metadata extension models beta.3's new UI check, not an execution claim.
  reports["studio-report.json"].checks.push({
    name: "apply conflicts show target stage and preserve the imported recipe",
    status: "PASS",
  });
  return reports;
}

// Fabricated lifecycle metadata for validator/runner unit integration only. Never product/browser evidence.
export function syntheticLifecycleFixture(at = "2026-10-03T00:00:00.000Z") {
  const ids = [
    "pending",
    "consumed",
    "cross-tab",
    "navigation",
    "expired",
    "missing",
  ];
  const checks = [
    "pending-token-survives-restart",
    "consumed-token-rejected-after-restart",
    "cross-tab-token-rejected-after-restart",
    "navigation-token-rejected-after-restart",
    "expired-token-rejected-after-restart",
    "missing-token-rejected-and-reapproval-works",
  ];
  const storage = {
    keys: [],
    captureSessions: [],
    captures: [],
    exactStorageSHA256: "0".repeat(64),
  };
  const outcomes = [
    {
      captureCountBefore: 0,
      captureCountAfter: 1,
      pendingSessionRetainedWhileStopped: true,
      consumedAfterRestart: true,
      actualPickerClick: true,
    },
    { consumedSessionStillAbsent: true },
    {
      differentTab: true,
      differentDocument: true,
      bothApprovalsPreservedAfterWrongTabAttempt: true,
    },
    { browserDocumentIdChanged: true, newDocumentResultRejected: true },
    {
      expiredTimestampInjectedByTrustedTestContext: true,
      actualFiveMinuteWait: false,
      expiredSessionPurged: true,
      injectedExpiresAt: 0,
    },
    {
      reapprovalFromRealToolbar: true,
      reapprovedTokenConsumed: true,
      reapprovedCaptureCount: 2,
    },
  ];
  return {
    status: "PASS",
    measuredAt: at,
    finishedAt: at,
    summary: {
      checks: 7,
      forcedStops: 6,
      confirmedRestarts: 6,
      actualPickerCaptures: 2,
      rejectedCapturesAfterRestart: 5,
    },
    method: {
      debuggerAttached: true,
      naturalIdleTermination: false,
      wholeBrowserRestart: false,
    },
    checks: [
      { id: "archive-integrity", status: "PASS" },
      ...checks.map((id, index) => ({
        id,
        status: "PASS",
        details: {
          cycleId: ids[index],
          ...(index > 0
            ? {
                response: {
                  ok: false,
                  error: "Click MotionPaste to start again",
                },
                frameId: 0,
                documentId: "synthetic-document",
                captureCountBefore: 1,
                captureCountAfter: 1,
              }
            : {}),
          ...outcomes[index],
        },
      })),
    ],
    lifecycleCycles: ids.map((id) => ({
      id,
      status: "PASS",
      oldTargetId: "synthetic-reused-target",
      newTargetId: "synthetic-reused-target",
      versionId: "synthetic-version",
      targetAbsentAfterStop: true,
      newGlobalMarkerAbsent: true,
      storageRetainedExactly: true,
      storageBeforeStop: storage,
      storageAfterStop: storage,
      storageAfterRestart: storage,
      requestedAt: at,
      stoppedAt: at,
      restartedAt: at,
      serviceWorkerEvents: ["stopped", "starting", "running"].map(
        (runningStatus) => ({
          runningStatus,
          versionId: "synthetic-version",
          observedAt: at,
          targetId:
            runningStatus === "stopped" ? null : "synthetic-reused-target",
        }),
      ),
    })),
  };
}
