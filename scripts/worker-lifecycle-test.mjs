import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { openPicker } from "./browser-helpers.mjs";
import { archivePath, version } from "./release-info.mjs";
import { createServer } from "./serve.mjs";
import { deriveLifecycleSummary } from "./evidence-content-guard.mjs";

// Exported for an isolated failure-injection regression. The real run uses this
// same cleanup path before persisting its final result.
export async function closeLifecycleContext(
  context,
  report,
  processState = process,
) {
  if (!context) return;
  try {
    await context.close();
  } catch (error) {
    report.cleanupFailure = String(error?.stack || error);
    report.status = "FAIL";
    processState.exitCode = 1;
  }
}

export async function runWorkerLifecycle() {
  const output = resolve("artifacts/verification/worker-lifecycle-report.json");
  const report = {
    measuredAt: new Date().toISOString(),
    version,
    status: "RUNNING",
    scope:
      "Actual release ZIP in a fresh local Chromium profile. Real toolbar authorization, forced service-worker stop, and browser-generated content-script sender identities.",
    method: {
      termination: "CDP ServiceWorker.stopWorker with the observed versionId",
      stopEvidence:
        "ServiceWorker.workerVersionUpdated runningStatus=stopped and worker absent from Target.getTargets",
      restartEvidence:
        "Content-script message causes starting/running, worker target returns, and a worker-global sentinel disappears",
      debuggerAttached: true,
      debuggerDetails:
        "Playwright attaches to Chromium worker/page targets; page CDP observes ServiceWorker events and browser CDP observes targets. A normal Studio extension tab reads trusted storage. No manual DevTools UI is open.",
      naturalIdleTermination: false,
      wholeBrowserRestart: false,
      storageBoundary:
        "chrome.storage.session retained within the same browser session",
      expiryMethod:
        "Trusted test context injects one expired expiresAt before a real stop/restart; no five-minute wall-clock expiry claim",
    },
    checks: [],
    lifecycleCycles: [],
    notRun: [
      "Natural idle termination with all debuggers detached",
      "Five-minute wall-clock TTL wait",
      "Full browser restart (a different storage.session lifetime boundary)",
      "Public websites, other Chromium versions, and non-Chromium browsers",
    ],
  };
  class LifecycleUnavailable extends Error {}
  let context, server, temp;
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const waitUntil = async (operation, description, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await operation();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Error(`Timed out: ${description}`);
  };
  const check = async (id, name, operation) => {
    try {
      const details = await operation();
      report.checks.push({ id, name, status: "PASS", details });
      console.log(`PASS ${id}`);
    } catch (error) {
      report.checks.push({
        id,
        name,
        status: error instanceof LifecycleUnavailable ? "BLOCKED" : "FAIL",
        error: String(error.stack || error),
      });
      throw error;
    }
  };
  const storageSummary = (stored) => ({
    keys: Object.keys(stored).sort(),
    captureSessions: (stored.captureSessions || []).map((item) => ({
      tabId: item.tabId,
      documentId: item.documentId,
      tokenSHA256: hash(item.token),
      expiresAt: item.expiresAt,
    })),
    captures: (stored.captures || []).map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      recipeSHA256: hash(JSON.stringify(item.recipe)),
    })),
    exactStorageSHA256: hash(JSON.stringify(stored)),
  });

  try {
    await mkdir(resolve("artifacts/verification"), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    report.archiveSHA256 = hash(await readFile(archivePath));
    temp = await mkdtemp(join(tmpdir(), "motionpaste-worker-lifecycle-"));
    const unpacked = join(temp, "extension");
    await mkdir(unpacked);
    execFileSync("unzip", ["-q", archivePath, "-d", unpacked]);
    await check(
      "archive-integrity",
      "Actual archive hashes and minimal permissions",
      async () => {
        const sums = JSON.parse(
          await readFile(join(unpacked, "SHA256SUMS.json"), "utf8"),
        );
        assert.ok(Object.keys(sums).length > 0);
        for (const [file, expected] of Object.entries(sums))
          assert.equal(hash(await readFile(join(unpacked, file))), expected);
        const manifest = JSON.parse(
          await readFile(join(unpacked, "manifest.json"), "utf8"),
        );
        assert.deepEqual([...manifest.permissions].sort(), [
          "activeTab",
          "scripting",
          "storage",
        ]);
        assert.equal(manifest.host_permissions, undefined);
        assert.equal(manifest.externally_connectable, undefined);
        assert.equal(manifest.version_name, version);
        report.manifestVersion = manifest.version;
        report.manifestVersionName = manifest.version_name;
        return {
          verifiedMembers: Object.keys(sums).length,
          permissions: manifest.permissions,
        };
      },
    );

    server = await createServer(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(join(temp, "profile"), {
      channel: "chromium",
      headless: true,
      viewport: { width: 1440, height: 1000 },
      args: [`--load-extension=${unpacked}`],
      ignoreDefaultArgs: ["--disable-extensions"],
    });
    report.browser = context.browser().version();
    report.node = process.version;
    report.platform = process.platform;
    report.playwright = JSON.parse(
      await readFile("node_modules/playwright/package.json", "utf8"),
    ).version;
    let worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const source = await context.newPage();
    await source.goto(`${base}/fixtures/source-app/?lifecycle=source`);
    const observer = await context.newPage();
    // This ordinary extension page reads storage without waking the worker.
    // Every BEGIN still comes from the real toolbar popup via openPicker.
    await observer.goto(`chrome-extension://${extensionId}/studio.html`);
    const pageCDP = await context.newCDPSession(source);
    const browserCDP = await context.browser().newBrowserCDPSession();
    const events = [];
    const workerVersions = new Map();
    pageCDP.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      for (const item of versions) {
        if (item.scriptURL !== `chrome-extension://${extensionId}/worker.js`)
          continue;
        const observation = {
          observedAt: new Date().toISOString(),
          versionId: item.versionId,
          registrationId: item.registrationId,
          runningStatus: item.runningStatus,
          status: item.status,
          targetId: item.targetId || null,
        };
        workerVersions.set(item.versionId, observation);
        events.push(observation);
      }
    });
    await pageCDP.send("ServiceWorker.enable");
    const readStorage = () =>
      observer.evaluate(() => chrome.storage.session.get(null));
    const sessions = async () => (await readStorage()).captureSessions || [];
    const sessionFor = async (tabId) =>
      (await sessions()).find((item) => item.tabId === tabId);
    const captureCount = async () =>
      ((await readStorage()).captures || []).length;
    const tabFor = (page) =>
      observer.evaluate(
        async (url) =>
          (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
        page.url(),
      );
    const sendFromPage = (tabId, message) =>
      observer.evaluate(
        async ({ tabId, message }) => {
          const [result] = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: "ISOLATED",
            func: (payload) => chrome.runtime.sendMessage(payload),
            args: [message],
          });
          return {
            response: result.result,
            documentId: result.documentId,
            frameId: result.frameId,
          };
        },
        { tabId, message },
      );
    const extensionTargets = async () =>
      (await browserCDP.send("Target.getTargets")).targetInfos.filter(
        (item) =>
          item.type === "service_worker" &&
          item.url === `chrome-extension://${extensionId}/worker.js`,
      );
    const stopAndRestart = async (id, restartTrigger, trigger) => {
      const current = await waitUntil(
        () =>
          [...workerVersions.values()].find(
            (item) => item.runningStatus === "running" && item.targetId,
          ),
        "worker running before termination",
      );
      worker =
        context
          .serviceWorkers()
          .find(
            (item) =>
              item.url() === `chrome-extension://${extensionId}/worker.js`,
          ) || worker;
      const marker = randomUUID();
      await worker.evaluate((value) => {
        globalThis.__motionPasteLifecycleSentinel = value;
      }, marker);
      assert.equal(
        await worker.evaluate(() => globalThis.__motionPasteLifecycleSentinel),
        marker,
      );
      const before = await readStorage();
      const cycle = {
        id,
        restartTrigger,
        status: "RUNNING",
        requestedAt: new Date().toISOString(),
        versionId: current.versionId,
        oldTargetId: current.targetId,
        debuggerAttached: true,
        storageBeforeStop: storageSummary(before),
      };
      report.lifecycleCycles.push(cycle);
      const eventStart = events.length;
      try {
        await pageCDP.send("ServiceWorker.stopWorker", {
          versionId: current.versionId,
        });
        await waitUntil(
          () =>
            workerVersions.get(current.versionId)?.runningStatus === "stopped",
          "real Chrome worker stopped",
        );
      } catch (error) {
        throw new LifecycleUnavailable(
          `Unable to observe actual Chrome service worker termination: ${error.message}`,
        );
      }
      cycle.stoppedAt = new Date().toISOString();
      const stoppedTargets = await extensionTargets();
      assert.equal(
        stoppedTargets.length,
        0,
        "Stopped worker is absent from Chrome's live targets",
      );
      cycle.targetAbsentAfterStop = true;
      const stoppedStorage = await readStorage();
      assert.deepEqual(
        stoppedStorage,
        before,
        "Stopping the worker retains exact session storage",
      );
      cycle.storageAfterStop = storageSummary(stoppedStorage);
      cycle.storageRetainedExactly = true;
      assert.equal(
        (await extensionTargets()).length,
        0,
        "Storage observation did not wake the worker",
      );
      const result = await trigger();
      const running = await waitUntil(
        () =>
          workerVersions.get(current.versionId)?.runningStatus === "running" &&
          workerVersions.get(current.versionId),
        "message-driven worker restart",
      );
      cycle.restartedAt = new Date().toISOString();
      const targets = await extensionTargets();
      assert.equal(targets.length, 1);
      cycle.newTargetId = targets[0].targetId;
      cycle.targetIdReused = cycle.oldTargetId === cycle.newTargetId;
      assert.equal(running.targetId, cycle.newTargetId);
      worker =
        context
          .serviceWorkers()
          .find(
            (item) =>
              item.url() === `chrome-extension://${extensionId}/worker.js`,
          ) || worker;
      const markerAfter = await worker.evaluate(
        () => globalThis.__motionPasteLifecycleSentinel ?? null,
      );
      assert.equal(
        markerAfter,
        null,
        "Worker execution globals must be recreated",
      );
      cycle.newGlobalMarkerAbsent = true;
      cycle.storageAfterRestart = storageSummary(await readStorage());
      cycle.serviceWorkerEvents = events.slice(eventStart);
      assert.ok(
        cycle.serviceWorkerEvents.some(
          (item) => item.runningStatus === "stopped",
        ),
      );
      assert.ok(
        cycle.serviceWorkerEvents.some(
          (item) => item.runningStatus === "starting",
        ),
      );
      assert.ok(
        cycle.serviceWorkerEvents.some(
          (item) => item.runningStatus === "running",
        ),
      );
      cycle.status = "PASS";
      return { cycle, result };
    };
    let sourceTab;
    const start = async (page, tabId) => {
      const old = await sessionFor(tabId);
      await openPicker(context, page, extensionId);
      tabId ??= await tabFor(page);
      assert.equal(typeof tabId, "number");
      return waitUntil(async () => {
        const fresh = await sessionFor(tabId);
        return fresh && fresh.token !== old?.token ? fresh : false;
      }, "new persisted toolbar authorization");
    };
    const realCapture = async () => {
      const newPage = context.waitForEvent("page", {
        predicate: (page) => page.url().includes("/studio.html?id="),
      });
      await source.locator("#source-card").click();
      const studio = await newPage;
      await studio.waitForFunction(() =>
        document
          .querySelector("#recipe-state")
          ?.textContent?.toLowerCase()
          .includes("captured"),
      );
      await source
        .locator("#motionpaste-picker")
        .waitFor({ state: "detached" });
      await studio.close();
    };
    let originalSession, capturedRecipe;
    await check(
      "pending-token-survives-restart",
      "Unconsumed approval survives real termination and an actual picker capture succeeds once",
      async () => {
        originalSession = await start(source, sourceTab);
        sourceTab = originalSession.tabId;
        assert.ok(originalSession.expiresAt > Date.now());
        const { cycle } = await stopAndRestart(
          "pending",
          "Actual click on the source fixture's animated card",
          realCapture,
        );
        assert.equal(await captureCount(), 1);
        assert.equal(await sessionFor(sourceTab), undefined);
        const stored = await readStorage();
        capturedRecipe = stored.captures[0].recipe;
        assert.equal(capturedRecipe.timing.duration, 1300);
        return {
          cycleId: cycle.id,
          captureCountBefore: 0,
          captureCountAfter: 1,
          pendingSessionRetainedWhileStopped:
            cycle.storageAfterStop.captureSessions.length === 1,
          consumedAfterRestart: true,
          actualPickerClick: true,
        };
      },
    );
    const denied = async (tabId, token) => {
      const before = await captureCount();
      const result = await sendFromPage(tabId, {
        type: "MOTIONPASTE_CAPTURE",
        token,
        recipe: capturedRecipe,
      });
      assert.equal(result.response.ok, false);
      assert.match(result.response.error, /start again|start capture again/i);
      assert.equal(await captureCount(), before);
      assert.equal(result.frameId, 0);
      assert.ok(result.documentId);
      return {
        ...result,
        captureCountBefore: before,
        captureCountAfter: before,
      };
    };
    await check(
      "consumed-token-rejected-after-restart",
      "Consumed approval remains unusable after another real worker restart",
      async () => {
        const { cycle, result } = await stopAndRestart(
          "consumed",
          "Content-script replay of the consumed token",
          () => denied(sourceTab, originalSession.token),
        );
        assert.equal(result.documentId, originalSession.documentId);
        return {
          cycleId: cycle.id,
          ...result,
          consumedSessionStillAbsent:
            (await sessionFor(sourceTab)) === undefined,
        };
      },
    );
    await check(
      "cross-tab-token-rejected-after-restart",
      "Another authorized tab cannot spend the original tab's approval after restart",
      async () => {
        const first = await start(source, sourceTab);
        const second = await context.newPage();
        await second.goto(`${base}/fixtures/source-app/?lifecycle=second`);
        const secondSession = await start(second);
        const secondTab = secondSession.tabId;
        assert.notEqual(first.documentId, secondSession.documentId);
        const { cycle, result } = await stopAndRestart(
          "cross-tab",
          "Actual isolated content script in a different authorized tab",
          () => denied(secondTab, first.token),
        );
        assert.equal(result.documentId, secondSession.documentId);
        assert.equal((await sessionFor(sourceTab)).token, first.token);
        assert.equal((await sessionFor(secondTab)).token, secondSession.token);
        await second.keyboard.press("Escape");
        await second
          .locator("#motionpaste-picker")
          .waitFor({ state: "detached" });
        await second.close();
        return {
          cycleId: cycle.id,
          ...result,
          differentTab: first.tabId !== secondSession.tabId,
          differentDocument: first.documentId !== result.documentId,
          bothApprovalsPreservedAfterWrongTabAttempt: true,
        };
      },
    );
    await check(
      "navigation-token-rejected-after-restart",
      "Navigation while stopped invalidates a late result from the old document",
      async () => {
        const old = await sessionFor(sourceTab);
        assert.ok(old);
        const { cycle, result } = await stopAndRestart(
          "navigation",
          "Navigation pagehide cancellation may wake the worker; then the new document sends the old token",
          async () => {
            await source.goto(
              `${base}/fixtures/source-app/?lifecycle=after-navigation`,
            );
            return denied(sourceTab, old.token);
          },
        );
        assert.notEqual(result.documentId, old.documentId);
        const retained = await sessionFor(sourceTab);
        // pagehide cancellation is best effort while a worker is stopped. A stale
        // record may remain until TTL/reapproval but cannot authorize this document.
        if (retained) assert.deepEqual(retained, old);
        return {
          cycleId: cycle.id,
          ...result,
          browserDocumentIdChanged: true,
          oldSessionCleared: retained === undefined,
          oldDocumentAuthorizationRetainedUntilReplacementOrExpiry:
            Boolean(retained),
          newDocumentResultRejected: true,
        };
      },
    );
    await check(
      "expired-token-rejected-after-restart",
      "An explicitly expired stored approval is rejected and purged after real restart",
      async () => {
        const session = await start(source, sourceTab);
        const injectedExpiresAt = Date.now() - 1;
        await observer.evaluate(
          async ({ token, expiresAt }) => {
            const { captureSessions } =
              await chrome.storage.session.get("captureSessions");
            await chrome.storage.session.set({
              captureSessions: captureSessions.map((item) =>
                item.token === token ? { ...item, expiresAt } : item,
              ),
            });
          },
          { token: session.token, expiresAt: injectedExpiresAt },
        );
        const { cycle, result } = await stopAndRestart(
          "expired",
          "Actual content script submits the token with a deliberately expired stored deadline",
          () => denied(sourceTab, session.token),
        );
        assert.equal(await sessionFor(sourceTab), undefined);
        await source.keyboard.press("Escape");
        await source
          .locator("#motionpaste-picker")
          .waitFor({ state: "detached" });
        return {
          cycleId: cycle.id,
          ...result,
          expiredTimestampInjectedByTrustedTestContext: true,
          actualFiveMinuteWait: false,
          injectedExpiresAt,
          expiredSessionPurged: true,
        };
      },
    );
    await check(
      "missing-token-rejected-and-reapproval-works",
      "Missing approval produces a retry instruction after restart, then actual reapproval and capture succeed",
      async () => {
        assert.equal((await sessions()).length, 0);
        const { cycle, result } = await stopAndRestart(
          "missing",
          "Actual content script submits a random token with no stored approval",
          () => denied(sourceTab, randomUUID()),
        );
        assert.equal((await sessions()).length, 0);
        const fresh = await start(source, sourceTab);
        assert.notEqual(fresh.token, originalSession.token);
        await realCapture();
        assert.equal(await captureCount(), 2);
        assert.equal(await sessionFor(sourceTab), undefined);
        return {
          cycleId: cycle.id,
          ...result,
          reapprovalFromRealToolbar: true,
          reapprovedCaptureCount: 2,
          reapprovedTokenConsumed: true,
        };
      },
    );
    report.summary = deriveLifecycleSummary(report);
    assert.equal(report.summary.checks, 7);
    assert.equal(report.summary.forcedStops, 6);
    assert.equal(report.summary.confirmedRestarts, 6);
    report.status = "PASS";
  } catch (error) {
    report.status = error instanceof LifecycleUnavailable ? "BLOCKED" : "FAIL";
    report.failure = String(error.stack || error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await closeLifecycleContext(context, report);
    if (server) await new Promise((resolve) => server.close(resolve));
    if (temp)
      await rm(temp, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    report.finishedAt = new Date().toISOString();
    await mkdir(resolve("artifacts/verification"), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(`REPORT ${report.status}: ${output}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  await runWorkerLifecycle();
