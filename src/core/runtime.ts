import type {
  MotionHandle,
  MotionKeyframe,
  MotionRecipe,
  MotionStage,
  ReplayOptions,
} from "./types";

/**
 * This function has no free runtime variables. Its compiled source is embedded in
 * exports so imported recipes and standalone playback use the very same checks.
 */
export function createMotionRuntime() {
  class MotionError extends Error {
    readonly code: string;
    readonly stage?: MotionStage;

    constructor(code: string, message: string, stage?: MotionStage) {
      super(stage ? `${stage} blocked [${code}]: ${message}` : message);
      this.name = "MotionError";
      this.code = code;
      this.stage = stage;
    }
  }

  function contextualizeError(error: unknown, stage: MotionStage): MotionError {
    if (error instanceof MotionError && error.stage === stage) return error;
    return new MotionError(
      error instanceof MotionError ? error.code : `${stage}_FAILED`,
      error instanceof Error
        ? error.message
        : "This motion could not be processed.",
      stage,
    );
  }

  function fail(code: string, message: string): never {
    throw new MotionError(code, message);
  }

  function object(value: unknown, label: string): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("SCHEMA", `${label} must be an object.`);
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("SCHEMA", `${label} must be a plain data object.`);
    }
    return value as Record<string, unknown>;
  }

  function keys(
    value: Record<string, unknown>,
    required: string[],
    optional: string[] = [],
  ): void {
    for (const key of Reflect.ownKeys(value)) {
      if (
        typeof key !== "string" ||
        (!required.includes(key) && !optional.includes(key))
      ) {
        fail("SCHEMA", `Unknown field: ${String(key)}.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor))
        fail("SCHEMA", "Accessors are not data.");
    }
    for (const key of required) {
      if (!Object.hasOwn(value, key)) fail("SCHEMA", `Missing field: ${key}.`);
    }
  }

  function number(
    value: unknown,
    minimum: number,
    maximum: number,
    label: string,
  ): number {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    ) {
      fail(
        "NUMBER",
        `${label} must be finite and between ${minimum} and ${maximum}.`,
      );
    }
    return value;
  }

  function string(value: unknown, maximum: number, label: string): string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximum
    ) {
      fail(
        "SCHEMA",
        `${label} must be a nonempty string of at most ${maximum} characters.`,
      );
    }
    return value;
  }

  const numeric = "[+-]?(?:\\d+|\\d*\\.\\d+)(?:[eE][+-]?\\d+)?";
  const numericPattern = new RegExp(`^${numeric}$`);
  const pixelPattern = new RegExp(`^(${numeric})(px)?$`);
  const anglePattern = new RegExp(`^(${numeric})(deg|rad|turn)$`);

  function scalar(value: string, maximum: number): boolean {
    return (
      numericPattern.test(value) &&
      Number.isFinite(Number(value)) &&
      Math.abs(Number(value)) <= maximum
    );
  }

  function pixel(value: string): boolean {
    const match = pixelPattern.exec(value);
    return (
      !!match &&
      scalar(match[1]!, 100000) &&
      (match[2] === "px" || Number(match[1]) === 0)
    );
  }

  function validateEasing(value: unknown): string {
    const easing = string(value, 256, "Easing").trim();
    if (
      /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(
        easing,
      )
    )
      return easing;
    const bezier = /^cubic-bezier\(([^()]*)\)$/.exec(easing);
    if (bezier) {
      const parts = bezier[1]!.split(",").map((part) => part.trim());
      if (parts.length === 4 && parts.every((part) => scalar(part, 100))) {
        const values = parts.map(Number);
        if (
          values[0]! >= 0 &&
          values[0]! <= 1 &&
          values[2]! >= 0 &&
          values[2]! <= 1
        )
          return easing;
      }
    }
    const steps =
      /^steps\(\s*([1-9]\d{0,3})\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.exec(
        easing,
      );
    if (
      steps &&
      Number(steps[1]) <= 1000 &&
      !(steps[2] === "jump-none" && Number(steps[1]) < 2)
    )
      return easing;
    return fail(
      "EASING",
      "Unsupported easing. Use standard ease, cubic-bezier(), or steps().",
    );
  }

  function validateTransform(value: unknown): string {
    const transform = string(value, 4096, "Transform").trim();
    if (transform === "none") return transform;
    const matcher = /([a-zA-Z]+)\(([^()]*)\)/g;
    let end = 0;
    let count = 0;
    for (const match of transform.matchAll(matcher)) {
      if (transform.slice(end, match.index).trim() !== "")
        fail("TRANSFORM", "Unsupported transform syntax.");
      end = match.index + match[0].length;
      count++;
      if (count > 16)
        fail("TRANSFORM", "At most 16 transform functions are supported.");
      const name = match[1]!;
      const parts = match[2]!.split(",").map((part) => part.trim());
      let valid = false;
      if (name === "translate")
        valid =
          (parts.length === 1 || parts.length === 2) && parts.every(pixel);
      if (name === "translateX" || name === "translateY")
        valid = parts.length === 1 && pixel(parts[0]!);
      if (name === "scale")
        valid =
          (parts.length === 1 || parts.length === 2) &&
          parts.every((part) => scalar(part, 1000));
      if (name === "scaleX" || name === "scaleY")
        valid = parts.length === 1 && scalar(parts[0]!, 1000);
      if (name === "matrix")
        valid =
          parts.length === 6 && parts.every((part) => scalar(part, 100000));
      if (name === "rotate" && parts.length === 1) {
        const angle = anglePattern.exec(parts[0]!);
        valid = (!!angle && scalar(angle[1]!, 1000000)) || parts[0] === "0";
      }
      if (!valid)
        fail(
          "TRANSFORM",
          "Only absolute-pixel 2D translate, rotate, scale, and matrix transforms are supported.",
        );
    }
    if (!count || transform.slice(end).trim() !== "")
      fail("TRANSFORM", "Unsupported transform syntax.");
    return transform;
  }

  function validateOrigin(value: unknown): string {
    const origin = string(value, 128, "Transform origin").trim();
    const parts = origin.split(/\s+/);
    if ((parts.length !== 2 && parts.length !== 3) || !parts.every(pixel)) {
      fail(
        "CONTEXT",
        "Transform origin must contain two absolute pixel coordinates and an optional zero z-coordinate.",
      );
    }
    if (parts.length === 3 && parseFloat(parts[2]!) !== 0)
      fail("CONTEXT", "3D transform origins are unsupported.");
    return parts.slice(0, 2).join(" ");
  }

  function parseRecipe(input: unknown): MotionRecipe {
    let value: unknown = input;
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).length > 65536)
        fail("SIZE", "Recipes are limited to 64 KiB.");
      try {
        value = JSON.parse(input);
      } catch {
        fail("JSON", "This file is not valid JSON.");
      }
    }
    const recipe = object(value, "Recipe");
    keys(recipe, [
      "version",
      "status",
      "keyframes",
      "timing",
      "context",
      "originalDuration",
    ]);
    if (recipe.version !== 1)
      fail("VERSION", "Only MotionPaste recipe version 1 is supported.");
    if (recipe.status !== "captured" && recipe.status !== "edited")
      fail("SCHEMA", "Invalid recipe status.");
    if (
      !Array.isArray(recipe.keyframes) ||
      recipe.keyframes.length < 2 ||
      recipe.keyframes.length > 128
    ) {
      fail("KEYFRAMES", "Recipes need between 2 and 128 keyframes.");
    }
    // Reject custom array fields and holes as well as accessor-backed frames.
    for (const key of Reflect.ownKeys(recipe.keyframes)) {
      if (key === "length") continue;
      if (
        typeof key !== "string" ||
        !/^(0|[1-9]\d*)$/.test(key) ||
        Number(key) >= recipe.keyframes.length
      ) {
        fail("SCHEMA", "Keyframes must be an ordinary data array.");
      }
      if (!("value" in Object.getOwnPropertyDescriptor(recipe.keyframes, key)!))
        fail("SCHEMA", "Accessors are not data.");
    }
    const frames: MotionKeyframe[] = [];
    for (let i = 0; i < recipe.keyframes.length; i++) {
      const frame = object(recipe.keyframes[i], "Keyframe");
      keys(frame, ["offset", "easing"], ["transform", "opacity"]);
      const normalized: MotionKeyframe = {
        offset: number(frame.offset, 0, 1, "Offset"),
        easing: validateEasing(frame.easing),
      };
      if (Object.hasOwn(frame, "transform"))
        normalized.transform = validateTransform(frame.transform);
      if (Object.hasOwn(frame, "opacity"))
        normalized.opacity = number(frame.opacity, 0, 1, "Opacity");
      if (
        normalized.transform === undefined &&
        normalized.opacity === undefined
      )
        fail("KEYFRAMES", "Every frame must animate transform or opacity.");
      if (i > 0 && normalized.offset < frames[i - 1]!.offset)
        fail("KEYFRAMES", "Keyframe offsets must be ordered.");
      frames.push(normalized);
    }
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    if (first.offset !== 0 || last.offset !== 1)
      fail("ENDPOINTS", "Explicit keyframes at offsets 0 and 1 are required.");
    for (const property of ["transform", "opacity"] as const) {
      if (
        frames.some((frame) => frame[property] !== undefined) &&
        (first[property] === undefined || last[property] === undefined)
      ) {
        fail(
          "ENDPOINTS",
          `The first and last frame must explicitly define ${property}.`,
        );
      }
    }
    const timing = object(recipe.timing, "Timing");
    keys(timing, [
      "duration",
      "delay",
      "endDelay",
      "iterations",
      "iterationStart",
      "direction",
      "easing",
      "fill",
    ]);
    if (timing.fill !== "both")
      fail("FILL_UNSUPPORTED", "Only fill: both is supported.");
    if (
      timing.direction !== "normal" &&
      timing.direction !== "reverse" &&
      timing.direction !== "alternate" &&
      timing.direction !== "alternate-reverse"
    ) {
      fail("SCHEMA", "Unsupported playback direction.");
    }
    const duration = number(timing.duration, 1, 60000, "Duration");
    const iterations = number(timing.iterations, 1, 100, "Iterations");
    if (duration * iterations > 3600000)
      fail("TIMING", "Active animation time must not exceed one hour.");
    const context = object(recipe.context, "Context");
    keys(context, ["transformOrigin"]);
    const result: MotionRecipe = {
      version: 1,
      status: recipe.status,
      keyframes: frames,
      timing: {
        duration,
        delay: number(timing.delay, -60000, 60000, "Delay"),
        endDelay: number(timing.endDelay, -60000, 60000, "End delay"),
        iterations,
        iterationStart: number(
          timing.iterationStart,
          0,
          100,
          "Iteration start",
        ),
        direction: timing.direction,
        easing: validateEasing(timing.easing),
        fill: "both",
      },
      context: { transformOrigin: validateOrigin(context.transformOrigin) },
      originalDuration: number(
        recipe.originalDuration,
        1,
        60000,
        "Original duration",
      ),
    };
    if (result.status === "captured" && result.originalDuration !== duration)
      fail("SCHEMA", "Captured duration must match originalDuration.");
    if (new TextEncoder().encode(JSON.stringify(value)).length > 65536)
      fail("SIZE", "Recipes are limited to 64 KiB.");
    return result;
  }

  function assertContext(element: HTMLElement): void {
    const view = element.ownerDocument.defaultView;
    if (!view) fail("TARGET", "The element must belong to a window.");
    if (
      element.getRootNode() !== element.ownerDocument ||
      element.assignedSlot
    ) {
      fail(
        "CONTEXT",
        "Shadow-tree and slotted elements are unsupported in this version.",
      );
    }
    const style = view.getComputedStyle(element);
    for (const property of ["translate", "rotate", "scale", "offset-path"]) {
      const value = style.getPropertyValue(property);
      if (value && value !== "none")
        fail("CONTEXT", `Independent ${property} is unsupported.`);
    }
    if (style.transformStyle === "preserve-3d")
      fail("CONTEXT", "3D transform contexts are unsupported.");
    if (
      style.transformBox &&
      style.transformBox !== "view-box" &&
      style.transformBox !== "border-box"
    ) {
      fail("CONTEXT", "Only the default HTML transform box is supported.");
    }
    for (
      let ancestor: Element | null = element;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const ancestorStyle = view.getComputedStyle(ancestor);
      if (
        (ancestorStyle.perspective && ancestorStyle.perspective !== "none") ||
        ancestorStyle.transformStyle === "preserve-3d"
      ) {
        fail(
          "CONTEXT",
          "Perspective and preserve-3d ancestors are unsupported.",
        );
      }
    }
  }

  /** !important declarations win over animations, so raw keyframes alone are
   * not sufficient evidence of the visible effect. Unreadable CSS fails closed. */
  function assertWritableProperties(
    element: HTMLElement,
    properties: string[],
  ): void {
    const guarded = [...properties, "all"];
    function hasImportant(style: CSSStyleDeclaration): boolean {
      return guarded.some(
        (property) => style.getPropertyPriority(property) === "important",
      );
    }
    if (hasImportant(element.style))
      fail(
        "IMPORTANT_STYLE",
        "An inline !important declaration overrides this motion.",
      );
    const seen = new Set<CSSStyleSheet>();
    function inspectSheet(sheet: CSSStyleSheet): void {
      if (seen.has(sheet) || sheet.disabled) return;
      seen.add(sheet);
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        fail(
          "STYLESHEET_ACCESS",
          "This page has a stylesheet that cannot be inspected, so !important overrides cannot be ruled out. Use a page with readable stylesheets; this check cannot be bypassed.",
        );
      }
      inspectRules(rules);
    }
    function inspectRules(rules: CSSRuleList, scoped = false): void {
      for (const rule of Array.from(rules)) {
        if ("styleSheet" in rule) {
          const imported = (rule as CSSImportRule).styleSheet;
          if (imported) inspectSheet(imported);
        }
        if ("selectorText" in rule && "style" in rule) {
          const styleRule = rule as CSSStyleRule;
          if (hasImportant(styleRule.style)) {
            // Element.matches() cannot reconstruct CSS nesting or stylesheet
            // scoping roots. Reject these declarations conservatively, even
            // when the scope/conditional rule might currently be inactive.
            if (
              scoped ||
              styleRule.selectorText.includes("&") ||
              /:scope\b/i.test(styleRule.selectorText) ||
              styleRule.selectorText.includes("\\")
            )
              fail(
                "IMPORTANT_STYLE",
                "A scoped, nested, or escaped !important rule prevents reliable motion inspection.",
              );
            let matches = false;
            try {
              matches = element.matches(styleRule.selectorText);
            } catch {
              fail(
                "IMPORTANT_STYLE",
                "An !important selector cannot be reliably inspected.",
              );
            }
            if (matches)
              fail(
                "IMPORTANT_STYLE",
                "A stylesheet !important declaration overrides this motion.",
              );
          }
        }
        if ("cssRules" in rule)
          inspectRules(
            (rule as CSSGroupingRule).cssRules,
            scoped || /^\s*@scope(?:\s|\(|\{)/i.test(rule.cssText),
          );
      }
    }
    for (const sheet of Array.from(element.ownerDocument.styleSheets))
      inspectSheet(sheet);
    for (const sheet of element.ownerDocument.adoptedStyleSheets)
      inspectSheet(sheet);
  }

  // Independent exported scripts must share ownership too: direct cancel()
  // queues an event that can arrive after a newer script starts playback.
  // The registry contains only weak target references and is created on replay.
  const originOwnerKey = Symbol.for("MotionPaste.transformOriginOwners.v1");

  function originOwnersFor(
    target: HTMLElement,
  ): WeakMap<HTMLElement, () => void> {
    const view = target.ownerDocument.defaultView!;
    const existing: unknown = Reflect.get(view, originOwnerKey);
    if (existing !== undefined) {
      if (!(existing instanceof view.WeakMap))
        fail("TARGET", "The motion ownership registry is unavailable.");
      return existing as WeakMap<HTMLElement, () => void>;
    }
    const owners = new view.WeakMap<HTMLElement, () => void>();
    Object.defineProperty(view, originOwnerKey, { value: owners });
    return owners;
  }

  function replayMotion(
    target: HTMLElement,
    input: MotionRecipe,
    options: ReplayOptions = {},
  ): MotionHandle {
    try {
      return applyMotion(target, input, options);
    } catch (error) {
      throw contextualizeError(error, "APPLY");
    }
  }

  function applyMotion(
    target: HTMLElement,
    input: MotionRecipe,
    options: ReplayOptions,
  ): MotionHandle {
    const recipe = parseRecipe(input);
    const view = target?.ownerDocument?.defaultView;
    if (!view || !(target instanceof view.HTMLElement) || !target.isConnected)
      fail("TARGET", "Choose a connected HTML target element.");
    if (
      view.matchMedia("(prefers-reduced-motion: reduce)").matches &&
      options.allowReducedMotion !== true
    ) {
      fail(
        "REDUCED_MOTION",
        "Playback is blocked by your reduced-motion preference. Explicitly opt in to preview.",
      );
    }
    if (target.getAnimations().length !== 0)
      fail(
        "TARGET_CONFLICT",
        "Cancel the target's existing animations before applying motion.",
      );
    assertContext(target);
    assertWritableProperties(
      target,
      ["transform", "opacity"].filter((property) =>
        recipe.keyframes.some((frame) => Object.hasOwn(frame, property)),
      ),
    );
    const transforms = recipe.keyframes.some(
      (frame) => frame.transform !== undefined,
    );
    // The parser deliberately accepts only a small CSS subset. The destination
    // browser must also accept every value before any target style is changed.
    for (const frame of recipe.keyframes) {
      if (
        frame.transform !== undefined &&
        !view.CSS.supports("transform", frame.transform)
      )
        fail("TRANSFORM", "The browser does not support this transform.");
      if (!view.CSS.supports("animation-timing-function", frame.easing))
        fail("EASING", "The browser does not support this keyframe easing.");
    }
    if (!view.CSS.supports("animation-timing-function", recipe.timing.easing))
      fail("EASING", "The browser does not support this timing easing.");
    if (
      transforms &&
      !view.CSS.supports("transform-origin", recipe.context.transformOrigin)
    )
      fail("CONTEXT", "The browser does not support this transform origin.");
    const computed = view.getComputedStyle(target);
    if (
      transforms &&
      computed.transitionProperty
        .split(",")
        .some((property) =>
          ["all", "transform-origin"].includes(property.trim()),
        ) &&
      computed.transitionDuration
        .split(",")
        .some((duration) => parseFloat(duration) > 0)
    ) {
      fail(
        "TARGET_CONFLICT",
        "A transform-origin transition would interfere with playback.",
      );
    }
    const originOwners = originOwnersFor(target);
    // Retire a cancelled handle synchronously before taking the next snapshot.
    originOwners.get(target)?.();
    const previousOrigin = target.style.getPropertyValue("transform-origin");
    const previousPriority =
      target.style.getPropertyPriority("transform-origin");
    let restored = false;
    let appliedOrigin = "";
    let appliedPriority = "";
    const restore = (): void => {
      if (restored) return;
      restored = true;
      if (!transforms || originOwners.get(target) !== restore) return;
      originOwners.delete(target);
      // A caller can edit styles while playback is active. Cleanup only owns
      // the exact declaration it installed, including the browser's canonical
      // serialization and priority; it must preserve a later caller edit.
      if (
        target.style.getPropertyValue("transform-origin") !== appliedOrigin ||
        target.style.getPropertyPriority("transform-origin") !== appliedPriority
      )
        return;
      if (previousOrigin)
        target.style.setProperty(
          "transform-origin",
          previousOrigin,
          previousPriority,
        );
      else target.style.removeProperty("transform-origin");
    };
    if (transforms) {
      target.style.setProperty(
        "transform-origin",
        recipe.context.transformOrigin,
        "important",
      );
      appliedOrigin = target.style.getPropertyValue("transform-origin");
      appliedPriority = target.style.getPropertyPriority("transform-origin");
      originOwners.set(target, restore);
    }
    let animation: Animation;
    try {
      animation = target.animate(
        recipe.keyframes.map((frame) => ({ ...frame })),
        recipe.timing,
      );
    } catch {
      restore();
      fail("PLAYBACK", "The browser could not apply this motion.");
    }
    animation.addEventListener("cancel", restore, { once: true });
    return {
      animation,
      cancel() {
        animation.cancel();
        restore();
      },
    };
  }

  function editDuration(input: MotionRecipe, duration: number): MotionRecipe {
    const recipe = parseRecipe(input);
    recipe.timing.duration = duration;
    recipe.status = "edited";
    return parseRecipe(recipe);
  }

  return {
    MotionError,
    contextualizeError,
    parseRecipe,
    replayMotion,
    editDuration,
    assertContext,
    assertWritableProperties,
  };
}

export const {
  MotionError,
  contextualizeError,
  parseRecipe,
  replayMotion,
  editDuration,
  assertContext,
  assertWritableProperties,
} = createMotionRuntime();
