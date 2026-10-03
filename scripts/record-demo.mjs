import { archivePath } from "./release-info.mjs";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "./serve.mjs";
import { openPicker } from "./browser-helpers.mjs";

const out = resolve("artifacts/demo");
await mkdir(out, { recursive: true });
await writeFile(
  join(out, "video-report.json"),
  JSON.stringify(
    { status: "RUNNING", startedAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
const temp = await mkdtemp(join(tmpdir(), "motionpaste-video-"));
const extension = join(temp, "extension");
await mkdir(extension);
const archive = archivePath;
execFileSync("unzip", ["-q", archive, "-d", extension]);
const server = await createServer(0);
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(join(temp, "profile"), {
  channel: "chromium",
  headless: true,
  viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: join(temp, "raw"), size: { width: 1440, height: 1000 } },
  args: [`--load-extension=${extension}`],
  ignoreDefaultArgs: ["--disable-extensions"],
});
const browserVersion = context.browser().version();
const archiveSHA256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
let consumerBrowser;
let consumerContext;
const markers = {};
try {
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).hostname;
  const source = await context.newPage();
  const sourceStart = Date.now();
  await source.goto(`${base}/fixtures/source-app/`);
  await source.waitForTimeout(1700);
  await source.locator("#restart").click();
  await source.waitForTimeout(1700);
  await openPicker(context, source, id);
  await source.locator("#source-card").hover();
  markers.picker = (Date.now() - sourceStart) / 1000;
  await source.waitForTimeout(
    Math.max(1000, 6500 - (Date.now() - sourceStart)),
  );
  const studioPromise = context.waitForEvent("page", {
    predicate: (p) => p.url().includes("/studio.html"),
  });
  markers.capture = (Date.now() - sourceStart) / 1000;
  await source.locator("#source-card").click();
  const studio = await studioPromise;
  const studioStart = Date.now();
  await studio.waitForLoadState();
  await studio.waitForFunction(
    () => document.querySelector("#recipe-state")?.textContent === "CAPTURED",
  );
  await source.waitForTimeout(
    Math.max(2000, 8500 - (Date.now() - sourceStart)),
  );
  await source.close();
  await source.video().saveAs(join(out, "01-capture.webm"));
  console.log("Recorded actual extension capture");
  await studio.waitForTimeout(800);
  await studio.locator("#play-button").click();
  await studio.waitForTimeout(2000);
  await studio.locator('[data-design="card"]').click();
  await studio.locator("#restart-button").click();
  await studio.waitForTimeout(2200);
  markers.edit = (Date.now() - studioStart) / 1000;
  await studio.locator("#duration-input").fill("733");
  await studio.locator("#duration-input").press("Tab");
  await studio.locator("#compare-original").click();
  await studio.waitForTimeout(900);
  await studio.locator("#restart-button").click();
  await studio.waitForTimeout(1600);
  await studio.locator('[data-design="pill"]').click();
  await studio.locator("#restart-button").click();
  await studio.waitForTimeout(1800);
  await studio.screenshot({
    path: join(out, "studio-demo.png"),
    fullPage: true,
  });
  await studio.locator("#download-js").scrollIntoViewIfNeeded();
  await studio.waitForTimeout(1000);
  markers.download = (Date.now() - studioStart) / 1000;
  const downloaded = studio.waitForEvent("download");
  await studio.locator("#download-js").click();
  const file = await downloaded;
  const jsPath = join(out, "demo-export.js");
  await file.saveAs(jsPath);
  assert.equal(
    await file.failure(),
    null,
    "Studio JavaScript download completed",
  );
  await studio.waitForTimeout(1800);
  await studio.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await studio.waitForTimeout(800);
  await studio.locator("#restart-button").click();
  await studio.waitForTimeout(
    Math.max(1000, 21500 - (Date.now() - studioStart)),
  );
  await studio.close();
  await studio.video().saveAs(join(out, "02-studio.webm"));
  console.log("Recorded actual Studio edits and JavaScript download");
  consumerBrowser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  consumerContext = await consumerBrowser.newContext({
    viewport: { width: 1440, height: 1000 },
    recordVideo: {
      dir: join(temp, "consumer-raw"),
      size: { width: 1440, height: 1000 },
    },
  });
  const consumer = await consumerContext.newPage();
  const consumerStart = Date.now();
  await consumer.goto(`${base}/fixtures/consumer-app/`);
  await consumer.waitForTimeout(1000);
  await consumer.addScriptTag({ path: jsPath });
  assert.equal(
    await consumer.evaluate(() => typeof chrome?.runtime?.id),
    "undefined",
  );
  for (let i = 0; i < 3; i++) {
    await consumer.evaluate(() => {
      window.demoHandle?.cancel();
      window.demoHandle = window.motionPaste(document.querySelector("#target"));
    });
    await consumer.waitForTimeout(1800);
  }
  await consumer.waitForTimeout(
    Math.max(500, 8500 - (Date.now() - consumerStart)),
  );
  await consumer.close();
  await consumer.video().saveAs(join(out, "03-consumer.webm"));
  console.log(
    "Recorded actual downloaded code in a separate browser with no extension",
  );
  const showcase = await consumerContext.newPage();
  const showcaseStart = Date.now();
  await showcase.goto(`${base}/fixtures/consumer-app/showcase.html`);
  await showcase.addScriptTag({ path: jsPath });
  const showcaseState = await showcase.evaluate(() => {
    window.showcaseHandles = [];
    document.querySelector("#replay").disabled = false;
    document.querySelector("#status").textContent =
      "733 ms · Self-contained JavaScript · No extension or external library";
    document.querySelector("#replay").addEventListener("click", () => {
      for (const handle of window.showcaseHandles) handle.cancel();
      window.showcaseHandles = ["card", "button"].map((id) =>
        window.motionPaste(document.getElementById(id)),
      );
      const startTime = document.timeline.currentTime;
      for (const handle of window.showcaseHandles)
        handle.animation.startTime = startTime;
    });
    return { extensionRuntime: typeof chrome?.runtime?.id, targetCount: 2 };
  });
  assert.equal(showcaseState.extensionRuntime, "undefined");
  markers.showcase = (Date.now() - showcaseStart) / 1000;
  for (let index = 0; index < 5; index++) {
    await showcase.locator("#replay").click();
    const durations = await showcase.evaluate(() =>
      window.showcaseHandles.map(
        ({ animation }) => animation.effect.getTiming().duration,
      ),
    );
    assert.deepEqual(durations, [733, 733]);
    await showcase.waitForTimeout(1500);
  }
  await showcase.screenshot({ path: join(out, "showcase.png") });
  await showcase.close();
  await showcase.video().saveAs(join(out, "04-showcase.webm"));
  const captions = [
    ["SAME MOTION / TWO DESIGNS", "Copy the motion. Keep your design."],
    ["01 / CAPTURE", "Select a supported animation in your own web app."],
    ["02 / PREVIEW", "Try the captured motion on a new design."],
    ["03 / EDIT", "1,300 → 733 ms. Compare loaded and edited timing."],
    ["04 / EXPORT", "Download JavaScript from the real Studio."],
    [
      "READY TO APPLY",
      "Self-contained JavaScript. No extension or external library required.",
    ],
  ];
  const captionPage = await consumerContext.newPage();
  await captionPage.setViewportSize({ width: 1440, height: 130 });
  await captionPage.setContent(
    "<style>body{margin:0;background:#101015;color:#f5f2fb;font-family:Arial,sans-serif;padding:18px 45px;border-top:1px solid #383340;box-sizing:border-box}p{margin:0 0 9px;font-size:16px;font-weight:bold;letter-spacing:2px;color:#bfb0ff}strong{font-size:34px;line-height:1.25;font-weight:600}</style><p></p><strong></strong>",
  );
  for (let index = 0; index < captions.length; index++) {
    await captionPage.evaluate(([label, text]) => {
      document.querySelector("p").textContent = label;
      document.querySelector("strong").textContent = text;
    }, captions[index]);
    await captionPage.screenshot({ path: join(out, `caption-${index}.png`) });
  }
  await captionPage.close();
  console.log(
    "Recorded result-first showcase with the same downloaded JavaScript on two designs",
  );
  await writeFile(
    join(out, "video-report.json"),
    JSON.stringify(
      {
        status: "RECORDED",
        recordedAt: new Date().toISOString(),
        browser: browserVersion,
        archiveSHA256,
        downloadedJavaScriptSHA256: createHash("sha256")
          .update(await readFile(jsPath))
          .digest("hex"),
        durationSeconds: 35,
        scope:
          "Actual browser viewport recordings. Source and Studio use the installed ZIP. Consumer and two-design showcase run the actual Studio-downloaded JavaScript in a separate browser without extension arguments. Browser toolbar/popup chrome and the system pointer are outside Playwright viewport recording; actions, mouse movements and the picker were actually invoked, without a fake toolbar or cursor. Captions are added in a separate bottom strip; promo edit/download shots are cropped and scaled for readability. Cuts only, no speed changes; the edited videos do not claim end-to-end elapsed task time. Silence; no voiceover.",
        markers,
        consumer: {
          separateBrowser: true,
          extensionArguments: [],
          extensionRuntime: "undefined",
          twoDesignDurations: [733, 733],
        },
        segments: [
          { file: "01-capture.webm", usedSeconds: 8 },
          { file: "02-studio.webm", usedSeconds: 20 },
          { file: "03-consumer.webm", usedSeconds: 7 },
        ],
      },
      null,
      2,
    ) + "\n",
  );
} catch (error) {
  await writeFile(
    join(out, "video-report.json"),
    JSON.stringify({ status: "FAIL", error: String(error) }, null, 2) + "\n",
  );
  throw error;
} finally {
  await consumerContext?.close();
  await consumerBrowser?.close();
  await context.close();
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
function compose(filename, segments) {
  const frameRate = 30;
  const segmentFrames = segments.map(({ duration }) =>
    Math.round(duration * frameRate),
  );
  const expectedFrames = segmentFrames.reduce((sum, frames) => sum + frames, 0);
  const args = ["-y"];
  for (const segment of segments) args.push("-i", join(out, segment.file));
  for (const segment of segments)
    args.push("-i", join(out, `caption-${segment.caption}.png`));
  const filters = segments.map(
    (segment, index) =>
      // Time-based trim followed by frame-rate conversion can round each cut
      // outward. Sample at normal speed first, then take the exact frame count.
      `[${index}:v]trim=start=${segment.start ?? 0},setpts=PTS-STARTPTS,fps=${frameRate}:start_time=0,trim=end_frame=${segmentFrames[index]},setpts=N/(${frameRate}*TB),${segment.crop ? `crop=${segment.crop},scale=1440:1000,` : ""}pad=1440:1130:0:0:color=0x101015[clip${index}];[clip${index}][${segments.length + index}:v]overlay=0:1000:shortest=0,setsar=1[captioned${index}]`,
  );
  filters.push(
    `${segments.map((_, index) => `[captioned${index}]`).join("")}concat=n=${segments.length}:v=1:a=0[out]`,
  );
  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-preset",
    "fast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    join(out, filename),
  );
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size:stream=codec_name,width,height,codec_type,nb_frames,avg_frame_rate",
        "-of",
        "json",
        join(out, filename),
      ],
      { encoding: "utf8" },
    ),
  );
  const duration = expectedFrames / frameRate;
  const videoStream = probe.streams.find(
    ({ codec_type }) => codec_type === "video",
  );
  assert.equal(
    Number(videoStream?.nb_frames),
    expectedFrames,
    `${filename}: exact output frame count`,
  );
  assert.equal(
    videoStream.avg_frame_rate,
    `${frameRate}/1`,
    `${filename}: normal-speed frame rate`,
  );
  assert.equal(
    Number(probe.format.duration),
    duration,
    `${filename}: exact duration`,
  );
  assert.equal(
    probe.streams.filter(({ codec_type }) => codec_type === "audio").length,
    0,
  );
  return {
    filename,
    durationSeconds: Number(probe.format.duration),
    bytes: Number(probe.format.size),
    streams: probe.streams,
    frameRate,
    frameCount: expectedFrames,
    segments,
  };
}

try {
  assert.equal(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    archiveSHA256,
    "The release ZIP must not change while recording",
  );
  const editAt = Math.round(markers.edit * 30) / 30;
  const downloadAt = Math.round(markers.download * 30) / 30;
  assert.ok(
    editAt > 0 && downloadAt > editAt && downloadAt < 19,
    "Recorded Studio actions must fit the main clip",
  );
  const main = compose("MotionPaste-demo.mp4", [
    {
      file: "01-capture.webm",
      start: Math.max(0, (markers.capture ?? 6.5) - 6.5),
      duration: 8,
      caption: 1,
    },
    { file: "02-studio.webm", start: 0, duration: editAt, caption: 2 },
    {
      file: "02-studio.webm",
      start: editAt,
      duration: downloadAt - editAt,
      caption: 3,
    },
    {
      file: "02-studio.webm",
      start: downloadAt,
      duration: 20 - downloadAt,
      caption: 4,
    },
    { file: "03-consumer.webm", start: 0, duration: 7, caption: 5 },
  ]);
  const promo = compose("MotionPaste-promo.mp4", [
    {
      file: "04-showcase.webm",
      start: markers.showcase,
      duration: 3,
      caption: 0,
    },
    {
      file: "01-capture.webm",
      start: Math.max(0, markers.picker - 0.1),
      duration: 3,
      caption: 1,
    },
    {
      file: "02-studio.webm",
      start: Math.max(0, markers.edit - 0.1),
      duration: 4,
      caption: 3,
      crop: "980:680:0:0",
    },
    {
      file: "02-studio.webm",
      start: Math.max(0, markers.download - 0.6),
      duration: 2,
      caption: 4,
      crop: "1100:764:300:230",
    },
    {
      file: "04-showcase.webm",
      start: markers.showcase + 3,
      duration: 3,
      caption: 5,
    },
  ]);
  const timecode = (seconds) => {
    const milliseconds = Math.round(seconds * 1000);
    return `00:${String(Math.floor(milliseconds / 60000)).padStart(2, "0")}:${String(Math.floor(milliseconds / 1000) % 60).padStart(2, "0")},${String(milliseconds % 1000).padStart(3, "0")}`;
  };
  let position = 0;
  const mainCaptions = [
    "Select a supported animation in your own web app.",
    "Try the captured motion on a new design.",
    "1,300 → 733 ms. Compare loaded and edited timing.",
    "Download JavaScript from the real Studio.",
    "Self-contained JavaScript.\nNo extension or external library required.",
  ];
  await writeFile(
    join(out, "MotionPaste-demo.srt"),
    main.segments
      .map((segment, index) => {
        const start = position;
        position += segment.duration;
        return `${index + 1}\n${timecode(start)} --> ${timecode(position)}\n${mainCaptions[index]}\n`;
      })
      .join("\n"),
  );
  await writeFile(
    join(out, "MotionPaste-promo.srt"),
    `1
00:00:00,000 --> 00:00:03,000
Copy the motion. Keep your design.

2
00:00:03,000 --> 00:00:06,000
Select a supported animation in your own web app.

3
00:00:06,000 --> 00:00:10,000
1,300 → 733 ms. Compare loaded and edited timing.

4
00:00:10,000 --> 00:00:12,000
Download JavaScript from the real Studio.

5
00:00:12,000 --> 00:00:15,000
Self-contained JavaScript.
No extension or external library required.
`,
  );
  for (const [filename, interval, sheet, tile] of [
    ["MotionPaste-demo.mp4", 5, "contact-sheet.jpg", "3x3"],
    ["MotionPaste-promo.mp4", 2.5, "promo-contact-sheet.jpg", "3x2"],
  ]) {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-i",
        join(out, filename),
        "-vf",
        `fps=1/${interval},scale=480:-1,tile=${tile}`,
        "-frames:v",
        "1",
        join(out, sheet),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
  }
  const video = JSON.parse(
    await readFile(join(out, "video-report.json"), "utf8"),
  );
  video.status = "PASS";
  video.actualDurationSeconds = main.durationSeconds;
  video.bytes = main.bytes;
  video.main = main;
  video.promo = promo;
  video.finishedAt = new Date().toISOString();
  video.mediaSHA256 = {};
  for (const filename of [
    "MotionPaste-demo.mp4",
    "MotionPaste-demo.srt",
    "MotionPaste-promo.mp4",
    "MotionPaste-promo.srt",
    "contact-sheet.jpg",
    "promo-contact-sheet.jpg",
  ])
    video.mediaSHA256[filename] = createHash("sha256")
      .update(await readFile(join(out, filename)))
      .digest("hex");
  await writeFile(
    join(out, "video-report.json"),
    JSON.stringify(video, null, 2) + "\n",
  );
  console.log(
    `Recorded final ZIP: 35-second main video and 15-second result-first promo, with no speed changes.`,
  );
} catch (error) {
  const recorded = JSON.parse(
    await readFile(join(out, "video-report.json"), "utf8"),
  );
  await writeFile(
    join(out, "video-report.json"),
    JSON.stringify(
      { ...recorded, status: "FAIL", archiveSHA256, error: String(error) },
      null,
      2,
    ) + "\n",
  );
  throw error;
}
