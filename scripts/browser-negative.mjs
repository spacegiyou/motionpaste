import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";

const output = resolve("artifacts/verification/browser-negative-report.json");
const report = {
  measuredAt: new Date().toISOString(),
  scope:
    "Independent actual Chromium guard tests against the current compiled core. Each case uses a fresh browser context. CSS cross-origin responses are local Playwright route fixtures; no remote content is fetched. This is not an extension or public-site test.",
  status: "RUNNING",
  checks: [],
  errors: [],
};
const bundled = await build({
  entryPoints: ["src/core/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "MotionCore",
  target: "chrome120",
  minify: false,
  keepNames: false,
});
const cases = [
  ["transition", "TRANSITION"],
  ["infinite-iterations", "NUMBER"],
  ["playback-rate", "PLAYBACK_RATE"],
  ["fill-none", "FILL_UNSUPPORTED"],
  ["color", "UNSUPPORTED_PROPERTY"],
  ["multiple", "MULTIPLE_ANIMATIONS"],
  ["additive", "COMPOSITE"],
  ["frame-additive", "COMPOSITE"],
  ["percentage", "TRANSFORM"],
  ["3d", "TRANSFORM"],
  ["implicit-transform-start", "ENDPOINTS"],
  ["implicit-opacity-end", "ENDPOINTS"],
  ["source-inline-transform-important", "IMPORTANT_STYLE"],
  ["source-inline-opacity-important", "IMPORTANT_STYLE"],
  ["source-stylesheet-transform-important", "IMPORTANT_STYLE"],
  ["source-stylesheet-opacity-important", "IMPORTANT_STYLE"],
  ["target-inline-transform-important", "IMPORTANT_STYLE"],
  ["target-inline-opacity-important", "IMPORTANT_STYLE"],
  ["target-stylesheet-transform-important", "IMPORTANT_STYLE"],
  ["target-stylesheet-opacity-important", "IMPORTANT_STYLE"],
  ["source-scoped-opacity-important", "IMPORTANT_STYLE"],
  ["target-scoped-opacity-important", "IMPORTANT_STYLE"],
  ["source-scoped-nested-transform-important", "IMPORTANT_STYLE"],
  ["target-scoped-nested-transform-important", "IMPORTANT_STYLE"],
  ["source-unreadable-stylesheet", "STYLESHEET_ACCESS"],
  ["target-unreadable-stylesheet", "STYLESHEET_ACCESS"],
  ["shadow-ancestor", "CONTEXT"],
  ["ancestor-perspective", "CONTEXT"],
  ["target-conflict", "TARGET_CONFLICT"],
  ["reduced-motion", "REDUCED_MOTION"],
  ["cleanup-inline-origin", null],
  ["cleanup-no-origin", null],
  ["source-unchanged", null],
];
let browser;
try {
  browser = await chromium.launch(
    process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH, headless: true }
      : { channel: "chromium", headless: true },
  );
  report.browser = browser.version();
  report.node = process.version;
  report.platform = process.platform;
  report.playwright = JSON.parse(
    await readFile("node_modules/playwright/package.json", "utf8"),
  ).version;
  for (const [scenario, expectedCode] of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests = [];
    try {
      await context.route("**/*", async (route) => {
        const url = route.request().url();
        requests.push(url);
        if (url === "http://motionpaste-fixture.test/") {
          const unreadable = scenario.includes("unreadable-stylesheet");
          await route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><head>${unreadable ? '<link rel="stylesheet" href="http://motionpaste-css.test/unreadable.css">' : ""}<style>#source,#target{width:100px;height:80px;background:teal}</style></head><body><div id="source"></div><div id="target"></div></body></html>`,
          });
        } else if (url === "http://motionpaste-css.test/unreadable.css") {
          await route.fulfill({
            contentType: "text/css",
            body: ".other { color: green; }",
          });
        } else {
          await route.abort();
        }
      });
      await page.goto("http://motionpaste-fixture.test/");
      await page.addScriptTag({ content: bundled.outputFiles[0].text });
      if (scenario === "reduced-motion") {
        await page.emulateMedia({ reducedMotion: "reduce" });
      }
      const details = await page.evaluate(async (scenario) => {
        let source = document.querySelector("#source");
        const target = document.querySelector("#target");
        let frames = [
          { transform: "translateX(0px)", opacity: 0.2 },
          { transform: "translateX(80px)", opacity: 1 },
        ];
        const timing = { duration: 1000, fill: "both" };
        if (scenario === "infinite-iterations") timing.iterations = Infinity;
        if (scenario === "fill-none") timing.fill = "none";
        if (scenario === "color") {
          frames[0].backgroundColor = "red";
          frames[1].backgroundColor = "blue";
        }
        if (scenario === "additive") timing.composite = "add";
        if (scenario === "frame-additive") frames[0].composite = "add";
        if (scenario === "percentage") frames[1].transform = "translateX(50%)";
        if (scenario === "3d") frames[1].transform = "rotateX(30deg)";
        if (scenario === "implicit-transform-start") {
          frames = [
            { offset: 0, opacity: 0.2 },
            { offset: 1, transform: "translateX(80px)", opacity: 1 },
          ];
        }
        if (scenario === "implicit-opacity-end") {
          frames = [
            { offset: 0, transform: "translateX(0px)", opacity: 0.2 },
            { offset: 1, transform: "translateX(80px)" },
          ];
        }
        if (scenario === "shadow-ancestor") {
          const host = document.createElement("section");
          host.style.cssText = "perspective:500px;transform-style:preserve-3d";
          document.body.append(host);
          const shadow = host.attachShadow({ mode: "open" });
          shadow.append(source);
        }
        if (scenario === "ancestor-perspective") {
          document.body.style.perspective = "500px";
        }
        let animation;
        if (scenario === "transition") {
          source.style.transition = "none";
          source.style.opacity = "0";
          getComputedStyle(source).opacity;
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          source.style.transition = "opacity 1s linear";
          getComputedStyle(source).opacity;
          source.style.opacity = "1";
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await new Promise((resolve) => requestAnimationFrame(resolve));
          animation = source.getAnimations()[0];
          if (!animation || !("transitionProperty" in animation)) {
            throw new Error("Fixture did not create a real CSS transition.");
          }
        } else {
          animation = source.animate(frames, timing);
        }
        animation.pause();
        animation.currentTime = 333;
        if (scenario === "playback-rate") animation.playbackRate = 2;
        if (scenario === "multiple") {
          const extra = source.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            timing,
          );
          extra.pause();
          extra.currentTime = 333;
        }
        const targetScenario = scenario.startsWith("target-");
        const capturedRecipe =
          targetScenario && !scenario.includes("unreadable-stylesheet")
            ? MotionCore.captureMotion(source)
            : null;
        if (scenario.includes("important")) {
          const element = targetScenario ? target : source;
          const property = scenario.includes("transform")
            ? "transform"
            : "opacity";
          const value = property === "transform" ? "none" : ".9";
          if (scenario.includes("inline")) {
            element.style.setProperty(property, value, "important");
          } else {
            const style = document.createElement("style");
            if (scenario.includes("scoped")) {
              const wrapper = document.createElement("section");
              wrapper.className = "wrapper";
              document.body.append(wrapper);
              wrapper.append(element);
              const rule = `:scope #${element.id} { ${property}: ${value} !important; }`;
              style.textContent = `@scope (.wrapper) { ${scenario.includes("nested") ? `@media all { ${rule} }` : rule} }`;
            } else {
              style.textContent = `#${element.id} { ${property}: ${value} !important; }`;
            }
            document.head.append(style);
            if (
              scenario.includes("scoped") &&
              getComputedStyle(element).getPropertyValue(property) !==
                (property === "opacity" ? "0.9" : "none")
            ) {
              throw new Error(
                "Scoped !important fixture did not override the animated property.",
              );
            }
          }
        }
        if (scenario === "target-conflict") {
          const conflict = target.animate(
            [{ opacity: 0 }, { opacity: 1 }],
            timing,
          );
          conflict.pause();
        }
        if (scenario === "cleanup-inline-origin") {
          target.style.setProperty(
            "transform-origin",
            "12px 23px",
            "important",
          );
        }
        const snapshot = () => ({
          html: source.outerHTML,
          animations: source.getAnimations().map((item) => ({
            timing: JSON.stringify(item.effect.getTiming()),
            frames: JSON.stringify(item.effect.getKeyframes()),
            currentTime: item.currentTime,
            playbackRate: item.playbackRate,
            playState: item.playState,
          })),
        });
        const before = snapshot();
        const targetBefore = {
          value: target.style.getPropertyValue("transform-origin"),
          priority: target.style.getPropertyPriority("transform-origin"),
          animations: target.getAnimations().length,
        };
        let code = null;
        let phase = "capture";
        let message = null;
        let handle;
        let midpoint = null;
        let unreadableConfirmed = false;
        if (scenario.includes("unreadable-stylesheet")) {
          try {
            void document.styleSheets[0].cssRules;
          } catch (error) {
            unreadableConfirmed = error.name === "SecurityError";
          }
          if (!unreadableConfirmed) {
            throw new Error("Fixture did not create an unreadable stylesheet.");
          }
        }
        try {
          // The target-only unreadable stylesheet case uses known data because
          // a source capture on the same page must also fail closed.
          const recipe =
            scenario === "target-unreadable-stylesheet"
              ? {
                  version: 1,
                  status: "captured",
                  keyframes: frames.map((frame, index) => ({
                    ...frame,
                    offset: index,
                    easing: "linear",
                  })),
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
                  context: { transformOrigin: "50px 40px" },
                  originalDuration: 1000,
                }
              : (capturedRecipe ?? MotionCore.captureMotion(source));
          if (
            targetScenario ||
            scenario.startsWith("cleanup-") ||
            scenario === "reduced-motion" ||
            scenario === "source-unchanged"
          ) {
            phase = "replay";
            handle = MotionCore.replayMotion(target, recipe);
            handle.animation.pause();
            handle.animation.currentTime = 333;
            midpoint = {
              source: {
                opacity: getComputedStyle(source).opacity,
                transform: getComputedStyle(source).transform,
              },
              target: {
                opacity: getComputedStyle(target).opacity,
                transform: getComputedStyle(target).transform,
              },
            };
          }
        } catch (error) {
          code = error.code ?? error.name;
          message = error.message;
        } finally {
          handle?.cancel();
          handle?.cancel();
        }
        const after = snapshot();
        const targetAfter = {
          value: target.style.getPropertyValue("transform-origin"),
          priority: target.style.getPropertyPriority("transform-origin"),
          animations: target.getAnimations().length,
        };
        return {
          code,
          phase,
          message,
          before,
          after,
          targetBefore,
          targetAfter,
          midpoint,
          unreadableConfirmed,
        };
      }, scenario);
      assert.equal(details.code, expectedCode, details.message ?? scenario);
      if (scenario.startsWith("target-")) assert.equal(details.phase, "replay");
      assert.deepEqual(
        details.after,
        details.before,
        "Source must remain unchanged.",
      );
      assert.deepEqual(
        details.targetAfter,
        details.targetBefore,
        "Target must be unchanged or cleaned up.",
      );
      if (expectedCode === null) {
        assert.deepEqual(details.midpoint?.source, details.midpoint?.target);
      }
      report.checks.push({
        name: scenario,
        status: "PASS",
        expectedCode,
        actualCode: details.code,
        phase: details.phase,
        sourceUnchanged: true,
        targetRestored: true,
        ...(details.midpoint ? { midpoint: details.midpoint } : {}),
        ...(scenario.includes("unreadable-stylesheet")
          ? {
              unreadableConfirmed: details.unreadableConfirmed,
              fixtureRequests: requests,
            }
          : {}),
      });
      console.log(`PASS ${scenario}`);
    } catch (error) {
      report.checks.push({
        name: scenario,
        status: "FAIL",
        expectedCode,
        error: String(error.stack ?? error),
      });
      console.error(`FAIL ${scenario}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
  const regressions = [
    "invalid-css-numbers",
    "opacity-only-rotated-target",
    "opacity-only-origin-transition",
    "cleanup-external-origin-value",
    "cleanup-external-origin-priority",
    "cleanup-external-origin-removal",
    "queued-cancel-new-handle",
    "queued-cancel-new-export",
    "failed-animate-owned-origin",
    "failed-animate-external-origin",
    "browser-transform-preflight",
    "browser-frame-easing-preflight",
    "browser-timing-easing-preflight",
  ];
  for (const mode of ["internal", "exported"]) {
    for (const scenario of regressions) {
      const name = `${mode}/${scenario}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.setContent(
          '<div id="target" style="width:100px;height:80px;transform:rotate(30deg);transform-origin:10px 20px !important"></div>',
        );
        await page.addScriptTag({ content: bundled.outputFiles[0].text });
        const details = await page.evaluate(
          async ({ mode, scenario }) => {
            const target = document.querySelector("#target");
            const recipe = {
              version: 1,
              status: "captured",
              keyframes: [
                {
                  offset: 0,
                  easing: "ease-in",
                  transform: "translateX(0px)",
                  opacity: 0.2,
                },
                {
                  offset: 1,
                  easing: "linear",
                  transform: "translateX(80px)",
                  opacity: 1,
                },
              ],
              timing: {
                duration: 1000,
                delay: 0,
                endDelay: 0,
                iterations: 1,
                iterationStart: 0,
                direction: "normal",
                easing: "ease-out",
                fill: "both",
              },
              context: { transformOrigin: "70px 60px" },
              originalDuration: 1000,
            };
            const check = (condition, message) => {
              if (!condition) throw new Error(message);
            };
            const origin = () => ({
              value: target.style.getPropertyValue("transform-origin"),
              priority: target.style.getPropertyPriority("transform-origin"),
            });
            const initialOrigin = origin();
            const initialHTML = target.outerHTML;
            const sameOrigin = (expected) =>
              JSON.stringify(origin()) === JSON.stringify(expected);
            const bbox = () => {
              const rect = target.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              };
            };
            const loadExport = () => {
              const script = document.createElement("script");
              script.textContent = MotionCore.exportJavaScript(recipe);
              document.head.append(script);
              return window.motionPaste;
            };
            if (scenario === "invalid-css-numbers") {
              const checks = [];
              for (const [property, value, expectedCode] of [
                ["transform", "translateX(1.px)", "TRANSFORM"],
                ["transform", "rotate(1.deg)", "TRANSFORM"],
                ["transform", "scale(1.)", "TRANSFORM"],
                ["transform", "matrix(1., 0, 0, 1, 0, 0)", "TRANSFORM"],
                [
                  "animation-timing-function",
                  "cubic-bezier(0., 0, 1, 1)",
                  "EASING",
                ],
                ["transform-origin", "1.px 2px", "CONTEXT"],
              ]) {
                const input = structuredClone(recipe);
                if (property === "transform")
                  input.keyframes[0].transform = value;
                else if (property === "transform-origin")
                  input.context.transformOrigin = value;
                else input.timing.easing = value;
                const browserSupports = CSS.supports(property, value);
                check(
                  !browserSupports,
                  `Invalid CSS fixture became valid: ${value}`,
                );
                let code = null;
                try {
                  if (mode === "exported") MotionCore.exportJavaScript(input);
                  else MotionCore.replayMotion(target, input);
                } catch (error) {
                  code = error.code;
                }
                check(
                  code === expectedCode,
                  `${value}: expected ${expectedCode}, got ${code}`,
                );
                checks.push({ property, value, browserSupports, code });
              }
              check(
                target.outerHTML === initialHTML &&
                  target.getAnimations().length === 0,
                "Invalid CSS mutated target",
              );
              return { checks, targetUnchanged: true };
            }
            if (scenario.startsWith("opacity-only")) {
              for (const frame of recipe.keyframes) delete frame.transform;
              if (scenario.endsWith("origin-transition"))
                target.style.transition = "transform-origin 1s linear";
            }
            let replay =
              mode === "exported"
                ? loadExport()
                : (element) => MotionCore.replayMotion(element, recipe);
            const stop = (handle) => {
              handle.animation.pause();
              handle.animation.currentTime = 500;
            };
            if (scenario.startsWith("opacity-only")) {
              const before = bbox();
              const mutations = [];
              const observer = new MutationObserver((records) =>
                mutations.push(...records),
              );
              observer.observe(target, {
                attributes: true,
                attributeFilter: ["style"],
              });
              const handle = replay(target);
              stop(handle);
              const during = bbox();
              const opacity = Number(getComputedStyle(target).opacity);
              handle.cancel();
              handle.cancel();
              await Promise.resolve();
              mutations.push(...observer.takeRecords());
              observer.disconnect();
              check(
                Object.keys(before).every(
                  (key) => Math.abs(before[key] - during[key]) < 0.001,
                ),
                "Opacity replay moved or resized a rotated target",
              );
              check(
                sameOrigin(initialOrigin) && mutations.length === 0,
                "Opacity-only playback wrote inline styles",
              );
              check(
                opacity > 0.2 && opacity < 1,
                "Opacity-only animation did not run",
              );
              check(
                target.getAnimations().length === 0,
                "Opacity cleanup leaked animation",
              );
              return {
                before,
                during,
                opacity,
                inlineStyleMutations: mutations.length,
                origin: origin(),
              };
            }
            if (scenario.startsWith("cleanup-external")) {
              const handle = replay(target);
              stop(handle);
              if (scenario.endsWith("removal"))
                target.style.removeProperty("transform-origin");
              else
                target.style.setProperty(
                  "transform-origin",
                  scenario.endsWith("priority") ? "70px 60px" : "3px 4px",
                );
              const expected = origin();
              handle.cancel();
              check(
                sameOrigin(expected),
                "Cleanup overwrote an external active origin edit",
              );
              target.style.setProperty("transform-origin", "7px 8px");
              handle.cancel();
              await new Promise((resolve) => requestAnimationFrame(resolve));
              check(
                sameOrigin({ value: "7px 8px", priority: "" }),
                "Repeated cleanup overwrote a later origin edit",
              );
              check(
                target.getAnimations().length === 0,
                "Cleanup leaked animation",
              );
              return {
                preservedActiveEdit: expected,
                preservedLaterEdit: origin(),
              };
            }
            if (scenario.startsWith("queued-cancel")) {
              const first = replay(target);
              stop(first);
              await first.animation.ready;
              const cancelled = new Promise((resolve) =>
                first.animation.addEventListener("cancel", resolve, {
                  once: true,
                }),
              );
              first.animation.cancel();
              if (scenario.endsWith("new-export")) replay = loadExport();
              const second = replay(target);
              stop(second);
              await Promise.race([
                cancelled,
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(new Error("Browser cancel event did not arrive")),
                    2000,
                  ),
                ),
              ]);
              first.cancel();
              const during = origin();
              check(
                sameOrigin({ value: "70px 60px", priority: "important" }),
                "Old queued cancel event overwrote newer handle",
              );
              second.cancel();
              check(
                sameOrigin(initialOrigin),
                "Newer handle restored an obsolete origin",
              );
              check(
                target.getAnimations().length === 0,
                "Queued cancellation leaked animation",
              );
              return {
                cancelEventObserved: true,
                separateExportRuntime: scenario.endsWith("new-export"),
                during,
                restored: origin(),
              };
            }
            let animateCalls = 0;
            const originalAnimate = target.animate;
            const originalSupports = CSS.supports;
            let expectedOrigin = initialOrigin;
            let expectedCode = "PLAYBACK";
            let capabilityProbe = null;
            if (scenario.startsWith("failed-animate")) {
              target.animate = () => {
                animateCalls++;
                if (scenario.endsWith("external-origin")) {
                  target.style.setProperty("transform-origin", "7px 8px");
                  expectedOrigin = origin();
                }
                throw new Error("Forced animate failure");
              };
            } else {
              const property =
                scenario === "browser-transform-preflight"
                  ? "transform"
                  : "animation-timing-function";
              const value =
                scenario === "browser-transform-preflight"
                  ? "translateX(80px)"
                  : scenario === "browser-frame-easing-preflight"
                    ? "ease-in"
                    : "ease-out";
              expectedCode = property === "transform" ? "TRANSFORM" : "EASING";
              check(
                originalSupports.call(CSS, property, value),
                "Preflight fixture should normally be browser-supported",
              );
              capabilityProbe = {
                property,
                value,
                actualBrowserSupport: true,
                simulatedRejection: true,
              };
              CSS.supports = (name, data) =>
                name === property && data === value
                  ? false
                  : originalSupports.call(CSS, name, data);
              target.animate = (...args) => {
                animateCalls++;
                return originalAnimate.apply(target, args);
              };
            }
            let code = null;
            try {
              replay(target);
            } catch (error) {
              code = error.code;
            } finally {
              target.animate = originalAnimate;
              CSS.supports = originalSupports;
            }
            check(
              code === expectedCode,
              `Expected ${expectedCode}, got ${code}`,
            );
            check(
              sameOrigin(expectedOrigin),
              "Failed playback overwrote or leaked origin",
            );
            check(
              target.getAnimations().length === 0,
              "Failed playback leaked animation",
            );
            check(
              animateCalls === (scenario.startsWith("failed-animate") ? 1 : 0),
              "CSS preflight happened after animate",
            );
            return {
              code,
              animateCalls,
              restoredOrPreserved: origin(),
              ...(capabilityProbe ? { capabilityProbe } : {}),
            };
          },
          { mode, scenario },
        );
        report.checks.push({ name, status: "PASS", ...details });
        console.log(`PASS ${name}`);
      } catch (error) {
        report.checks.push({
          name,
          status: "FAIL",
          error: String(error.stack ?? error),
        });
        console.error(`FAIL ${name}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
  }
  report.status = report.checks.every((check) => check.status === "PASS")
    ? "PASS"
    : "FAIL";
} catch (error) {
  report.status = "FAIL";
  report.errors.push(String(error.stack ?? error));
} finally {
  await browser?.close();
  await mkdir(resolve("artifacts/verification"), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(`REPORT ${report.status}: ${output}`);
  if (report.status !== "PASS") process.exitCode = 1;
}
