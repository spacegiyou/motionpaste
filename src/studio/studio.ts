import {
  editDuration,
  exportJavaScript,
  MotionError,
  parseRecipe,
  replayMotion,
  type MotionHandle,
  type MotionRecipe,
} from "../core/index";

function element<T extends HTMLElement>(id: string, kind: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind))
    throw new Error(`Missing Studio control: ${id}`);
  return found;
}

const sourceTarget = element("source-target", HTMLDivElement);
const previewTarget = element("preview-target", HTMLDivElement);
const importFile = element("import-file", HTMLInputElement);
const durationInput = element("duration-input", HTMLInputElement);
const durationSlider = element("duration-slider", HTMLInputElement);
const playButton = element("play-button", HTMLButtonElement);
const restartButton = element("restart-button", HTMLButtonElement);
const resetButton = element("reset-button", HTMLButtonElement);
const restoreButton = element("restore-duration", HTMLButtonElement);
const compareButton = element("compare-original", HTMLButtonElement);
const playOnceButton = element("play-once", HTMLButtonElement);
const jsonButton = element("export-json", HTMLButtonElement);
const downloadButton = element("download-js", HTMLButtonElement);
const copyButton = element("copy-js", HTMLButtonElement);
const designButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-design]"),
];
const errorMessage = element("error-message", HTMLDivElement);
const statusMessage = element("status-message", HTMLDivElement);
const playhead = element("playhead", HTMLDivElement);
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
let recipe: MotionRecipe | null = null;
let loadedRecipe: MotionRecipe | null = null;
let recipeOrigin: "capture" | "import" = "capture";
let locallyEdited = false;
let compareOriginal = false;
let handles: MotionHandle[] = [];
let animationFrame = 0;
let loadSequence = 0;

function announce(message: string): void {
  statusMessage.textContent = message;
}

function clearError(): void {
  errorMessage.textContent = "";
  errorMessage.hidden = true;
}

function showError(
  error: unknown,
  stage: "CAPTURE" | "APPLY" | "IMPORT" | "EDIT" | "EXPORT",
): void {
  const detail =
    error instanceof Error
      ? error.message
      : "Something went wrong. Please try again.";
  errorMessage.textContent =
    error instanceof MotionError && error.stage
      ? detail
      : `${stage} blocked${error instanceof MotionError ? ` [${error.code}]` : ""}: ${detail}`;
  errorMessage.hidden = false;
}

function setText(id: string, value: string): void {
  element(id, HTMLElement).textContent = value;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(3)).toLocaleString("en-US");
}

function updateControls(): void {
  const empty = recipe === null;
  const active = handles.some(
    ({ animation }) =>
      animation.playState === "running" || animation.playState === "paused",
  );
  for (const control of [
    durationInput,
    durationSlider,
    resetButton,
    jsonButton,
    downloadButton,
    copyButton,
    compareButton,
    ...designButtons,
  ]) {
    control.disabled = empty;
  }
  playButton.disabled = empty || (reducedMotion.matches && !active);
  restartButton.disabled = empty || reducedMotion.matches;
  restoreButton.disabled =
    empty || recipe?.timing.duration === loadedRecipe?.timing.duration;
  playOnceButton.disabled = empty;
  element("reduced-motion-notice", HTMLDivElement).hidden =
    !reducedMotion.matches;
  const running = handles.some(
    ({ animation }) => animation.playState === "running",
  );
  const paused = handles.some(
    ({ animation }) => animation.playState === "paused",
  );
  setText(
    "play-label",
    running ? "Pause motion" : paused ? "Resume motion" : "Play motion",
  );
  setText("play-icon", running ? "Ⅱ" : "▶");
}

function stopPlayback(): void {
  cancelAnimationFrame(animationFrame);
  animationFrame = 0;
  for (const handle of handles) handle.cancel();
  handles = [];
  playhead.hidden = true;
  playhead.style.left = "0%";
  updateControls();
}

function updatePlayhead(): void {
  const animation = handles[1]?.animation;
  if (!animation) return;
  const progress = animation.effect?.getComputedTiming().progress;
  playhead.hidden = progress === null || progress === undefined;
  if (progress !== null && progress !== undefined)
    playhead.style.left = `${Math.max(0, Math.min(1, progress)) * 100}%`;
  if (animation.playState === "running")
    animationFrame = requestAnimationFrame(updatePlayhead);
}

function startPlayback(allowReducedMotion = false): void {
  if (!recipe) return;
  clearError();
  stopPlayback();
  try {
    handles.push(
      replayMotion(
        sourceTarget,
        compareOriginal && loadedRecipe ? loadedRecipe : recipe,
        { allowReducedMotion },
      ),
    );
    handles.push(replayMotion(previewTarget, recipe, { allowReducedMotion }));
    // Use the same document timeline start so both previews stay in phase.
    const currentTime = document.timeline.currentTime;
    if (currentTime !== null) {
      for (const handle of handles) handle.animation.startTime = currentTime;
    }
    for (const { animation: primary } of handles)
      primary.addEventListener(
        "finish",
        () => {
          if (!handles.some((handle) => handle.animation === primary)) return;
          updatePlayhead();
          updateControls();
          if (
            handles.every((handle) => handle.animation.playState === "finished")
          )
            announce(
              "Playback complete. Reset restores the resting design; play starts again.",
            );
        },
        { once: true },
      );
    updateControls();
    updatePlayhead();
    announce(
      allowReducedMotion
        ? "Playing this preview once with your permission."
        : compareOriginal
          ? "Comparing loaded timing with your current edit."
          : "Playing the same motion on both designs.",
    );
  } catch (error) {
    stopPlayback();
    showError(error, "APPLY");
  }
}

function renderRecipe(): void {
  if (!recipe) return;
  const { timing, keyframes, context } = recipe;
  const properties = [
    keyframes.some((frame) => frame.transform !== undefined) ? "transform" : "",
    keyframes.some((frame) => frame.opacity !== undefined) ? "opacity" : "",
  ].filter(Boolean);
  setText(
    "recipe-label",
    recipeOrigin === "import"
      ? "Your imported motion."
      : "A little motion, captured.",
  );
  const badge = element("recipe-state", HTMLSpanElement);
  badge.textContent = locallyEdited
    ? "EDITED"
    : recipeOrigin === "import"
      ? "IMPORTED"
      : "CAPTURED";
  badge.className = `badge ${locallyEdited ? "edited" : recipeOrigin === "import" ? "imported" : "captured"}`;
  setText(
    "capture-hint",
    recipeOrigin === "import"
      ? "Imported effect values. Source appearance has not been verified."
      : "Captured effect values. Source appearance has not been verified.",
  );
  const indicator = element("loaded-indicator", HTMLSpanElement);
  indicator.classList.add("ready");
  indicator.replaceChildren(
    document.createElement("span"),
    document.createTextNode("Recipe ready"),
  );
  indicator.firstElementChild?.setAttribute("aria-hidden", "true");
  element("empty-state", HTMLDivElement).hidden = true;
  durationInput.value = String(timing.duration);
  durationSlider.min = "1";
  durationSlider.max = "60000";
  durationSlider.step = "1";
  durationSlider.value = String(timing.duration);
  durationSlider.setAttribute(
    "aria-valuetext",
    `${formatNumber(timing.duration)} milliseconds`,
  );
  setText("duration-min", `${formatNumber(Number(durationSlider.min))} ms`);
  setText("duration-max", `${formatNumber(Number(durationSlider.max))} ms`);
  compareButton.setAttribute("aria-pressed", String(compareOriginal));
  setText(
    "source-heading",
    compareOriginal
      ? recipeOrigin === "import"
        ? "Imported timing"
        : "Captured timing"
      : "Motion specimen",
  );
  setText(
    "source-preview-caption",
    compareOriginal && loadedRecipe
      ? `Loaded effect: ${formatNumber(loadedRecipe.timing.duration)} ms. Neutral design.`
      : "Only the movement comes along.",
  );
  setText(
    "recipe-summary",
    `${keyframes.length} frames · ${formatNumber(timing.duration)} ms · ${properties.join(" + ")}`,
  );
  setText(
    "geometry-note",
    `Effect values only; visual matching to the source is unverified. ${properties.includes("transform") ? `Literal origin: ${context.transformOrigin}.` : "Opacity-only: your target geometry and origin stay unchanged."} Target size and parent context can change how this looks; geometry is not automatically adjusted.`,
  );
  setText(
    "timing-details",
    `Duration ${formatNumber(timing.duration)} ms · Original ${formatNumber(recipe.originalDuration)} ms · Delay ${formatNumber(timing.delay)} ms · End delay ${formatNumber(timing.endDelay)} ms · Iterations ${formatNumber(timing.iterations)} · Iteration start ${formatNumber(timing.iterationStart)} · Direction ${timing.direction} · Easing ${timing.easing} · Fill ${timing.fill}`,
  );

  const markers = element("keyframe-markers", HTMLDivElement);
  const rows = element("keyframe-rows", HTMLTableSectionElement);
  markers.replaceChildren();
  rows.replaceChildren();
  keyframes.forEach((frame, index) => {
    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    marker.style.left = `${frame.offset * 100}%`;
    marker.tabIndex = 0;
    const description = `Frame ${index + 1}: ${formatNumber(frame.offset * 100)} percent; transform ${frame.transform ?? "not set"}; opacity ${frame.opacity ?? "not set"}; easing ${frame.easing}`;
    marker.setAttribute("aria-label", description);
    marker.setAttribute("role", "img");
    marker.title = description;
    markers.append(marker);
    const row = document.createElement("tr");
    for (const text of [
      `${formatNumber(frame.offset * 100)}%`,
      frame.transform ?? "—",
      frame.opacity === undefined ? "—" : formatNumber(frame.opacity),
      frame.easing,
    ]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    rows.append(row);
  });
  element("keyframe-table", HTMLTableElement).hidden = false;
  setText("code-output", exportJavaScript(recipe));
  updateControls();
}

function loadRecipe(input: unknown, source: "capture" | "import"): void {
  const validated = parseRecipe(input);
  stopPlayback();
  recipe = validated;
  loadedRecipe = parseRecipe(validated);
  recipeOrigin = source;
  locallyEdited = false;
  compareOriginal = false;
  clearError();
  renderRecipe();
  announce(
    source === "capture"
      ? "Motion captured. Choose a design and press Play motion to preview it."
      : "Recipe imported and validated. Choose a design and press Play motion to preview it.",
  );
}

function changeDuration(value: number): void {
  if (!recipe) return;
  try {
    const edited = editDuration(recipe, value);
    stopPlayback();
    recipe = edited;
    locallyEdited = true;
    clearError();
    renderRecipe();
    announce(
      `Duration changed to ${formatNumber(value)} milliseconds. Press Play motion to preview.`,
    );
  } catch (error) {
    showError(error, "EDIT");
    durationInput.value = String(recipe.timing.duration);
    durationSlider.value = String(recipe.timing.duration);
  }
}

function download(content: string, filename: string, type: string): void {
  const link = document.createElement("a");
  let url: string | undefined;
  try {
    clearError();
    url = URL.createObjectURL(new Blob([content], { type }));
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    announce(`${filename} is ready to save.`);
  } catch (error) {
    showError(error, "EXPORT");
  } finally {
    link.remove();
    const created = url;
    if (created) setTimeout(() => URL.revokeObjectURL(created), 1000);
  }
}

element("import-button", HTMLButtonElement).addEventListener("click", () =>
  importFile.click(),
);
importFile.addEventListener("change", () => {
  const file = importFile.files?.[0];
  if (!file) return;
  const sequence = ++loadSequence;
  clearError();
  if (file.size > 65536) {
    showError(
      new Error(
        "Recipes are limited to 64 KiB. Choose a smaller MotionPaste JSON file.",
      ),
      "IMPORT",
    );
    importFile.value = "";
    return;
  }
  void file
    .text()
    .then((text) => {
      if (sequence === loadSequence) loadRecipe(text, "import");
    })
    .catch((error: unknown) => {
      if (sequence === loadSequence) showError(error, "IMPORT");
    })
    .finally(() => {
      if (sequence === loadSequence) importFile.value = "";
    });
});

durationInput.addEventListener("change", () =>
  changeDuration(Number(durationInput.value)),
);
durationSlider.addEventListener("input", () =>
  changeDuration(Number(durationSlider.value)),
);
restoreButton.addEventListener("click", () => {
  if (!recipe || !loadedRecipe) return;
  const restored = parseRecipe(loadedRecipe);
  stopPlayback();
  recipe = restored;
  locallyEdited = false;
  clearError();
  renderRecipe();
  announce("Loaded duration restored. Recipe provenance is unchanged.");
});
compareButton.addEventListener("click", () => {
  if (!recipe) return;
  stopPlayback();
  compareOriginal = !compareOriginal;
  renderRecipe();
  announce(
    compareOriginal
      ? "Comparison enabled. Left uses the loaded timing; right uses your current edit."
      : "Both designs now use your current timing.",
  );
});
playButton.addEventListener("click", () => {
  const running = handles.some(
    ({ animation }) => animation.playState === "running",
  );
  const paused = handles.some(
    ({ animation }) => animation.playState === "paused",
  );
  if (running) {
    for (const { animation } of handles) animation.pause();
    cancelAnimationFrame(animationFrame);
    updateControls();
    updatePlayhead();
    announce("Motion paused.");
  } else if (paused) {
    for (const { animation } of handles) animation.play();
    updateControls();
    updatePlayhead();
    announce("Motion resumed.");
  } else {
    startPlayback();
  }
});
restartButton.addEventListener("click", () => startPlayback());
resetButton.addEventListener("click", () => {
  stopPlayback();
  clearError();
  announce("Preview reset. Both designs are back at rest.");
});
playOnceButton.addEventListener("click", () => startPlayback(true));

for (const button of designButtons) {
  button.addEventListener("click", () => {
    const design = button.dataset.design;
    if (design !== "button" && design !== "card" && design !== "pill") return;
    stopPlayback();
    previewTarget.className = `preview-target design-${design}`;
    for (const option of designButtons)
      option.setAttribute("aria-pressed", String(option === button));
    clearError();
    announce(
      `${design[0]?.toUpperCase()}${design.slice(1)} design selected. Press Play motion to try it.`,
    );
  });
}

jsonButton.addEventListener("click", () => {
  if (recipe)
    download(
      `${JSON.stringify(recipe, null, 2)}\n`,
      "motionpaste-recipe.json",
      "application/json",
    );
});
downloadButton.addEventListener("click", () => {
  if (recipe)
    download(exportJavaScript(recipe), "motionpaste.js", "text/javascript");
});
copyButton.addEventListener("click", () => {
  if (!recipe) return;
  clearError();
  if (!navigator.clipboard) {
    showError(
      new Error(
        "Clipboard is unavailable here. Use the JavaScript download button to save the same code.",
      ),
      "EXPORT",
    );
    return;
  }
  void navigator.clipboard
    .writeText(exportJavaScript(recipe))
    .then(() => {
      announce(
        "Runnable JavaScript copied. In your page, call window.motionPaste(yourElement).",
      );
    })
    .catch(() => {
      showError(
        new Error(
          "Clipboard access was not granted. Use the JavaScript download button to save the same code.",
        ),
        "EXPORT",
      );
    });
});

reducedMotion.addEventListener("change", () => {
  stopPlayback();
  updateControls();
  announce(
    reducedMotion.matches
      ? "Reduced motion is now on. Use Play once anyway for an explicit preview."
      : "Reduced motion is off. Playback is available.",
  );
});
window.addEventListener("pagehide", stopPlayback);

async function loadCapture(): Promise<void> {
  const id = new URL(location.href).searchParams.get("id");
  if (!id) return;
  const sequence = ++loadSequence;
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) {
    showError(
      new Error(
        "This capture link is invalid. Capture the motion again or import its JSON recipe.",
      ),
      "CAPTURE",
    );
    return;
  }
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    showError(
      new Error(
        "Capture links open inside the MotionPaste extension. Import a recipe JSON to use this local Studio.",
      ),
      "CAPTURE",
    );
    return;
  }
  announce("Loading your captured motion…");
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: "MOTIONPASTE_GET_CAPTURE",
      id,
    });
    if (sequence !== loadSequence) return;
    if (
      typeof response !== "object" ||
      response === null ||
      !("ok" in response)
    ) {
      throw new Error("The extension returned an invalid capture response.");
    }
    if (response.ok !== true || !("recipe" in response)) {
      const message =
        "error" in response && typeof response.error === "string"
          ? response.error
          : "This capture has expired. Capture the motion again or import its JSON recipe.";
      throw new Error(message);
    }
    loadRecipe(response.recipe, "capture");
  } catch (error) {
    if (sequence === loadSequence) showError(error, "CAPTURE");
  }
}

updateControls();
void loadCapture();
