import { archivePath, archiveName, version } from "./release-info.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createServer } from "./serve.mjs";
import { openPicker } from "./browser-helpers.mjs";

// Independent archive smoke test: no source bundles, build, or core imports.
const archive = archivePath;
const output = resolve("artifacts/verification/independent-report.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  measuredAt: new Date().toISOString(),
  scope:
    "Actual ZIP in a fresh temporary extension profile; independently authored WAAPI fixture; actual toolbar action and popup; downloaded Studio JS replayed in a separate Chromium process with no extension loaded. No built core or existing report is used as test evidence.",
  status: "RUNNING",
  archive: `artifacts/release/${archiveName}`,
  archiveSHA256: sha(await readFile(archive)),
  checks: [],
  pageErrors: [],
  limitations: [
    "Local fixtures only; no public-site, commercial Chrome, non-Chromium, or operating-system coverage.",
    "The beta contract is one finite CSS/WAAPI effect, fill both, rate one, explicit transform/opacity endpoints and absolute pixel 2D transforms; this smoke test exercises a WAAPI success path.",
    "Expired capture is tested by aging the temporary profile's stored timestamp, not by waiting 30 minutes.",
    "Static suspicious-code scans and observed network requests are bounded checks, not a security audit.",
  ],
};
const check = async (name, fn) => {
  try {
    const details = await fn();
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
const temporary = await mkdtemp(join(tmpdir(), "motionpaste-independent-"));
const unpacked = join(temporary, "extracted-release");
const requests = new Set();
let extensionContext;
let consumerBrowser;
let server;
try {
  await mkdir(unpacked);
  execFileSync("unzip", ["-q", archive, "-d", unpacked]);
  await check(
    "ZIP checksum, exact members, member hashes and manifest scope",
    async () => {
      const checksum = await readFile(`${archive}.sha256`, "utf8");
      assert.equal(checksum.split(/\s+/)[0], report.archiveSHA256);
      const members = (await readdir(unpacked)).sort();
      const expected = [
        "LICENSE",
        "SHA256SUMS.json",
        "manifest.json",
        "picker.js",
        "popup.css",
        "popup.html",
        "popup.js",
        "studio.css",
        "studio.html",
        "studio.js",
        "worker.js",
      ].sort();
      assert.deepEqual(members, expected);
      const sums = JSON.parse(
        await readFile(join(unpacked, "SHA256SUMS.json"), "utf8"),
      );
      assert.deepEqual(
        Object.keys(sums).sort(),
        expected.filter((file) => file !== "SHA256SUMS.json"),
      );
      for (const [file, hash] of Object.entries(sums)) {
        assert.equal(sha(await readFile(join(unpacked, file))), hash, file);
      }
      const manifest = JSON.parse(
        await readFile(join(unpacked, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.manifest_version, 3);
      assert.equal(manifest.version_name, version);
      assert.deepEqual([...manifest.permissions].sort(), [
        "activeTab",
        "scripting",
        "storage",
      ]);
      for (const key of [
        "host_permissions",
        "optional_host_permissions",
        "externally_connectable",
        "content_scripts",
        "web_accessible_resources",
      ])
        assert.equal(manifest[key], undefined, key);
      assert.equal(
        manifest.content_security_policy.extension_pages,
        "script-src 'self'; object-src 'none'; base-uri 'none'; connect-src 'none'",
      );
      return { members, verifiedMembers: Object.keys(sums).length, manifest };
    },
  );
  await check(
    "Packaged runtime has no external imports or dynamic code evaluation",
    async () => {
      const scanned = [];
      for (const file of (await readdir(unpacked)).filter((file) =>
        /\.(js|html|css)$/.test(file),
      )) {
        const content = await readFile(join(unpacked, file), "utf8");
        assert.doesNotMatch(content, /\beval\s*\(|\bnew\s+Function\s*\(/, file);
        assert.doesNotMatch(
          content,
          /\bimport\s*\(|\bimportScripts\s*\(/,
          file,
        );
        assert.doesNotMatch(
          content,
          /(?:from\s*|\bimport\s*)["']https?:\/\/|(?:src|href)\s*=\s*["']https?:\/\/|@import\s*["']?https?:\/\//,
          file,
        );
        scanned.push(file);
      }
      return {
        scanned,
        method:
          "Static scans of all packaged JS, HTML and CSS; observed requests are checked separately.",
      };
    },
  );
  server = await createServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  extensionContext = await chromium.launchPersistentContext(
    join(temporary, "fresh-profile"),
    {
      channel: "chromium",
      headless: true,
      viewport: { width: 1440, height: 1000 },
      args: [`--load-extension=${unpacked}`],
      ignoreDefaultArgs: ["--disable-extensions"],
    },
  );
  report.browser = extensionContext.browser().version();
  report.node = process.version;
  report.platform = process.platform;
  report.playwright = JSON.parse(
    await readFile("node_modules/playwright/package.json", "utf8"),
  ).version;
  extensionContext.on("request", (request) => requests.add(request.url()));
  extensionContext.on("page", (page) =>
    page.on("pageerror", (error) => report.pageErrors.push(String(error))),
  );
  const worker =
    extensionContext.serviceWorkers()[0] ||
    (await extensionContext.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).hostname;
  await check(
    "Fresh profile Studio starts empty with playback and export disabled",
    async () => {
      const studio = await extensionContext.newPage();
      await studio.goto(`chrome-extension://${extensionId}/studio.html`);
      assert.equal(
        (await studio.locator("#recipe-state").textContent()).trim(),
        "WAITING",
      );
      for (const id of [
        "play-button",
        "restart-button",
        "duration-input",
        "export-json",
        "download-js",
      ])
        assert.ok(await studio.locator(`#${id}`).isDisabled(), id);
      assert.equal(
        await studio
          .locator("#preview-target")
          .evaluate((element) => element.getAnimations().length),
        0,
      );
      const data = await worker.evaluate(() =>
        chrome.storage.session.get("captures"),
      );
      assert.equal(data.captures, undefined);
      await studio.close();
      return { state: "WAITING", captures: 0, animations: 0 };
    },
  );
  const source = await extensionContext.newPage();
  await source.goto(`${base}/fixtures/source-app/`);
  await source.locator("#motion-kind").selectOption("waapi");
  await source.waitForFunction(
    () =>
      document.querySelector("#source-card").getAnimations()[0]?.playState ===
      "finished",
  );
  let studio;
  let originalRecipe;
  await check(
    "Actual toolbar action → popup → WAAPI element selection → captured Studio",
    async () => {
      const snapshot = () =>
        source.evaluate(() => ({
          documentHTML: document.documentElement.outerHTML,
          targetHTML: document.querySelector("#source-card").outerHTML,
          animations: document
            .querySelector("#source-card")
            .getAnimations()
            .map((animation) => ({
              timing: animation.effect.getTiming(),
              frames: animation.effect.getKeyframes(),
              playbackRate: animation.playbackRate,
              playState: animation.playState,
              currentTime: animation.currentTime,
            })),
        }));
      const before = await snapshot();
      await openPicker(extensionContext, source, extensionId);
      const nextStudio = extensionContext.waitForEvent("page", {
        predicate: (page) => page.url().includes("/studio.html?id="),
      });
      await source.locator("#source-card").click();
      studio = await nextStudio;
      await studio.waitForLoadState();
      await studio.waitForFunction(
        () =>
          document.querySelector("#recipe-state")?.textContent === "CAPTURED",
      );
      await source
        .locator("#motionpaste-picker")
        .waitFor({ state: "detached" });
      const after = await snapshot();
      assert.deepEqual(
        after,
        before,
        "Source HTML and finished source animation remain unchanged",
      );
      const data = await worker.evaluate(() =>
        chrome.storage.session.get("captures"),
      );
      assert.equal(data.captures.length, 1);
      originalRecipe = data.captures[0].recipe;
      assert.equal(originalRecipe.timing.duration, 1600);
      assert.equal(originalRecipe.timing.fill, "both");
      assert.equal(originalRecipe.timing.iterations, 1);
      assert.equal(originalRecipe.keyframes.length, 3);
      assert.equal(
        originalRecipe.keyframes[0].transform,
        "translateX(-45px) scale(0.88)",
      );
      assert.equal(originalRecipe.originalDuration, 1600);
      assert.equal(
        JSON.stringify(originalRecipe).includes("Room to explore"),
        false,
      );
      assert.equal(JSON.stringify(originalRecipe).includes(base), false);
      return {
        selectedMode: "waapi",
        state: "CAPTURED",
        captureCount: 1,
        recipe: originalRecipe,
        sourceDocumentSHA256Before: sha(before.documentHTML),
        sourceDocumentSHA256After: sha(after.documentHTML),
        sourceTargetSHA256Before: sha(before.targetHTML),
        sourceTargetSHA256After: sha(after.targetHTML),
        sourceAnimationUnchanged: true,
      };
    },
  );
  let exported;
  await check(
    "Studio duration edit to 900 ms and actual JS/JSON downloads",
    async () => {
      await studio.locator("#duration-input").fill("900");
      await studio.locator("#duration-input").press("Tab");
      assert.equal(
        (await studio.locator("#recipe-state").textContent()).trim(),
        "EDITED",
      );
      await studio.locator("#play-button").click();
      assert.equal(
        await studio
          .locator("#preview-target")
          .evaluate(
            (element) => element.getAnimations()[0].effect.getTiming().duration,
          ),
        900,
      );
      await studio.locator("#reset-button").click();
      const jsonEvent = studio.waitForEvent("download");
      await studio.locator("#export-json").click();
      const jsonDownload = await jsonEvent;
      const jsonPath = join(temporary, "downloaded-recipe.json");
      await jsonDownload.saveAs(jsonPath);
      const edited = JSON.parse(await readFile(jsonPath, "utf8"));
      assert.equal(edited.status, "edited");
      assert.equal(edited.timing.duration, 900);
      assert.equal(edited.originalDuration, 1600);
      assert.deepEqual(edited.keyframes, originalRecipe.keyframes);
      const jsEvent = studio.waitForEvent("download");
      await studio.locator("#download-js").click();
      const jsDownload = await jsEvent;
      const jsPath = join(temporary, "downloaded-motion.js");
      await jsDownload.saveAs(jsPath);
      exported = await readFile(jsPath, "utf8");
      assert.match(exported, /motionPaste/);
      assert.doesNotMatch(
        exported,
        /\bimport\s*\(|\beval\s*\(|\bnew\s+Function\s*\(/,
      );
      return {
        recipe: edited,
        jsSHA256: sha(exported),
        jsBytes: Buffer.byteLength(exported),
        downloadName: jsDownload.suggestedFilename(),
      };
    },
  );
  await check(
    "Downloaded JS runs and cleans up in a separate browser without the extension",
    async () => {
      consumerBrowser = await chromium.launch({
        channel: "chromium",
        headless: true,
      });
      const consumerContext = await consumerBrowser.newContext();
      consumerContext.on("request", (request) => requests.add(request.url()));
      const consumer = await consumerContext.newPage();
      consumer.on("pageerror", (error) =>
        report.pageErrors.push(String(error)),
      );
      await consumer.goto(`${base}/fixtures/consumer-app/`);
      assert.equal(consumerContext.serviceWorkers().length, 0);
      await consumer.addScriptTag({ content: exported });
      const evidence = await consumer.evaluate(async () => {
        const target = document.querySelector("#target");
        const autoStartedAnimations = target.getAnimations().length;
        target.style.setProperty("transform-origin", "7px 11px", "important");
        const before = {
          style: target.getAttribute("style"),
          html: target.innerHTML,
          opacity: getComputedStyle(target).opacity,
          transform: getComputedStyle(target).transform,
        };
        const handle = window.motionPaste(target);
        const sample = () => ({
          time: handle.animation.currentTime,
          state: handle.animation.playState,
          opacity: Number(getComputedStyle(target).opacity),
          transform: getComputedStyle(target).transform,
        });
        await handle.animation.ready;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const first = sample();
        await new Promise((resolve) => setTimeout(resolve, 180));
        const second = sample();
        let conflict;
        try {
          window.motionPaste(target);
        } catch (error) {
          conflict = error.code;
        }
        const duration = handle.animation.effect.getTiming().duration;
        handle.cancel();
        handle.cancel();
        const after = {
          style: target.getAttribute("style"),
          html: target.innerHTML,
          opacity: getComputedStyle(target).opacity,
          transform: getComputedStyle(target).transform,
        };
        return {
          autoStartedAnimations,
          first,
          second,
          conflict,
          duration,
          before,
          after,
          remainingAnimations: target.getAnimations().length,
          core: typeof window.MotionCore,
          extensionRuntime: typeof window.chrome?.runtime?.id,
        };
      });
      assert.equal(evidence.autoStartedAnimations, 0);
      assert.equal(evidence.core, "undefined");
      assert.equal(evidence.extensionRuntime, "undefined");
      assert.equal(evidence.duration, 900);
      assert.equal(evidence.first.state, "running");
      assert.equal(evidence.second.state, "running");
      assert.ok(evidence.second.time > evidence.first.time);
      assert.ok(
        evidence.first.opacity > 0 &&
          evidence.second.opacity > evidence.first.opacity &&
          evidence.second.opacity < 1,
      );
      assert.notEqual(evidence.first.transform, evidence.second.transform);
      assert.notEqual(evidence.first.transform, "none");
      assert.equal(evidence.conflict, "TARGET_CONFLICT");
      assert.equal(evidence.remainingAnimations, 0);
      assert.deepEqual(evidence.after, evidence.before);
      await consumerContext.close();
      return { ...evidence, separateBrowserProcess: true, loadedExtensions: 0 };
    },
  );
  await check(
    "Aged capture expires with an actionable empty Studio",
    async () => {
      const captureURL = studio.url();
      await worker.evaluate(async () => {
        const data = await chrome.storage.session.get("captures");
        await chrome.storage.session.set({
          captures: data.captures.map((capture) => ({
            ...capture,
            createdAt: Date.now() - 31 * 60 * 1000,
          })),
        });
      });
      const expiredStudio = await extensionContext.newPage();
      await expiredStudio.goto(captureURL);
      await expiredStudio
        .locator("#error-message")
        .waitFor({ state: "visible" });
      const message = await expiredStudio
        .locator("#error-message")
        .textContent();
      assert.match(message, /expired/);
      assert.match(message, /select the element again or import/);
      assert.equal(
        (await expiredStudio.locator("#recipe-state").textContent()).trim(),
        "WAITING",
      );
      assert.ok(await expiredStudio.locator("#play-button").isDisabled());
      assert.ok(await expiredStudio.locator("#download-js").isDisabled());
      assert.equal(
        (await worker.evaluate(() => chrome.storage.session.get("captures")))
          .captures.length,
        0,
      );
      return {
        method: "Aged record timestamp by 31 minutes in isolated test profile",
        message,
        state: "WAITING",
        capturesRemaining: 0,
      };
    },
  );
  await check(
    "No page errors or remote requests; final archive hash still matches",
    async () => {
      assert.deepEqual(report.pageErrors, []);
      const remoteRequests = [...requests].filter(
        (url) =>
          !url.startsWith(base + "/") &&
          !url.startsWith(`chrome-extension://${extensionId}/`) &&
          !url.startsWith("blob:"),
      );
      assert.deepEqual(remoteRequests, []);
      assert.equal(
        sha(await readFile(archive)),
        report.archiveSHA256,
        "Release archive changed during independent run",
      );
      return {
        observedRequests: [...requests].sort(),
        remoteRequests,
        finalArchiveSHA256: report.archiveSHA256,
      };
    },
  );
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.failure = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await consumerBrowser?.close();
  await extensionContext?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
  await mkdir(resolve("artifacts/verification"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`INDEPENDENT REPORT ${report.status}: ${output}`);
}
