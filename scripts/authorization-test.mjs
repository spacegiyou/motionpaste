import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { openPicker } from "./browser-helpers.mjs";
import { archivePath, version } from "./release-info.mjs";
import { createServer } from "./serve.mjs";

const output = resolve("artifacts/verification/authorization-report.json");
const report = {
  measuredAt: new Date().toISOString(),
  version,
  scope:
    "Fresh Chromium profile, extracted release ZIP, actual toolbar activeTab grant, isolated content scripts with browser-generated MessageSender identities. Local fixtures only.",
  status: "RUNNING",
  checks: [],
  notRun: [
    "Natural idle worker termination and full browser restart are not covered. Actual forced worker stop/restart is separately exercised by scripts/worker-lifecycle-test.mjs; retained-storage VM recreation remains in tests/worker.test.ts.",
  ],
};
let context, server, temp;
const check = async (name, operation) => {
  try {
    const details = await operation();
    report.checks.push({
      name,
      status: "PASS",
      ...(details ? { details } : {}),
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({
      name,
      status: "FAIL",
      error: String(error.stack || error),
    });
    throw error;
  }
};
const validRecipe = {
  version: 1,
  status: "captured",
  keyframes: [
    { offset: 0, easing: "linear", opacity: 0 },
    { offset: 1, easing: "linear", opacity: 1 },
  ],
  timing: {
    duration: 1000,
    delay: 0,
    endDelay: 0,
    iterations: 1,
    iterationStart: 0,
    direction: "normal",
    easing: "linear",
    fill: "both",
  },
  context: { transformOrigin: "50px 50px" },
  originalDuration: 1000,
};

try {
  await mkdir(resolve("artifacts/verification"), { recursive: true });
  report.archiveSHA256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  temp = await mkdtemp(join(tmpdir(), "motionpaste-authorization-"));
  const unpacked = join(temp, "extension");
  await mkdir(unpacked);
  execFileSync("unzip", ["-q", archivePath, "-d", unpacked]);
  await check("archive member hashes and minimal permissions", async () => {
    const sums = JSON.parse(
      await readFile(join(unpacked, "SHA256SUMS.json"), "utf8"),
    );
    for (const [file, hash] of Object.entries(sums))
      assert.equal(
        createHash("sha256")
          .update(await readFile(join(unpacked, file)))
          .digest("hex"),
        hash,
      );
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
    report.manifestVersion = manifest.version;
    report.manifestVersionName = manifest.version_name;
  });
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
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const source = await context.newPage();
  await source.goto(`${base}/fixtures/source-app/?authorization=a`);

  const sessions = async () =>
    (await worker.evaluate(() => chrome.storage.session.get("captureSessions")))
      .captureSessions || [];
  const sessionFor = async (tabId) =>
    (await sessions()).find((session) => session.tabId === tabId);
  const tabFor = async (page) =>
    worker.evaluate(
      async (url) =>
        (await chrome.tabs.query({})).find((tab) => tab.url === url)?.id,
      page.url(),
    );
  const captureCount = async () =>
    (
      (await worker.evaluate(() => chrome.storage.session.get("captures")))
        .captures || []
    ).length;
  const sendFromPage = async (tabId, message) =>
    worker.evaluate(
      async ({ tabId, message }) => {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: "ISOLATED",
          func: async (payload) => chrome.runtime.sendMessage(payload),
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
  const deniedCapture = async (tabId, token) => {
    const before = await captureCount();
    const result = await sendFromPage(tabId, {
      type: "MOTIONPASTE_CAPTURE",
      token,
      recipe: validRecipe,
    });
    assert.equal(result.response.ok, false);
    assert.equal(await captureCount(), before);
    return result;
  };
  const waitSession = async (tabId, previousToken) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const session = await sessionFor(tabId);
      if (session && session.token !== previousToken) return session;
      await source.waitForTimeout(50);
    }
    throw new Error("New authorization was not persisted.");
  };

  let sourceTab;
  await check(
    "own isolated content script cannot capture or begin before popup authorization",
    async () => {
      // Trigger the real action to obtain activeTab, but close its popup without
      // clicking Capture. This permits test injection without granting a session.
      const cdp = await context.browser().newBrowserCDPSession();
      await source.bringToFront();
      const { targetInfos } = await cdp.send("Target.getTargets", {
        filter: [{ type: "tab" }],
      });
      const target = targetInfos.find((item) => item.url === source.url());
      assert.ok(target);
      await cdp.send("Extensions.triggerAction", {
        id: extensionId,
        targetId: target.targetId,
      });
      let popup;
      for (let attempt = 0; attempt < 30; attempt++) {
        const { targetInfos } = await cdp.send("Target.getTargets", {
          filter: [{ type: "page" }],
        });
        popup = targetInfos.find(
          (item) => item.url === `chrome-extension://${extensionId}/popup.html`,
        );
        if (popup) break;
        await source.waitForTimeout(50);
      }
      assert.ok(popup);
      await cdp.send("Target.closeTarget", { targetId: popup.targetId });
      await cdp.detach();
      sourceTab = await tabFor(source);
      assert.equal(typeof sourceTab, "number");
      assert.equal((await sessions()).length, 0);
      const result = await deniedCapture(sourceTab, "unapproved-nonce");
      assert.equal(result.frameId, 0);
      assert.ok(result.documentId);
      assert.equal(
        (await sendFromPage(sourceTab, { type: "MOTIONPASTE_BEGIN_CAPTURE" }))
          .response.ok,
        false,
      );
      assert.equal((await sessions()).length, 0);
      return { actualTopFrameIdentity: true, noAuthorizationCreated: true };
    },
  );

  await check(
    "actual picker click consumes its session; consumed token replay fails",
    async () => {
      await openPicker(context, source, extensionId);
      const session = await waitSession(sourceTab);
      const studioEvent = context.waitForEvent("page", {
        predicate: (page) => page.url().includes("/studio.html"),
      });
      await source.locator("#source-card").click();
      const studio = await studioEvent;
      await studio.waitForLoadState();
      await studio.waitForFunction(() =>
        document
          .querySelector("#recipe-state")
          ?.textContent?.toLowerCase()
          .includes("captured"),
      );
      assert.equal(await captureCount(), 1);
      assert.equal(await sessionFor(sourceTab), undefined);
      const replay = await deniedCapture(sourceTab, session.token);
      assert.equal(replay.documentId, session.documentId);
      await source
        .locator("#motionpaste-picker")
        .waitFor({ state: "detached" });
      return { storedCaptures: 1, studioReadAfterCommit: true };
    },
  );

  await check(
    "different authorized tab cannot spend another tab's token",
    async () => {
      await openPicker(context, source, extensionId);
      const first = await waitSession(sourceTab);
      const secondPage = await context.newPage();
      await secondPage.goto(`${base}/fixtures/source-app/?authorization=b`);
      await openPicker(context, secondPage, extensionId);
      const secondTab = await tabFor(secondPage);
      const second = await waitSession(secondTab);
      assert.notEqual(first.tabId, second.tabId);
      assert.notEqual(first.documentId, second.documentId);
      const crossTab = await deniedCapture(secondTab, first.token);
      assert.equal(crossTab.documentId, second.documentId);
      assert.equal((await sessionFor(sourceTab)).token, first.token);
      assert.equal((await sessionFor(secondTab)).token, second.token);
      await secondPage.keyboard.press("Escape");
      await secondPage
        .locator("#motionpaste-picker")
        .waitFor({ state: "detached" });
      await secondPage.close();
    },
  );

  await check(
    "same-origin navigation changes document identity and rejects the old token",
    async () => {
      const old = await sessionFor(sourceTab);
      assert.ok(old);
      await source.goto(
        `${base}/fixtures/source-app/?authorization=after-navigation`,
      );
      const rejected = await deniedCapture(sourceTab, old.token);
      assert.notEqual(rejected.documentId, old.documentId);
      assert.equal(await sessionFor(sourceTab), undefined);
      return {
        browserDocumentIdChanged: true,
        priorDocumentSessionCleared: true,
      };
    },
  );

  await check(
    "repeated invocation replaces its token; stale cleanup cannot revoke replacement",
    async () => {
      await openPicker(context, source, extensionId);
      const old = await waitSession(sourceTab);
      await openPicker(context, source, extensionId);
      const replacement = await waitSession(sourceTab, old.token);
      assert.notEqual(replacement.token, old.token);
      assert.equal(replacement.documentId, old.documentId);
      await sendFromPage(sourceTab, {
        type: "MOTIONPASTE_CANCEL_CAPTURE",
        token: old.token,
      });
      await deniedCapture(sourceTab, old.token);
      assert.equal((await sessionFor(sourceTab)).token, replacement.token);
      assert.equal(await source.locator("#motionpaste-picker").count(), 1);
    },
  );

  await check(
    "expired token fails closed (trusted storage timestamp fault injection)",
    async () => {
      const session = await sessionFor(sourceTab);
      assert.ok(session);
      await worker.evaluate(async (token) => {
        const { captureSessions } =
          await chrome.storage.session.get("captureSessions");
        await chrome.storage.session.set({
          captureSessions: captureSessions.map((item) =>
            item.token === token
              ? { ...item, expiresAt: Date.now() - 1 }
              : item,
          ),
        });
      }, session.token);
      await deniedCapture(sourceTab, session.token);
      assert.equal(await sessionFor(sourceTab), undefined);
      await source.keyboard.press("Escape");
      await source
        .locator("#motionpaste-picker")
        .waitFor({ state: "detached" });
      return {
        actualFiveMinuteWait: false,
        expiredTimestampInjectedByTrustedTestContext: true,
      };
    },
  );

  await check(
    "Escape clears authorization and session storage contains no source metadata",
    async () => {
      await openPicker(context, source, extensionId);
      const session = await waitSession(sourceTab);
      assert.deepEqual(Object.keys(session).sort(), [
        "documentId",
        "expiresAt",
        "tabId",
        "token",
      ]);
      const stored = await worker.evaluate(() =>
        chrome.storage.session.get(null),
      );
      assert.equal(JSON.stringify(stored).includes(base), false);
      assert.equal(JSON.stringify(stored).includes("Room to explore"), false);
      await source.keyboard.press("Escape");
      await source
        .locator("#motionpaste-picker")
        .waitFor({ state: "detached" });
      await deniedCapture(sourceTab, session.token);
      assert.equal(await sessionFor(sourceTab), undefined);
      assert.equal(await captureCount(), 1);
    },
  );
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.failure = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (temp) await rm(temp, { recursive: true, force: true });
  await mkdir(resolve("artifacts/verification"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`REPORT ${report.status}: ${output}`);
}
