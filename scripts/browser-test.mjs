import { archivePath } from "./release-info.mjs";
import { chromium } from "playwright";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { createServer } from "./serve.mjs";
import { openPicker } from "./browser-helpers.mjs";

const output = resolve("artifacts/verification");
await mkdir(output, { recursive: true });
await mkdir("artifacts/.tmp", { recursive: true });
const report = {
  measuredAt: new Date().toISOString(),
  scope:
    "Fresh profile; actual release ZIP; local independent CSS/WAAPI fixtures. No public websites or cross-browser claims.",
  status: "RUNNING",
  checks: [],
  parityCases: 0,
  samplePoints: 0,
  maxAbsoluteError: 0,
  errors: [],
};
const archive = archivePath;
report.archiveSHA256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
const temp = await mkdtemp(join(tmpdir(), "motionpaste-verify-"));
const unpacked = join(temp, "extension");
await mkdir(unpacked);
execFileSync("unzip", ["-q", archive, "-d", unpacked]);
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
report.checks.push({ name: "archive member hashes", status: "PASS" });
await build({
  entryPoints: ["src/core/index.ts"],
  outfile: "artifacts/.tmp/core.js",
  bundle: true,
  format: "iife",
  globalName: "MotionCore",
  target: "chrome120",
});
const server = await createServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
let context;
const check = async (name, fn) => {
  try {
    const details = await fn();
    report.checks.push({
      name,
      status: "PASS",
      ...(details ? { details } : {}),
    });
    console.log(`PASS ${name}`);
  } catch (e) {
    report.checks.push({ name, status: "FAIL", error: String(e.stack || e) });
    throw e;
  }
};
try {
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
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).hostname;
  const source = await context.newPage();
  source.on("pageerror", (e) => report.errors.push(String(e)));
  await source.goto(`${base}/fixtures/source-app/`);

  let studio, recipe, exported;
  await check("release ZIP extension permissions", async () => {
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
  });
  await check(
    "actual action grants activeTab → picker → worker → Studio",
    async () => {
      const before = await source.locator("#source-card").evaluate((e) => ({
        html: e.outerHTML,
        timing: e.getAnimations()[0].effect.getTiming(),
        rate: e.getAnimations()[0].playbackRate,
      }));
      await openPicker(context, source, extensionId);
      await source.locator("#source-card").hover();
      await source.screenshot({ path: join(output, "picker.png") });
      const studioEvent = context.waitForEvent("page", {
        predicate: (p) => p.url().includes("/studio.html"),
      });
      await source.locator("#source-card").click();
      studio = await studioEvent;
      await studio.waitForLoadState();
      studio.on("pageerror", (e) => report.errors.push(String(e)));
      await studio.waitForFunction(() =>
        document
          .querySelector("#recipe-state")
          ?.textContent?.toLowerCase()
          .includes("captured"),
      );
      const data = await worker.evaluate(() =>
        chrome.storage.session.get("captures"),
      );
      assert.equal(data.captures.length, 1);
      recipe = data.captures[0].recipe;
      assert.equal(recipe.timing.duration, 1300);
      assert.equal(JSON.stringify(recipe).includes("Room to explore"), false);
      assert.equal(JSON.stringify(recipe).includes(base), false);
      const after = await source.locator("#source-card").evaluate((e) => ({
        html: e.outerHTML,
        timing: e.getAnimations()[0].effect.getTiming(),
        rate: e.getAnimations()[0].playbackRate,
      }));
      assert.deepEqual(after, before);
      await writeFile(
        join(output, "captured-recipe.json"),
        JSON.stringify(recipe, null, 2) + "\n",
      );
      await studio.screenshot({
        path: join(output, "studio.png"),
        fullPage: true,
      });
    },
  );
  await check(
    "Studio playback, design switch, duration edit, reset and downloads",
    async () => {
      await studio.locator("#play-button").click();
      assert.ok(
        (await studio
          .locator("#preview-target")
          .evaluate((e) => e.getAnimations().length)) > 0,
      );
      await studio.locator('[data-design="pill"]').click();
      await studio.locator("#duration-input").fill("700");
      await studio.locator("#duration-input").press("Tab");
      assert.match(
        await studio.locator("#recipe-state").textContent(),
        /edited/i,
      );
      await studio.locator("#restart-button").click();
      assert.equal(
        await studio
          .locator("#preview-target")
          .evaluate((e) => e.getAnimations()[0].effect.getTiming().duration),
        700,
      );
      const jsonEvent = studio.waitForEvent("download");
      await studio.locator("#export-json").click();
      const json = await jsonEvent;
      await json.saveAs(join(output, "edited-recipe.json"));
      assert.equal(
        JSON.parse(await readFile(join(output, "edited-recipe.json"), "utf8"))
          .timing.duration,
        700,
      );
      const jsEvent = studio.waitForEvent("download");
      await studio.locator("#download-js").click();
      const js = await jsEvent;
      await js.saveAs(join(output, "studio-export.js"));
      assert.match(
        await readFile(join(output, "studio-export.js"), "utf8"),
        /motionPaste/,
      );
      await studio.locator("#reset-button").click();
      assert.equal(
        await studio
          .locator("#preview-target")
          .evaluate((e) => e.getAnimations().length),
        0,
      );
      await studio.locator("#restore-duration").click();
      assert.equal(
        await studio.locator("#duration-input").inputValue(),
        "1300",
      );
      await studio.locator("#import-file").setInputFiles({
        name: "malicious.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          '{"version":999,"html":"<img src=x onerror=alert(1)>"}',
        ),
      });
      await studio.locator("#error-message").waitFor({ state: "visible" });
      assert.equal(await studio.locator("img").count(), 0);
      await studio
        .locator("#import-file")
        .setInputFiles(join(output, "captured-recipe.json"));
      await studio.locator("#error-message").waitFor({ state: "hidden" });
      await studio.emulateMedia({ reducedMotion: "reduce" });
      await studio.waitForFunction(
        () => document.querySelector("#play-button").disabled,
      );
      assert.equal(await studio.locator("#play-button").isDisabled(), true);
      assert.equal(
        await studio
          .locator("#preview-target")
          .evaluate((e) => e.getAnimations().length),
        0,
      );
      await studio.locator("#play-once").click();
      assert.equal(
        await studio
          .locator("#preview-target")
          .evaluate((e) => e.getAnimations().length),
        1,
      );
      await studio.locator("#reset-button").click();
      await studio.emulateMedia({ reducedMotion: "no-preference" });
      await studio.screenshot({
        path: join(output, "studio.png"),
        fullPage: true,
      });
    },
  );
  await check("Studio CSP without page errors", async () => {
    assert.deepEqual(report.errors, []);
  });
  await check("capture cancellation and unsupported animation", async () => {
    await openPicker(context, source, extensionId);
    await source.keyboard.press("Escape");
    await source.locator("#motion-kind").selectOption("unsupported");
    await openPicker(context, source, extensionId);
    await source.locator("#source-card").click();
    await source.waitForTimeout(300);
    const data = await worker.evaluate(() =>
      chrome.storage.session.get("captures"),
    );
    assert.equal(data.captures.length, 1);
    assert.match(
      await source.locator("body").innerText(),
      /unsupported|opacity|transform/i,
    );
    await source.keyboard.press("Escape");
  });
  const parity = await context.newPage();
  await parity.goto(`${base}/fixtures/consumer-app/`);
  await parity.addScriptTag({ url: `${base}/artifacts/.tmp/core.js` });
  await check("50 CSS/WAAPI parity cases × 26 sample times", async () => {
    const result = await parity.evaluate(() => {
      const transforms = [
        [
          "translateY(40px) rotate(-6deg) scale(.9)",
          "translateY(-8px) rotate(2deg) scale(1.02)",
          "translateY(0px) rotate(0deg) scale(1)",
        ],
        ["translateX(-30px)", "translateX(12px)", "translateX(0px)"],
        [
          "matrix(1,0,0,1,-15,20)",
          "matrix(.9,.1,-.1,.9,8,-4)",
          "matrix(1,0,0,1,0,0)",
        ],
      ];
      const easings = [
        "linear",
        "ease-in-out",
        "cubic-bezier(.21,.8,.44,1.12)",
        "steps(5,end)",
      ];
      const directions = [
        "normal",
        "reverse",
        "alternate",
        "alternate-reverse",
      ];
      let count = 0,
        samples = 0,
        maxError = 0;
      function compare(source, target, times) {
        const recipe = MotionCore.captureMotion(source);
        const handle = MotionCore.replayMotion(target, recipe);
        const original = source.getAnimations()[0];
        original.pause();
        handle.animation.pause();
        for (const t of times) {
          original.currentTime = t;
          handle.animation.currentTime = t;
          const a = getComputedStyle(source),
            b = getComputedStyle(target);
          const ma = new DOMMatrix(a.transform),
            mb = new DOMMatrix(b.transform);
          const ra = source.getBoundingClientRect(),
            rb = target.getBoundingClientRect();
          const valuesA = [
            Number(a.opacity),
            ma.a,
            ma.b,
            ma.c,
            ma.d,
            ma.e,
            ma.f,
            ra.x,
            ra.y,
            ra.width,
            ra.height,
          ];
          const valuesB = [
            Number(b.opacity),
            mb.a,
            mb.b,
            mb.c,
            mb.d,
            mb.e,
            mb.f,
            rb.x,
            rb.y,
            rb.width,
            rb.height,
          ];
          for (let i = 0; i < valuesA.length; i++) {
            const error = Math.abs(valuesA[i] - valuesB[i]);
            maxError = Math.max(error, maxError);
            if (error > 0.002)
              throw Error(`parity ${count} at ${t} value ${i}: ${error}`);
          }
          samples++;
        }
        handle.cancel();
        original.cancel();
        source.remove();
        target.remove();
        count++;
      }
      function elements() {
        return [0, 1].map(() => {
          const e = document.createElement("div");
          e.style.cssText =
            "position:fixed;left:300px;top:350px;width:120px;height:120px;transform-origin:60px 60px;background:red";
          document.body.append(e);
          return e;
        });
      }
      for (const ts of transforms)
        for (const easing of easings)
          for (const direction of directions) {
            const [a, b] = elements();
            a.animate(
              ts.map((transform, i) => ({
                transform,
                opacity: [0, 0.85, 1][i],
                offset: [0, 0.55, 1][i],
              })),
              {
                duration: 1300,
                delay: 50,
                endDelay: 100,
                iterations: 2,
                iterationStart: 0.2,
                direction,
                easing,
                fill: "both",
              },
            );
            compare(
              a,
              b,
              Array.from({ length: 26 }, (_, i) => i * 115),
            );
          }
      const style = document.createElement("style");
      style.textContent =
        "@keyframes parityCss{0%{opacity:0;transform:translateY(30px)}55%{opacity:.9;transform:translateY(-5px)}100%{opacity:1;transform:translateY(0px)}}";
      document.head.append(style);
      for (const easing of ["ease", "linear"]) {
        const [a, b] = elements();
        a.style.animation = `parityCss 1300ms ${easing} both`;
        compare(
          a,
          b,
          Array.from({ length: 26 }, (_, i) => i * 60),
        );
      }
      style.remove();
      return { count, samples, maxError };
    });
    report.parityCases = result.count;
    report.samplePoints = result.samples;
    report.maxAbsoluteError = result.maxError;
    return result;
  });
  await check(
    "independent JavaScript export, target collision, cleanup, reduced motion",
    async () => {
      exported = await parity.evaluate(
        (r) => MotionCore.exportJavaScript(r),
        recipe,
      );
      await writeFile(join(output, "exported-motion.js"), exported);
      const consumer = await context.newPage();
      await consumer.goto(`${base}/fixtures/consumer-app/`);
      await consumer.addScriptTag({ content: exported });
      const result = await consumer.evaluate(() => {
        const target = document.querySelector("#target");
        const before = target.getAttribute("style");
        const h = window.motionPaste(target);
        h.animation.pause();
        h.animation.currentTime = 650;
        const opacity = Number(getComputedStyle(target).opacity);
        let conflict = "";
        try {
          window.motionPaste(target);
        } catch (e) {
          conflict = e.code || e.message;
        }
        h.cancel();
        return {
          opacity,
          conflict,
          before,
          after: target.getAttribute("style"),
          animations: target.getAnimations().length,
          corePresent: typeof window.MotionCore,
        };
      });
      assert.ok(result.opacity > 0);
      assert.ok(result.conflict);
      assert.equal(result.animations, 0);
      assert.equal(result.corePresent, "undefined");
      assert.equal(result.after || "", result.before || "");
      await consumer.emulateMedia({ reducedMotion: "reduce" });
      assert.equal(
        await consumer.evaluate(() => {
          try {
            window.motionPaste(document.querySelector("#target"));
            return false;
          } catch {
            return true;
          }
        }),
        true,
      );
      await consumer.emulateMedia({ reducedMotion: "no-preference" });
      await consumer.screenshot({ path: join(output, "consumer.png") });
      return result;
    },
  );
  assert.deepEqual(report.errors, []);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.failure = String(error.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
  await writeFile(
    join(output, "browser-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    `REPORT ${report.status}: ${join(output, "browser-report.json")}`,
  );
}
