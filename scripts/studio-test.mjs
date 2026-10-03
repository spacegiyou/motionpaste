import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { archivePath } from "./release-info.mjs";

const output = resolve("artifacts/verification");
const report = {
  measuredAt: new Date().toISOString(),
  scope:
    "Actual release ZIP installed in a fresh Chromium profile; real extension Studio imports, controls, JSON/JavaScript downloads and downloaded-script execution. File-read ordering and download API failures are explicitly injected. No public-site or cross-browser claim.",
  status: "RUNNING",
  checks: [],
  errors: [],
};
let temporary;
let context;
let extensionId;
let baseline;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const importPayload = (recipe, name = "recipe.json") => ({
  name,
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify(recipe)),
});
function edited(duration) {
  return {
    ...structuredClone(baseline),
    status: "edited",
    timing: { ...baseline.timing, duration },
  };
}
async function readRecipe(page) {
  const code = await page.locator("#code-output").textContent();
  const match = /\n  const recipe = (\{[^\n]*\});\n/.exec(code);
  assert.ok(match, "Studio displays the standalone export's recipe");
  return JSON.parse(match[1]);
}
async function importRecipe(page, recipe, name) {
  await page.locator("#import-file").setInputFiles(importPayload(recipe, name));
  await page.waitForFunction(
    () => document.querySelector("#import-file").value === "",
  );
  assert.equal(await page.locator("#recipe-state").textContent(), "IMPORTED");
  assert.equal(await page.locator("#error-message").isVisible(), false);
  assert.deepEqual(await readRecipe(page), recipe);
}
async function setDuration(page, duration) {
  await page.locator("#duration-input").fill(String(duration));
  await page.locator("#duration-input").press("Tab");
  assert.equal(
    await page.locator("#duration-input").inputValue(),
    String(duration),
  );
  assert.equal(
    await page.locator("#duration-slider").inputValue(),
    String(duration),
  );
  assert.equal(await page.locator("#recipe-state").textContent(), "EDITED");
}
async function download(page, selector, filename) {
  const pending = page.waitForEvent("download");
  await page.locator(selector).click();
  const item = await pending;
  const path = join(temporary, filename);
  await item.saveAs(path);
  assert.equal(await item.failure(), null);
  return { name: item.suggestedFilename(), bytes: await readFile(path) };
}
async function downloadAndRun(page, duration) {
  const json = await download(page, "#export-json", `recipe-${duration}.json`);
  const parsed = JSON.parse(json.bytes);
  assert.equal(parsed.timing.duration, duration);
  const js = await download(page, "#download-js", `motion-${duration}.js`);
  const consumer = await context.newPage();
  try {
    await consumer.setContent(
      '<div id="target" style="width:100px;height:80px"></div>',
    );
    await consumer.addScriptTag({ content: js.bytes.toString("utf8") });
    const result = await consumer.evaluate(() => {
      const target = document.querySelector("#target");
      const motion = window.motionPaste(target);
      motion.animation.pause();
      motion.animation.currentTime = 100;
      const timing = motion.animation.effect.getTiming();
      motion.cancel();
      target.style.setProperty("opacity", "0.5", "important");
      let blocked;
      try {
        window.motionPaste(target);
      } catch (error) {
        blocked = {
          stage: error.stage,
          code: error.code,
          message: error.message,
        };
      }
      return {
        duration: timing.duration,
        remainingAnimations: target.getAnimations().length,
        corePresent: typeof window.MotionCore,
        blocked,
      };
    });
    assert.equal(result.duration, duration);
    assert.equal(result.remainingAnimations, 0);
    assert.equal(result.corePresent, "undefined");
    assert.equal(result.blocked?.stage, "APPLY");
    assert.equal(result.blocked?.code, "IMPORTANT_STYLE");
    assert.match(
      result.blocked?.message ?? "",
      /^APPLY blocked \[IMPORTANT_STYLE\]/,
    );
    return {
      duration,
      jsonName: json.name,
      javascriptName: js.name,
      jsonSHA256: digest(json.bytes),
      javascriptSHA256: digest(js.bytes),
      executedDownloadedJavaScript: result,
    };
  } finally {
    await consumer.close();
  }
}
async function check(name, callback, withRecipe = true) {
  let page;
  try {
    page = await context.newPage();
    page.on("pageerror", (error) =>
      report.errors.push({ check: name, error: String(error) }),
    );
    await page.goto(`chrome-extension://${extensionId}/studio.html`);
    await page.locator("#import-button").waitFor();
    if (withRecipe) await importRecipe(page, baseline);
    const details = await callback(page);
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
      error: String(error.stack ?? error),
    });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally {
    await page?.close();
  }
}

try {
  await mkdir(output, { recursive: true });
  report.archiveSHA256 = digest(await readFile(archivePath));
  report.archive = archivePath;
  temporary = await mkdtemp(join(tmpdir(), "motionpaste-studio-"));
  const extension = join(temporary, "extension");
  await mkdir(extension);
  execFileSync("unzip", ["-q", archivePath, "-d", extension]);
  const sums = JSON.parse(
    await readFile(join(extension, "SHA256SUMS.json"), "utf8"),
  );
  for (const [file, expected] of Object.entries(sums))
    assert.equal(digest(await readFile(join(extension, file))), expected, file);
  report.archiveMemberHashesVerified = Object.keys(sums).length;
  baseline = JSON.parse(
    await readFile(join(output, "captured-recipe.json"), "utf8"),
  );
  assert.equal(baseline.status, "captured");
  assert.equal(baseline.timing.duration, 1300);
  report.fixture = {
    path: "artifacts/verification/captured-recipe.json",
    originalDuration: baseline.originalDuration,
  };
  context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1100 },
    acceptDownloads: true,
    args: [`--load-extension=${extension}`],
    ignoreDefaultArgs: ["--disable-extensions"],
  });
  report.browser = context.browser().version();
  report.playwright = JSON.parse(
    await readFile("node_modules/playwright/package.json", "utf8"),
  ).version;
  report.node = process.version;
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).hostname;

  await check(
    "empty Studio and keyboard import expose honest provenance",
    async (page) => {
      assert.equal(
        await page.locator("#recipe-state").textContent(),
        "WAITING",
      );
      assert.equal(await page.locator("#support-boundary").isVisible(), true);
      assert.match(
        await page.locator("#support-boundary").textContent(),
        /successful capture does not guarantee playback/,
      );
      for (const selector of [
        "#play-button",
        "#duration-input",
        "#export-json",
        "#download-js",
        "#compare-original",
      ])
        assert.equal(await page.locator(selector).isDisabled(), true, selector);
      const chooser = page.waitForEvent("filechooser");
      await page.locator("#import-button").focus();
      await page.locator("#import-button").press("Enter");
      await (await chooser).setFiles(importPayload(baseline));
      await page.waitForFunction(
        () =>
          document.querySelector("#recipe-state").textContent === "IMPORTED",
      );
      assert.match(
        await page.locator("#capture-hint").textContent(),
        /Imported effect values.*not been verified/,
      );
      assert.equal(
        await page.locator("#source-target").getAttribute("aria-label"),
        "Neutral motion preview",
      );
      assert.match(
        await page.locator("#geometry-note").textContent(),
        /visual matching.*unverified/,
      );
      assert.deepEqual(await readRecipe(page), baseline);
      return {
        state: "IMPORTED",
        keyboardFileChooser: true,
        neutralPreview: true,
      };
    },
    false,
  );

  for (const duration of [733, 2333]) {
    await check(
      `precise ${duration} ms survives controls and actual JSON/JS downloads`,
      async (page) => {
        if (duration === 733) await setDuration(page, duration);
        else {
          await page.locator("#duration-slider").evaluate((input, value) => {
            input.value = String(value);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }, duration);
        }
        assert.equal(
          await page.locator("#duration-input").inputValue(),
          String(duration),
        );
        assert.equal(
          await page.locator("#duration-slider").inputValue(),
          String(duration),
        );
        assert.deepEqual(
          await page
            .locator("#duration-slider")
            .evaluate((input) => [input.min, input.max, input.step]),
          ["1", "60000", "1"],
        );
        return {
          control:
            duration === 733
              ? "number input via keyboard"
              : "range input with dispatched DOM input event",
          ...(await downloadAndRun(page, duration)),
        };
      },
    );
  }

  await check(
    "comparison uses loaded timing while pause/resume/reset preserve EDITED",
    async (page) => {
      await setDuration(page, 2333);
      const editedRecipe = await readRecipe(page);
      await page.locator("#compare-original").click();
      assert.equal(
        await page.locator("#compare-original").getAttribute("aria-pressed"),
        "true",
      );
      await page.locator("#play-button").click();
      const timings = await page.evaluate(() =>
        ["source-target", "preview-target"].map(
          (id) =>
            document.getElementById(id).getAnimations()[0].effect.getTiming()
              .duration,
        ),
      );
      assert.deepEqual(timings, [1300, 2333]);
      await page.locator("#play-button").click();
      assert.equal(
        await page.locator("#play-label").textContent(),
        "Resume motion",
      );
      assert.equal(await page.locator("#recipe-state").textContent(), "EDITED");
      await page.locator("#play-button").click();
      assert.equal(
        await page.locator("#play-label").textContent(),
        "Pause motion",
      );
      await page.locator("#reset-button").click();
      assert.deepEqual(
        await page.evaluate(() =>
          ["source-target", "preview-target"].map(
            (id) => document.getElementById(id).getAnimations().length,
          ),
        ),
        [0, 0],
      );
      assert.equal(await page.locator("#recipe-state").textContent(), "EDITED");
      assert.deepEqual(await readRecipe(page), editedRecipe);
      await page.screenshot({
        path: join(output, "studio-r1-desktop.png"),
        fullPage: true,
      });
      return {
        leftDuration: timings[0],
        rightDuration: timings[1],
        finalState: "EDITED",
        screenshot: "artifacts/verification/studio-r1-desktop.png",
      };
    },
  );

  await check(
    "restoring captured JSON loaded by import returns IMPORTED",
    async (page) => {
      await setDuration(page, 733);
      await page.locator("#restore-duration").click();
      assert.equal(
        await page.locator("#recipe-state").textContent(),
        "IMPORTED",
      );
      assert.equal(await page.locator("#duration-input").inputValue(), "1300");
      assert.deepEqual(await readRecipe(page), baseline);
    },
  );

  await check(
    "imported edited baseline restores 733 ms instead of historical 1300 ms",
    async (page) => {
      const imported = edited(733);
      await importRecipe(page, imported);
      await setDuration(page, 2333);
      await page.locator("#restore-duration").click();
      assert.equal(
        await page.locator("#recipe-state").textContent(),
        "IMPORTED",
      );
      assert.equal(await page.locator("#duration-input").inputValue(), "733");
      assert.deepEqual(await readRecipe(page), imported);
      return {
        loadedDuration: 733,
        originalDuration: 1300,
        restoredDuration: 733,
      };
    },
  );

  await check(
    "apply conflicts show target stage and preserve the imported recipe",
    async (page) => {
      const before = await readRecipe(page);
      await page
        .locator("#preview-target")
        .evaluate((target) =>
          target.style.setProperty("opacity", "0.5", "important"),
        );
      await page.locator("#play-button").click();
      await page.locator("#error-message").waitFor({ state: "visible" });
      const message = await page.locator("#error-message").textContent();
      assert.match(message, /^APPLY blocked \[IMPORTANT_STYLE\]/);
      assert.deepEqual(await readRecipe(page), before);
      assert.deepEqual(
        await page.evaluate(() =>
          ["source-target", "preview-target"].map(
            (id) => document.getElementById(id).getAnimations().length,
          ),
        ),
        [0, 0],
      );
      await page
        .locator("#preview-target")
        .evaluate((target) => target.style.removeProperty("opacity"));
      await page.locator("#play-button").click();
      assert.equal(await page.locator("#error-message").isVisible(), false);
      return {
        message,
        preservedRecipe: true,
        partialPlaybackCancelled: true,
        retrySucceeded: true,
      };
    },
  );

  await check(
    "invalid and oversized imports preserve the current edited recipe",
    async (page) => {
      await setDuration(page, 733);
      const before = await readRecipe(page);
      const errors = [];
      for (const [name, buffer] of [
        ["broken.json", Buffer.from("{ broken")],
        ["oversize.json", Buffer.alloc(65537, " ")],
      ]) {
        await page
          .locator("#import-file")
          .setInputFiles({ name, mimeType: "application/json", buffer });
        await page.locator("#error-message").waitFor({ state: "visible" });
        assert.match(
          await page.locator("#error-message").textContent(),
          /^IMPORT blocked/,
        );
        assert.deepEqual(await readRecipe(page), before);
        assert.equal(
          await page.locator("#recipe-state").textContent(),
          "EDITED",
        );
        errors.push({
          name,
          visibleError: await page.locator("#error-message").textContent(),
        });
      }
      return { preservedDuration: 733, errors };
    },
  );

  await check(
    "delayed older File.text never overwrites newer import or clears its selection",
    async (page) => {
      await page.evaluate(() => {
        const original = File.prototype.text;
        window.__studioReads = {};
        window.__restoreFileText = () => {
          File.prototype.text = original;
        };
        File.prototype.text = function () {
          const file = this;
          return new Promise((resolve, reject) => {
            window.__studioReads[file.name] = () =>
              original.call(file).then(resolve, reject);
          });
        };
      });
      const resolveRead = async (name) =>
        page.evaluate(async (name) => {
          await window.__studioReads[name]();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }, name);
      for (const [name, value] of [
        ["old-first.json", 733],
        ["new-first.json", 2333],
      ]) {
        await page
          .locator("#import-file")
          .setInputFiles(importPayload(edited(value), name));
        await page.waitForFunction(
          (name) => !!window.__studioReads[name],
          name,
        );
      }
      await resolveRead("new-first.json");
      assert.equal((await readRecipe(page)).timing.duration, 2333);
      await resolveRead("old-first.json");
      assert.equal((await readRecipe(page)).timing.duration, 2333);
      for (const [name, value] of [
        ["old-second.json", 733],
        ["new-second.json", 1555],
      ]) {
        await page
          .locator("#import-file")
          .setInputFiles(importPayload(edited(value), name));
        await page.waitForFunction(
          (name) => !!window.__studioReads[name],
          name,
        );
      }
      await resolveRead("old-second.json");
      assert.equal((await readRecipe(page)).timing.duration, 2333);
      assert.equal(
        await page
          .locator("#import-file")
          .evaluate((input) => input.files[0]?.name),
        "new-second.json",
      );
      await resolveRead("new-second.json");
      assert.equal((await readRecipe(page)).timing.duration, 1555);
      assert.equal(await page.locator("#import-file").inputValue(), "");
      await page.evaluate(() => window.__restoreFileText());
      return {
        injected:
          "File.prototype.text promises resolved in both completion orders",
        newerRecipePreserved: 2333,
        newerSelectionPreserved: "new-second.json",
        finalDuration: 1555,
      };
    },
  );

  for (const failure of ["createObjectURL", "anchor-click"]) {
    await check(
      `download ${failure} failure is visible and preserves work`,
      async (page) => {
        await setDuration(page, 733);
        const before = await readRecipe(page);
        await page.evaluate((failure) => {
          const create = URL.createObjectURL;
          const revoke = URL.revokeObjectURL;
          const click = HTMLAnchorElement.prototype.click;
          window.__studioRevoked = [];
          window.__restoreDownload = () => {
            URL.createObjectURL = create;
            URL.revokeObjectURL = revoke;
            HTMLAnchorElement.prototype.click = click;
          };
          if (failure === "createObjectURL")
            URL.createObjectURL = () => {
              throw new Error("Injected object URL failure");
            };
          else
            HTMLAnchorElement.prototype.click = function () {
              if (this.download)
                throw new Error("Injected download click failure");
              return click.call(this);
            };
          URL.revokeObjectURL = (url) => {
            window.__studioRevoked.push(url);
            revoke.call(URL, url);
          };
        }, failure);
        await page.locator("#download-js").click();
        await page.locator("#error-message").waitFor({ state: "visible" });
        assert.match(
          await page.locator("#error-message").textContent(),
          /Injected.*failure/,
        );
        assert.deepEqual(await readRecipe(page), before);
        assert.equal(await page.locator("a[download]").count(), 0);
        if (failure === "anchor-click")
          await page.waitForFunction(() => window.__studioRevoked.length === 1);
        const revoked = await page.evaluate(
          () => window.__studioRevoked.length,
        );
        await page.evaluate(() => window.__restoreDownload());
        const successful = await download(
          page,
          "#export-json",
          `after-${failure}.json`,
        );
        assert.deepEqual(JSON.parse(successful.bytes), before);
        assert.equal(await page.locator("#error-message").isVisible(), false);
        return {
          injected: failure,
          visibleError: true,
          temporaryAnchorsRemoved: true,
          revokedURLs: revoked,
          subsequentActualDownloadSucceeded: true,
        };
      },
    );
  }

  await check(
    "reduced motion requires an explicit preview and does not persist consent",
    async (page) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(
        () => document.querySelector("#play-button").disabled,
      );
      assert.match(
        await page.locator("#reduced-motion-notice").textContent(),
        /APPLY paused \[REDUCED_MOTION\]/,
      );
      assert.equal(await page.locator("#restart-button").isDisabled(), true);
      assert.equal(
        await page
          .locator("#preview-target")
          .evaluate((target) => target.getAnimations().length),
        0,
      );
      await page.locator("#play-once").click();
      assert.equal(
        await page
          .locator("#preview-target")
          .evaluate((target) => target.getAnimations().length),
        1,
      );
      await page.locator("#reset-button").click();
      assert.equal(await page.locator("#play-button").isDisabled(), true);
      assert.equal(await page.locator("#restart-button").isDisabled(), true);
      assert.equal(
        await page
          .locator("#preview-target")
          .evaluate((target) => target.getAnimations().length),
        0,
      );
      return {
        explicitPreviewWorked: true,
        normalPlaybackBlockedAfterReset: true,
      };
    },
  );

  await check(
    "390px Studio has no page overflow with recipe details open",
    async (page) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await setDuration(page, 2333);
      await page.locator("#recipe-details > summary").click();
      const geometry = await page.evaluate(() => ({
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
      }));
      assert.ok(
        geometry.documentWidth <= geometry.viewport,
        JSON.stringify(geometry),
      );
      assert.ok(
        geometry.bodyWidth <= geometry.viewport,
        JSON.stringify(geometry),
      );
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: join(output, "studio-r1-mobile.png"),
        fullPage: true,
      });
      return {
        ...geometry,
        screenshot: "artifacts/verification/studio-r1-mobile.png",
      };
    },
  );

  report.status =
    report.checks.every((item) => item.status === "PASS") &&
    report.errors.length === 0
      ? "PASS"
      : "FAIL";
} catch (error) {
  report.status = "FAIL";
  report.errors.push(String(error.stack ?? error));
  console.error(error);
} finally {
  await context?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await writeFile(
    join(output, "studio-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(`REPORT ${report.status}: ${join(output, "studio-report.json")}`);
  if (report.status !== "PASS") process.exitCode = 1;
}
