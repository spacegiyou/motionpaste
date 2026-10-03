import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import { archivePath, version } from "./release-info.mjs";
import {
  resolveExportFixturePlan,
  validateEvidenceContent,
} from "./evidence-content-guard.mjs";

// The oracle is the browser rendering these independently authored animations.
// No expected sample is derived from captured or exported recipe keyframes.
const transformFrames = [
  {
    offset: 0,
    transform: "translate(-47px, 18px) rotate(-19deg) scale(0.73, 0.91)",
    opacity: 0.12,
  },
  {
    offset: 0.37,
    transform: "translate(31px, -23px) rotate(27deg) scale(1.14, 0.84)",
    opacity: 0.79,
  },
  {
    offset: 1,
    transform: "translate(8px, 11px) rotate(4deg) scale(0.96, 1.08)",
    opacity: 0.48,
  },
];
const cssFrames = `
  0% { transform: translate(-47px, 18px) rotate(-19deg) scale(0.73, 0.91); opacity: .12; }
  37% { transform: translate(31px, -23px) rotate(27deg) scale(1.14, .84); opacity: .79; }
  100% { transform: translate(8px, 11px) rotate(4deg) scale(.96, 1.08); opacity: .48; }
`;
const fixtures = [
  { id: "css-linear-733", kind: "css", cssFrames, timing: { duration: 733 } },
  {
    id: "css-reverse-delay-2333",
    kind: "css",
    cssFrames,
    timing: {
      duration: 2333,
      direction: "reverse",
      delay: 163,
      easing: "ease-in-out",
    },
  },
  {
    id: "css-alternate-negative-delay",
    kind: "css",
    cssFrames,
    timing: {
      duration: 977,
      iterations: 3,
      direction: "alternate",
      delay: -283,
    },
  },
  {
    id: "css-alternate-reverse-fractional",
    kind: "css",
    cssFrames,
    timing: {
      duration: 811,
      iterations: 2.5,
      direction: "alternate-reverse",
      delay: 111,
      easing: "cubic-bezier(.17,.78,.64,.23)",
    },
  },
  {
    id: "css-steps-jump-start",
    kind: "css",
    cssFrames,
    steps: 5,
    timing: { duration: 733, easing: "steps(5, jump-start)" },
  },
  {
    id: "css-per-keyframe-easing",
    kind: "css",
    cssFrames: `0% { transform: translateX(-80px) rotate(-15deg); opacity: .2; animation-timing-function: cubic-bezier(.21,.91,.62,.17); } 43% { transform: translateX(35px) rotate(36deg); opacity: .9; animation-timing-function: steps(4, end); } 100% { transform: translateX(5px) rotate(-4deg); opacity: .45; }`,
    timing: { duration: 2333, delay: 67 },
  },
  {
    id: "waapi-normal-733",
    kind: "waapi",
    frames: transformFrames,
    timing: { duration: 733 },
  },
  {
    id: "waapi-reverse-positive-end-delay",
    kind: "waapi",
    frames: transformFrames,
    timing: {
      duration: 2333,
      direction: "reverse",
      delay: 91,
      endDelay: 217,
      easing: "ease-out",
    },
  },
  {
    id: "waapi-alternate-negative-end-delay",
    kind: "waapi",
    frames: transformFrames,
    timing: {
      duration: 887,
      iterations: 3,
      direction: "alternate",
      delay: -193,
      endDelay: -431,
    },
  },
  {
    id: "waapi-alternate-reverse-iteration-start",
    kind: "waapi",
    frames: transformFrames,
    timing: {
      duration: 733,
      iterations: 2.5,
      iterationStart: 0.27,
      direction: "alternate-reverse",
      delay: 119,
      endDelay: 101,
    },
  },
  {
    id: "waapi-fractional-iteration-start",
    kind: "waapi",
    frames: transformFrames,
    timing: {
      duration: 2333,
      iterations: 1.75,
      iterationStart: 0.43,
      delay: -157,
      easing: "cubic-bezier(0.31, -0.2, 0.72, 1.2)",
    },
  },
  {
    id: "waapi-steps-jump-none",
    kind: "waapi",
    frames: transformFrames,
    steps: 7,
    timing: { duration: 733, iterations: 2, easing: "steps(7, jump-none)" },
  },
  {
    id: "waapi-steps-jump-both-reverse",
    kind: "waapi",
    frames: transformFrames,
    steps: 6,
    timing: {
      duration: 2333,
      direction: "reverse",
      easing: "steps(6, jump-both)",
      delay: 73,
    },
  },
  {
    id: "waapi-sparse-interior-properties",
    kind: "waapi",
    frames: [
      {
        offset: 0,
        transform: "translate(-41px, 12px) rotate(-13deg)",
        opacity: 0.15,
      },
      { offset: 0.23, opacity: 0.86, easing: "ease-in" },
      {
        offset: 0.61,
        transform: "translate(53px, -9px) rotate(33deg)",
        easing: "ease-out",
      },
      {
        offset: 1,
        transform: "translate(7px, 19px) rotate(8deg)",
        opacity: 0.39,
      },
    ],
    timing: { duration: 733, delay: 29 },
  },
  {
    id: "waapi-duplicate-interior-offset",
    kind: "waapi",
    frames: [
      { offset: 0, transform: "translateX(-50px)", opacity: 0.18 },
      { offset: 0.5, transform: "translateX(45px)", opacity: 0.88 },
      {
        offset: 0.5,
        transform: "translateX(-24px) rotate(21deg)",
        opacity: 0.31,
      },
      { offset: 1, transform: "translateX(10px) rotate(-8deg)", opacity: 0.63 },
    ],
    timing: {
      duration: 2333,
      iterations: 2,
      direction: "alternate",
      delay: 43,
    },
  },
  {
    id: "waapi-matrix-transform-only",
    kind: "waapi",
    frames: [
      { offset: 0, transform: "matrix(0.83, -0.22, 0.17, 1.08, -29, 17)" },
      {
        offset: 0.41,
        transform: "matrix(1.12, 0.31, -0.24, 0.89, 46, -23)",
        easing: "ease-in-out",
      },
      { offset: 1, transform: "matrix(0.97, 0.07, -0.09, 1.03, 13, 9)" },
    ],
    timing: { duration: 733, endDelay: -87 },
    baseOpacity: 0.62,
  },
  {
    id: "waapi-opacity-only-prerotated-origin",
    kind: "waapi",
    frames: [
      { offset: 0, opacity: 0.13 },
      { offset: 0.29, opacity: 0.93, easing: "ease-out" },
      { offset: 1, opacity: 0.38 },
    ],
    timing: { duration: 733, delay: 103 },
    baseTransform: "rotate(31deg) translate(17px, -9px)",
    origin: "83px 47px",
    captureOrigin: "7px 11px",
  },
  {
    id: "css-opacity-only-prerotated-origin",
    kind: "css",
    cssFrames:
      "0% { opacity: .17; } 63% { opacity: .89; } 100% { opacity: .42; }",
    timing: { duration: 2333, direction: "reverse", delay: -139 },
    baseTransform: "translate(-11px, 13px) rotate(-27deg) scale(.93, 1.07)",
    origin: "91px 23px",
    captureOrigin: "13px 71px",
  },
];
const defaults = {
  delay: 0,
  endDelay: 0,
  iterations: 1,
  iterationStart: 0,
  direction: "normal",
  easing: "linear",
  fill: "both",
};
for (const fixture of fixtures)
  fixture.timing = { ...defaults, ...fixture.timing };
const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
const expectedVersion = process.env.MOTIONPASTE_EXPECTED_VERSION || version;
const archive = resolve(process.env.MOTIONPASTE_ARCHIVE || archivePath);
const output = resolve("artifacts/verification/export-parity-report.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const tolerance = { opacity: 0.00001, matrix: 0.00001, rect: 0.002 };
const report = {
  measuredAt: new Date().toISOString(),
  status: "RUNNING",
  version: expectedVersion,
  sourcePackageVersion: packageJSON.version,
  archive,
  archiveSHA256: sha(await readFile(archive)),
  scope:
    "Independent source CSS/WAAPI → capture-only temporary bundle → actual release ZIP extension Studio file-import UI → actual Download JavaScript UI → fresh separate Chromium process without an extension or MotionCore. Browser-observed source opacity, DOMMatrix, and rectangle are the oracle at identical currentTime values.",
  method: {
    fixtureOracle:
      "Original CSS rules/WAAPI frames below are authored in this test independently of recipes and downloaded JavaScript. Source animations are observed directly; recipes never supply expected samples.",
    sourceCapture:
      "Only captureMotion from src/core/capture.ts is bundled temporarily. Neither exportJavaScript nor replayMotion is called to produce or execute exported code.",
    uiExport:
      "Each captured recipe is selected through Studio's Import recipe JSON file chooser; the #download-js button produces a browser download. Its saved bytes are executed unchanged.",
    isolation:
      "A fresh persistent profile loads the extracted ZIP. A separate chromium.launch process and a fresh context per case execute the downloaded script without extension flags, extension workers, MotionCore, or SourceCapture.",
    geometry:
      "Source reference and consumer use identical independently authored layout, dimensions, base styles and transform origin. Opacity-only cases deliberately capture under another origin, then restore the authored reference origin: source origin is irrelevant to an opacity-only animation and must not replace the consumer's own origin.",
    samples:
      "Uniform active-time coverage, explicit delay/end-delay/iteration boundaries and ±0.001 ms probes, keyframe offsets, steps boundaries, negative time and post-end time. Both animations are paused and assigned the exact same currentTime.",
    negativeControl:
      "For every case the actual downloaded animation is canceled, leaving finite baseline styles; the same comparator must reject the resulting no-op samples.",
  },
  tolerances: tolerance,
  fixtureCount: fixtures.length,
  cases: [],
  pageErrors: [],
  limitations: [
    "Local independent fixtures in bundled Chromium only; this is not cross-browser, public-site, commercial Chrome or OS coverage.",
    "This matrix tests finite supported CSS/WAAPI effects and the final ZIP's import/export UI. Toolbar capture authorization is covered by the separate archive smoke test.",
    "Source capture uses the current source capture implementation, whose input source hashes are recorded. All positive replay/export evidence comes solely from the archive's downloaded JavaScript.",
  ],
};
const temporary = await mkdtemp(join(tmpdir(), "motionpaste-export-parity-"));
let studioContext;
let sourceBrowser;
let consumerBrowser;
const observedRequests = new Set();

function sampleTimes(timing, fixture) {
  const { duration, delay, endDelay, iterations, iterationStart } = timing;
  const activeEnd = delay + duration * iterations;
  const effectEnd = Math.max(0, activeEnd + endDelay);
  const last = Math.max(0, activeEnd, effectEnd) + 31;
  const values = new Set([-31, -0.001, 0, 0.001, last]);
  const boundary = (value) => {
    for (const delta of [-0.001, 0, 0.001]) values.add(value + delta);
  };
  boundary(delay);
  boundary(activeEnd);
  boundary(effectEnd);
  for (let index = 0; index <= 28; index++)
    values.add(delay + (duration * iterations * index) / 28);
  const offsets =
    fixture.kind === "waapi"
      ? fixture.frames.map((frame) => frame.offset)
      : [0, 0.37, 0.43, 0.63, 1];
  for (
    let iteration = 0;
    iteration <= Math.ceil(iterations + iterationStart);
    iteration++
  ) {
    boundary(delay + (iteration - iterationStart) * duration);
    for (const offset of offsets) {
      const value = delay + (iteration + offset - iterationStart) * duration;
      if (value >= delay && value <= activeEnd) boundary(value);
    }
    if (fixture.steps) {
      for (let step = 0; step <= fixture.steps; step++) {
        const value =
          delay +
          (iteration + step / fixture.steps - iterationStart) * duration;
        if (value >= delay && value <= activeEnd) boundary(value);
      }
    }
  }
  return [...values]
    .filter((time) => time >= Math.min(-31, delay - 1) && time <= last)
    .sort((a, b) => a - b);
}

function compare(source, actual) {
  assert.equal(
    actual.length,
    source.length,
    "Comparator requires paired samples",
  );
  const maxAbsoluteError = { opacity: 0, matrix: 0, rect: 0 };
  const mismatches = [];
  for (let index = 0; index < source.length; index++) {
    const expected = source[index];
    const observed = actual[index];
    assert.equal(observed.time, expected.time, "Sample currentTime must match");
    const errors = {
      opacity: Math.abs(expected.opacity - observed.opacity),
      matrix: Math.max(
        ...expected.matrix.map((value, position) =>
          Math.abs(value - observed.matrix[position]),
        ),
      ),
      rect: Math.max(
        ...expected.rect.map((value, position) =>
          Math.abs(value - observed.rect[position]),
        ),
      ),
    };
    for (const [property, error] of Object.entries(errors)) {
      assert.ok(Number.isFinite(error), `${property} error must be finite`);
      maxAbsoluteError[property] = Math.max(maxAbsoluteError[property], error);
    }
    if (
      Object.entries(errors).some(
        ([property, error]) => error > tolerance[property],
      )
    )
      mismatches.push({ time: expected.time, errors });
  }
  return {
    status: mismatches.length ? "FAIL" : "PASS",
    timepointCount: source.length,
    maxAbsoluteError,
    mismatchCount: mismatches.length,
    firstMismatches: mismatches.slice(0, 8),
  };
}

async function createFixture(page, fixture, animate) {
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; } html, body { margin: 0; padding: 0; }
    #stage { position: absolute; left: 37px; top: 53px; width: 600px; height: 400px; }
    #target { position: absolute; left: 109px; top: 83px; width: 137px; height: 91px; border: 3px solid #243; padding: 7px; background: #39a; }
  </style></head><body><div id="stage"><div id="target">Independent fixture</div></div></body></html>`);
  return page.evaluate(
    async ({ fixture, animate }) => {
      const target = document.querySelector("#target");
      target.style.transform =
        fixture.baseTransform || "rotate(9deg) translate(3px, 5px)";
      target.style.opacity = String(fixture.baseOpacity ?? 0.67);
      target.style.transformOrigin = fixture.origin || "29px 61px";
      if (animate) {
        let animation;
        if (fixture.kind === "css") {
          const style = document.createElement("style");
          style.textContent = `@keyframes independentMotion { ${fixture.cssFrames} }`;
          document.head.append(style);
          const timing = fixture.timing;
          target.style.animationName = "independentMotion";
          target.style.animationDuration = `${timing.duration}ms`;
          target.style.animationDelay = `${timing.delay}ms`;
          target.style.animationIterationCount = String(timing.iterations);
          target.style.animationDirection = timing.direction;
          target.style.animationTimingFunction = timing.easing;
          target.style.animationFillMode = timing.fill;
          animation = target.getAnimations()[0];
        } else animation = target.animate(fixture.frames, fixture.timing);
        animation.pause();
        await animation.ready;
        animation.currentTime = 0;
        window.fixtureAnimation = animation;
        return {
          timing: animation.effect.getTiming(),
          computedTiming: animation.effect.getComputedTiming(),
          animationClass: animation.constructor.name,
        };
      }
      return {
        animations: target.getAnimations().length,
        core: typeof window.MotionCore,
        capture: typeof window.SourceCapture,
        extensionRuntime: typeof window.chrome?.runtime?.id,
      };
    },
    { fixture, animate },
  );
}

async function observe(page, times, suppress = false) {
  return page.evaluate(
    ({ times, suppress }) => {
      const target = document.querySelector("#target");
      const animation = window.fixtureAnimation;
      return times.map((time) => {
        if (!suppress) animation.currentTime = time;
        if (!suppress && Math.abs(animation.currentTime - time) > 0.0000001)
          throw new Error(
            "Browser animation did not accept requested currentTime",
          );
        const style = getComputedStyle(target);
        const matrix = new DOMMatrixReadOnly(
          style.transform === "none" ? undefined : style.transform,
        );
        const rect = target.getBoundingClientRect();
        const values = {
          time,
          opacity: Number(style.opacity),
          matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
          rect: [
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            rect.right,
            rect.bottom,
          ],
          origin: style.transformOrigin,
        };
        if (
          ![values.opacity, ...values.matrix, ...values.rect].every(
            Number.isFinite,
          )
        )
          throw new Error("Nonfinite browser observation");
        return values;
      });
    },
    { times, suppress },
  );
}

try {
  const plannedFixtures = resolveExportFixturePlan(() => fixtures);
  const extracted = join(temporary, "release-extension");
  await mkdir(extracted);
  execFileSync("unzip", ["-q", archive, "-d", extracted]);
  const manifest = JSON.parse(
    await readFile(join(extracted, "manifest.json"), "utf8"),
  );
  report.manifestVersion = manifest.version;
  report.manifestVersionName = manifest.version_name;
  assert.equal(manifest.version_name, expectedVersion);
  assert.equal(
    (await readFile(`${archive}.sha256`, "utf8")).split(/\s+/)[0],
    report.archiveSHA256,
  );
  const members = JSON.parse(
    await readFile(join(extracted, "SHA256SUMS.json"), "utf8"),
  );
  for (const [file, digest] of Object.entries(members))
    assert.equal(
      sha(await readFile(join(extracted, file))),
      digest,
      `Archive member ${file}`,
    );
  report.verifiedArchiveMembers = Object.keys(members).length;
  report.archiveStudioSHA256 = members["studio.js"];
  assert.deepEqual([...manifest.permissions].sort(), [
    "activeTab",
    "scripting",
    "storage",
  ]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  const capturePath = join(temporary, "source-capture-only.js");
  await build({
    entryPoints: ["src/core/capture.ts"],
    outfile: capturePath,
    bundle: true,
    format: "iife",
    globalName: "SourceCapture",
    target: "chrome120",
  });
  report.sourceCapture = {
    bundleSHA256: sha(await readFile(capturePath)),
    sourceSHA256: {},
  };
  for (const file of [
    "src/core/capture.ts",
    "src/core/runtime.ts",
    "src/core/types.ts",
  ])
    report.sourceCapture.sourceSHA256[file] = sha(await readFile(file));
  studioContext = await chromium.launchPersistentContext(
    join(temporary, "fresh-extension-profile"),
    {
      channel: "chromium",
      headless: true,
      acceptDownloads: true,
      viewport: { width: 1440, height: 1000 },
      args: [`--load-extension=${extracted}`],
      ignoreDefaultArgs: ["--disable-extensions"],
    },
  );
  sourceBrowser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  consumerBrowser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  report.environment = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    playwright: JSON.parse(
      await readFile("node_modules/playwright/package.json", "utf8"),
    ).version,
    extensionBrowser: studioContext.browser().version(),
    sourceBrowser: sourceBrowser.version(),
    consumerBrowser: consumerBrowser.version(),
    separateBrowserProcesses: true,
  };
  studioContext.on("request", (request) => observedRequests.add(request.url()));
  const worker =
    studioContext.serviceWorkers()[0] ||
    (await studioContext.waitForEvent("serviceworker"));
  const extensionId = new URL(worker.url()).hostname;
  const sourceContext = await sourceBrowser.newContext({
    viewport: { width: 1200, height: 900 },
    reducedMotion: "no-preference",
    deviceScaleFactor: 1,
  });
  for (const fixture of plannedFixtures) {
    const caseReport = {
      id: fixture.id,
      status: "RUNNING",
      authoredFixture: fixture,
      fixtureSHA256: sha(JSON.stringify(fixture)),
    };
    report.cases.push(caseReport);
    let source;
    let studio;
    let consumerContext;
    try {
      source = await sourceContext.newPage();
      source.on("pageerror", (error) =>
        report.pageErrors.push({
          case: fixture.id,
          surface: "source",
          error: String(error),
        }),
      );
      const actualSource = await createFixture(source, fixture, true);
      caseReport.source = actualSource;
      assert.deepEqual(
        actualSource.timing,
        {
          ...fixture.timing,
          // CSS animation-timing-function lives on its resolved keyframes;
          // CSSAnimation's effect-level easing remains linear.
          easing: fixture.kind === "css" ? "linear" : fixture.timing.easing,
        },
        "Browser source timing must equal independently authored timing",
      );
      await source.addScriptTag({ path: capturePath });
      const captured = await source.evaluate((fixture) => {
        const target = document.querySelector("#target");
        const localOrigin = target.style.transformOrigin;
        if (fixture.captureOrigin)
          target.style.transformOrigin = fixture.captureOrigin;
        const captureOrigin = getComputedStyle(target).transformOrigin;
        const recipe = window.SourceCapture.captureMotion(target);
        target.style.transformOrigin = localOrigin;
        return {
          recipe,
          captureOrigin,
          referenceOrigin: getComputedStyle(target).transformOrigin,
        };
      }, fixture);
      caseReport.capture = {
        recipeSHA256: sha(JSON.stringify(captured.recipe)),
        keyframeCount: captured.recipe.keyframes.length,
        captureOrigin: captured.captureOrigin,
        referenceOrigin: captured.referenceOrigin,
      };
      const times = sampleTimes(actualSource.timing, fixture);
      const sourceSamples = await observe(source, times);
      studio = await studioContext.newPage();
      studio.on("pageerror", (error) =>
        report.pageErrors.push({
          case: fixture.id,
          surface: "studio",
          error: String(error),
        }),
      );
      await studio.goto(`chrome-extension://${extensionId}/studio.html`);
      const fileChooserPromise = studio.waitForEvent("filechooser");
      await studio.locator("#import-button").click();
      await (
        await fileChooserPromise
      ).setFiles({
        name: `${fixture.id}.json`,
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify(captured.recipe)),
      });
      await studio.waitForFunction(
        () =>
          !document.querySelector("#download-js").disabled ||
          !document.querySelector("#error-message").hidden,
      );
      assert.equal(
        await studio.locator("#error-message").isVisible(),
        false,
        await studio.locator("#error-message").textContent(),
      );
      caseReport.ui = {
        url: studio.url(),
        importState: await studio.locator("#recipe-state").textContent(),
        durationInput: await studio.locator("#duration-input").inputValue(),
        durationSlider: await studio.locator("#duration-slider").inputValue(),
      };
      assert.equal(
        Number(caseReport.ui.durationInput),
        fixture.timing.duration,
        "UI preserves off-grid duration",
      );
      const downloadPromise = studio.waitForEvent("download");
      await studio.locator("#download-js").click();
      const download = await downloadPromise;
      const downloadedPath = join(temporary, `${fixture.id}.js`);
      await download.saveAs(downloadedPath);
      const downloaded = await readFile(downloadedPath, "utf8");
      caseReport.download = {
        suggestedFilename: download.suggestedFilename(),
        javascriptSHA256: sha(downloaded),
        bytes: Buffer.byteLength(downloaded),
        matchesVisibleCode:
          downloaded === (await studio.locator("#code-output").textContent()),
      };
      assert.match(downloaded, /window\.motionPaste/);
      consumerContext = await consumerBrowser.newContext({
        viewport: { width: 1200, height: 900 },
        reducedMotion: "no-preference",
        deviceScaleFactor: 1,
      });
      consumerContext.on("request", (request) =>
        observedRequests.add(request.url()),
      );
      const consumer = await consumerContext.newPage();
      consumer.on("pageerror", (error) =>
        report.pageErrors.push({
          case: fixture.id,
          surface: "consumer",
          error: String(error),
        }),
      );
      const isolation = await createFixture(consumer, fixture, false);
      assert.deepEqual(isolation, {
        animations: 0,
        core: "undefined",
        capture: "undefined",
        extensionRuntime: "undefined",
      });
      assert.equal(consumerContext.serviceWorkers().length, 0);
      await consumer.addScriptTag({ path: downloadedPath });
      caseReport.replay = await consumer.evaluate(async () => {
        const target = document.querySelector("#target");
        const autostartedAnimations = target.getAnimations().length;
        const baseline = {
          inlineStyle: target.getAttribute("style"),
          origin: getComputedStyle(target).transformOrigin,
        };
        const handle = window.motionPaste(target);
        window.fixtureHandle = handle;
        window.fixtureAnimation = handle.animation;
        handle.animation.pause();
        await handle.animation.ready;
        handle.animation.currentTime = 0;
        return {
          autostartedAnimations,
          baseline,
          timing: handle.animation.effect.getTiming(),
          core: typeof window.MotionCore,
          capture: typeof window.SourceCapture,
          extensionRuntime: typeof window.chrome?.runtime?.id,
        };
      });
      assert.equal(caseReport.replay.autostartedAnimations, 0);
      assert.equal(caseReport.replay.core, "undefined");
      assert.equal(caseReport.replay.capture, "undefined");
      assert.equal(caseReport.replay.extensionRuntime, "undefined");
      const exportedSamples = await observe(consumer, times);
      caseReport.comparison = compare(sourceSamples, exportedSamples);
      caseReport.samples = sourceSamples.map((sourceSample, index) => ({
        time: sourceSample.time,
        source: sourceSample,
        exported: exportedSamples[index],
      }));
      caseReport.cleanup = await consumer.evaluate(() => {
        window.fixtureHandle.cancel();
        const target = document.querySelector("#target");
        return {
          animations: target.getAnimations().length,
          inlineStyle: target.getAttribute("style"),
          origin: getComputedStyle(target).transformOrigin,
        };
      });
      assert.equal(caseReport.cleanup.animations, 0);
      assert.equal(
        caseReport.cleanup.inlineStyle,
        caseReport.replay.baseline.inlineStyle,
      );
      const noOpSamples = await observe(consumer, times, true);
      caseReport.negativeControl = {
        operation:
          "Cancel the downloaded animation; compare unchanged, finite baseline rendering at every identical timepoint",
        ...compare(sourceSamples, noOpSamples),
      };
      assert.equal(
        caseReport.negativeControl.status,
        "FAIL",
        "Comparator must reject the no-op negative control",
      );
      assert.ok(
        caseReport.negativeControl.mismatchCount >= 10,
        "Negative control must detect a substantial animated difference",
      );
      assert.equal(
        caseReport.comparison.status,
        "PASS",
        JSON.stringify(caseReport.comparison),
      );
      if (fixture.captureOrigin) {
        assert.notEqual(captured.captureOrigin, captured.referenceOrigin);
        assert.ok(
          exportedSamples.every(
            (sample) => sample.origin === caseReport.replay.baseline.origin,
          ),
          "Opacity-only export preserves pre-rotated target's own transform origin",
        );
        caseReport.opacityOnlyOriginPreserved = true;
      }
      caseReport.status = "PASS";
      console.log(
        `PASS ${fixture.id}: ${times.length} paired times; no-op rejected at ${caseReport.negativeControl.mismatchCount} times`,
      );
    } catch (error) {
      caseReport.status = "FAIL";
      caseReport.error = String(error.stack || error);
      console.error(`FAIL ${fixture.id}: ${error.message}`);
    } finally {
      await consumerContext?.close();
      await studio?.close();
      await source?.close();
    }
  }
  await sourceContext.close();
  report.observedRequests = [...observedRequests].sort();
  assert.ok(
    report.observedRequests.every(
      (url) =>
        url.startsWith(`chrome-extension://${extensionId}/`) ||
        url.startsWith("blob:"),
    ),
    "Only extension-local UI requests are allowed",
  );
  assert.deepEqual(report.pageErrors, []);
  assert.equal(
    sha(await readFile(archive)),
    report.archiveSHA256,
    "Release ZIP cannot change during verification",
  );
  report.finalArchiveSHA256 = report.archiveSHA256;
  report.summary = {
    passedCases: report.cases.filter((entry) => entry.status === "PASS").length,
    failedCases: report.cases.filter((entry) => entry.status === "FAIL").length,
    pairedTimepoints: report.cases.reduce(
      (count, entry) => count + (entry.comparison?.timepointCount || 0),
      0,
    ),
    rejectedNoOpControls: report.cases.filter(
      (entry) => entry.negativeControl?.status === "FAIL",
    ).length,
    maxAbsoluteError: Object.fromEntries(
      Object.keys(tolerance).map((property) => [
        property,
        Math.max(
          ...report.cases.map(
            (entry) => entry.comparison?.maxAbsoluteError[property] || 0,
          ),
        ),
      ]),
    ),
  };
  assert.equal(
    report.summary.failedCases,
    0,
    "Every final UI-export parity case must pass",
  );
  assert.equal(report.summary.rejectedNoOpControls, fixtures.length);
  report.status = "PASS";
  validateEvidenceContent("export-parity-report.json", report);
} catch (error) {
  report.status = "FAIL";
  report.failure = String(error.stack || error);
  process.exitCode = 1;
} finally {
  await consumerBrowser?.close();
  await sourceBrowser?.close();
  await studioContext?.close();
  await rm(temporary, { recursive: true, force: true });
  await mkdir(resolve("artifacts/verification"), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`EXPORT PARITY ${report.status}: ${output}`);
}
