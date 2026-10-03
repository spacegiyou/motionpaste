import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import {
  captureMotion,
  editDuration,
  exportJavaScript,
  MotionError,
  parseRecipe,
  replayMotion,
} from "../src/core/index";
import { createMotionRuntime } from "../src/core/runtime";
import type { MotionRecipe } from "../src/core/index";

function recipe(): MotionRecipe {
  return {
    version: 1,
    status: "captured",
    keyframes: [
      {
        offset: 0,
        easing: "ease-in",
        transform: "translateX(0px) rotate(0deg)",
        opacity: 0.2,
      },
      {
        offset: 0.5,
        easing: "linear",
        transform: "translateX(60px) rotate(12deg)",
        opacity: 0.8,
      },
      {
        offset: 1,
        easing: "linear",
        transform: "translateX(0px) rotate(0deg)",
        opacity: 1,
      },
    ],
    timing: {
      duration: 1200,
      delay: 200,
      endDelay: 100,
      iterations: 2,
      iterationStart: 0.2,
      direction: "alternate",
      easing: "ease-in-out",
      fill: "both",
    },
    context: { transformOrigin: "40px 30px" },
    originalDuration: 1200,
  };
}

function rejects(code: string, callback: () => unknown): void {
  assert.throws(
    callback,
    (error: unknown) => error instanceof MotionError && error.code === code,
  );
}

test("parse produces detached data and round-trips JSON", () => {
  const input = recipe();
  const output = parseRecipe(input);
  assert.deepEqual(output, input);
  assert.deepEqual(parseRecipe(JSON.stringify(input)), input);
  output.keyframes[0]!.opacity = 0;
  assert.equal(input.keyframes[0]!.opacity, 0.2);
});

test("duration edits preserve original timing provenance and leave input untouched", () => {
  const input = recipe();
  const edited = editDuration(input, 600);
  assert.equal(edited.status, "edited");
  assert.equal(edited.originalDuration, 1200);
  assert.equal(edited.timing.duration, 600);
  assert.equal(input.timing.duration, 1200);
  rejects("NUMBER", () => editDuration(input, Infinity));
});

test("size, syntax, version, and unknown fields are checked at import boundary", () => {
  rejects("SIZE", () => parseRecipe(" ".repeat(65537)));
  rejects("JSON", () => parseRecipe("{ broken"));
  rejects("VERSION", () => parseRecipe({ ...recipe(), version: 2 }));
  rejects("SCHEMA", () =>
    parseRecipe({ ...recipe(), sourceUrl: "https://private.invalid" }),
  );
  rejects("SCHEMA", () =>
    parseRecipe({
      ...recipe(),
      context: { transformOrigin: "0px 0px", secret: true },
    }),
  );
  rejects("SCHEMA", () =>
    parseRecipe(JSON.parse('{"__proto__":{},"version":1}')),
  );
  rejects("SCHEMA", () => parseRecipe(new Date()));
  rejects("SCHEMA", () => parseRecipe(null));
});

test("accessors and custom arrays never execute as recipe data", () => {
  let reads = 0;
  const input = recipe();
  Object.defineProperty(input, "timing", {
    get() {
      reads++;
      return {};
    },
    enumerable: true,
  });
  rejects("SCHEMA", () => parseRecipe(input));
  assert.equal(reads, 0);
  const arrayInput = recipe();
  Object.defineProperty(arrayInput.keyframes, "0", {
    get() {
      reads++;
      return {};
    },
  });
  rejects("SCHEMA", () => parseRecipe(arrayInput));
  assert.equal(reads, 0);
  const custom = recipe();
  Object.defineProperty(custom.keyframes, "privateData", { value: "no" });
  rejects("SCHEMA", () => parseRecipe(custom));
});

test("bounded finite timings reject unbounded or inconsistent recipes", () => {
  for (const [key, value] of [
    ["duration", NaN],
    ["iterations", Infinity],
    ["delay", 60001],
    ["endDelay", -60001],
    ["iterationStart", -1],
  ] as const) {
    const input = recipe();
    input.timing[key] = value;
    rejects("NUMBER", () => parseRecipe(input));
  }
  const long = recipe();
  long.timing.duration = long.originalDuration = 60000;
  long.timing.iterations = 100;
  rejects("TIMING", () => parseRecipe(long));
  const inconsistent = recipe();
  inconsistent.originalDuration = 1000;
  rejects("SCHEMA", () => parseRecipe(inconsistent));
  rejects("FILL_UNSUPPORTED", () =>
    parseRecipe({
      ...recipe(),
      timing: { ...recipe().timing, fill: "forwards" },
    }),
  );
});

test("keyframes must be bounded, ordered, and have independently explicit endpoints", () => {
  const oversized = recipe();
  oversized.keyframes = Array.from({ length: 129 }, () => ({
    ...recipe().keyframes[0]!,
  }));
  rejects("KEYFRAMES", () => parseRecipe(oversized));
  const unordered = recipe();
  unordered.keyframes[0]!.offset = 0.8;
  rejects("KEYFRAMES", () => parseRecipe(unordered));
  const unresolved = recipe();
  unresolved.keyframes[0]!.offset = 0.1;
  rejects("ENDPOINTS", () => parseRecipe(unresolved));
  const propertyEndpoint = recipe();
  delete propertyEndpoint.keyframes[0]!.opacity;
  rejects("ENDPOINTS", () => parseRecipe(propertyEndpoint));
  const sparse = recipe();
  delete sparse.keyframes[1];
  rejects("SCHEMA", () => parseRecipe(sparse));
});

for (const transform of [
  "translateX(50%)",
  "translateX(1em)",
  "translateX(var(--x))",
  "translate3d(1px, 2px, 0px)",
  "rotateX(1deg)",
  "skew(20deg)",
  "url(https://invalid)",
  "translateX(1px); color:red",
  "matrix(1, 0, 0, 1, 0, Infinity)",
  "scale(1e999)",
  "translateX(1.px)",
  "rotate(1.deg)",
  "scale(1.)",
  "matrix(1., 0, 0, 1, 0, 0)",
  "translateX(1px)".repeat(17),
]) {
  test(`reject transform: ${transform.slice(0, 60)}`, () => {
    const input = recipe();
    input.keyframes[0]!.transform = transform;
    rejects("TRANSFORM", () => parseRecipe(input));
  });
}

test("supported absolute 2D transform grammar survives exactly", () => {
  for (const transform of [
    "none",
    "translate(10px, -2.5px) scale(1.2, -1) rotate(0.25turn)",
    "matrix(1, 0, 0, 1, 20, -8)",
    "rotate(1rad) translateY(0)",
    "scaleX(.2) scaleY(2e-1)",
  ]) {
    const input = recipe();
    input.keyframes[0]!.transform = transform;
    assert.equal(parseRecipe(input).keyframes[0]!.transform, transform);
  }
});

test("easing permits standard cubic and step curves, never arbitrary CSS", () => {
  for (const easing of [
    "linear",
    "ease",
    "step-start",
    "cubic-bezier(0.2, -1, 0.6, 2)",
    "steps(4, end)",
    "steps(2, jump-none)",
    "steps(3)",
  ]) {
    const input = recipe();
    input.timing.easing = easing;
    assert.equal(parseRecipe(input).timing.easing, easing);
  }
  for (const easing of [
    "cubic-bezier(-1, 0, 1, 1)",
    "steps(1, jump-none)",
    "steps(0)",
    "steps(1001)",
    "linear(0, 1)",
    "ease; color: red",
    "var(--ease)",
    "cubic-bezier(0., 0, 1, 1)",
  ]) {
    const input = recipe();
    input.timing.easing = easing;
    rejects("EASING", () => parseRecipe(input));
  }
});

test("origin is an absolute two-dimensional contract", () => {
  const input = recipe();
  input.context.transformOrigin = "40px 30px 0px";
  assert.equal(parseRecipe(input).context.transformOrigin, "40px 30px");
  for (const origin of [
    "50% 50%",
    "center center",
    "0px 0px 3px",
    "0px 0px; color:red",
    "1.px 2px",
  ]) {
    input.context.transformOrigin = origin;
    rejects("CONTEXT", () => parseRecipe(input));
  }
});

test("object byte limits apply before normalization removes padding", () => {
  const input = recipe();
  input.keyframes = Array.from({ length: 20 }, (_, i) => ({
    offset: i / 19,
    easing: "linear",
    transform: "none" + " ".repeat(4000),
  }));
  rejects("SIZE", () => parseRecipe(input));
});

class FakeStyle {
  values = new Map<string, { value: string; priority: string }>();
  getPropertyValue(name: string) {
    return this.values.get(name)?.value ?? "";
  }
  getPropertyPriority(name: string) {
    return this.values.get(name)?.priority ?? "";
  }
  setProperty(name: string, value: string, priority = "") {
    this.values.set(name, { value, priority });
  }
  removeProperty(name: string) {
    this.values.delete(name);
    return "";
  }
}

class FakeAnimation extends EventTarget {
  playbackRate = 1;
  timeline: object = {};
  effect: FakeEffect | null = null;
  cancels = 0;
  cancel() {
    this.cancels++;
    this.dispatchEvent(new Event("cancel"));
  }
}

class FakeEffect {
  composite = "replace";
  iterationComposite = "replace";
  pseudoElement: string | null = null;
  target: FakeElement;
  frames: Record<string, unknown>[];
  timing: object = recipe().timing;
  constructor(target: FakeElement) {
    this.target = target;
    this.frames = recipe().keyframes.map((frame) => ({
      ...frame,
      computedOffset: frame.offset,
      composite: "auto",
    }));
  }
  getKeyframes() {
    return this.frames;
  }
  getTiming() {
    return this.timing;
  }
}

class FakeElement {
  isConnected = true;
  parentElement: FakeElement | null = null;
  style = new FakeStyle();
  ownerDocument: {
    defaultView?: object;
    timeline: object;
    styleSheets: object[];
    adoptedStyleSheets: object[];
  } = { timeline: {}, styleSheets: [], adoptedStyleSheets: [] };
  animations: FakeAnimation[] = [];
  animation = new FakeAnimation();
  applied: unknown[] = [];
  failAnimate = false;
  computed = {
    transformOrigin: "40px 30px",
    transformStyle: "flat",
    transformBox: "view-box",
    perspective: "none",
    transitionProperty: "all",
    transitionDuration: "0s",
    properties: new Map<string, string>(),
    getPropertyValue(name: string) {
      return this.properties.get(name) ?? "none";
    },
  };
  getAnimations() {
    return this.animations;
  }
  getRootNode() {
    return this.ownerDocument;
  }
  matches(selector: string) {
    return selector === ".matches";
  }
  animate(...args: unknown[]) {
    if (this.failAnimate) throw new Error("Browser rejected effect");
    this.applied = args;
    return this.animation;
  }
}

function environment(reducedMotion = false) {
  const element = new FakeElement();
  const view = {
    HTMLElement: FakeElement,
    KeyframeEffect: FakeEffect,
    getComputedStyle: (target: FakeElement) => target.computed,
    matchMedia: () => ({ matches: reducedMotion }),
    CSS: {
      supports: (() => true) as (property: string, value: string) => boolean,
    },
    WeakMap,
  };
  element.ownerDocument.defaultView = view;
  return { element, target: element as unknown as HTMLElement, view };
}

function source() {
  const env = environment();
  const animation = new FakeAnimation();
  animation.timeline = env.element.ownerDocument.timeline;
  const effect = new FakeEffect(env.element);
  animation.effect = effect;
  env.element.animations = [animation];
  return { ...env, animation, effect };
}

test("capture reads actual keyframes without mutating source style, time, or effect", () => {
  const { element, target, animation, effect } = source();
  const before = JSON.stringify(effect.frames);
  assert.deepEqual(captureMotion(target), recipe());
  assert.equal(element.style.values.size, 0);
  assert.equal(element.applied.length, 0);
  assert.equal(animation.cancels, 0);
  assert.equal(JSON.stringify(effect.frames), before);
});

test("capture refuses unsupported effects, properties, and time/composition contexts", () => {
  const noAnimation = environment();
  rejects("NO_ANIMATION", () => captureMotion(noAnimation.target));
  const multiple = source();
  multiple.element.animations.push(new FakeAnimation());
  rejects("MULTIPLE_ANIMATIONS", () => captureMotion(multiple.target));
  const transition = source();
  Object.assign(transition.animation, { transitionProperty: "opacity" });
  rejects("TRANSITION", () => captureMotion(transition.target));
  const rate = source();
  rate.animation.playbackRate = 2;
  rejects("PLAYBACK_RATE", () => captureMotion(rate.target));
  const timeline = source();
  timeline.animation.timeline = {};
  rejects("TIMELINE", () => captureMotion(timeline.target));
  const additive = source();
  additive.effect.composite = "add";
  rejects("COMPOSITE", () => captureMotion(additive.target));
  const property = source();
  property.effect.frames[0]!.backgroundColor = "red";
  rejects("UNSUPPORTED_PROPERTY", () => captureMotion(property.target));
  const pseudo = source();
  pseudo.effect.pseudoElement = "::before";
  rejects("EFFECT", () => captureMotion(pseudo.target));
});

test("Chrome's missing iterationComposite uses the default; explicit accumulation is blocked", () => {
  const standard = source();
  Reflect.deleteProperty(standard.effect, "iterationComposite");
  assert.deepEqual(captureMotion(standard.target), recipe());
  const accumulated = source();
  accumulated.effect.iterationComposite = "accumulate";
  rejects("COMPOSITE", () => captureMotion(accumulated.target));
});

test("important styles cannot silently mask captured or replayed motion", () => {
  const inlineSource = source();
  inlineSource.element.style.setProperty("opacity", ".9", "important");
  rejects("IMPORTANT_STYLE", () => captureMotion(inlineSource.target));
  const inlineTarget = environment();
  inlineTarget.element.style.setProperty("transform", "none", "important");
  rejects("IMPORTANT_STYLE", () => replayMotion(inlineTarget.target, recipe()));
  const stylesheet = source();
  const style = new FakeStyle();
  style.setProperty("opacity", ".9", "important");
  stylesheet.element.ownerDocument.styleSheets.push({
    cssRules: [{ selectorText: ".matches", style }],
  });
  rejects("IMPORTANT_STYLE", () => captureMotion(stylesheet.target));
  const nested = environment();
  nested.element.ownerDocument.adoptedStyleSheets.push({
    cssRules: [{ cssRules: [{ selectorText: "& > div", style }] }],
  });
  rejects("IMPORTANT_STYLE", () => replayMotion(nested.target, recipe()));
});

test("unreadable CSS and unsupported shadow contexts fail closed", () => {
  const unreadable = source();
  unreadable.element.ownerDocument.styleSheets.push({
    get cssRules() {
      throw new Error("Cross-origin SecurityError");
    },
  });
  rejects("STYLESHEET_ACCESS", () => captureMotion(unreadable.target));
  const shadow = source();
  shadow.element.getRootNode = () => new FakeElement().ownerDocument;
  rejects("CONTEXT", () => captureMotion(shadow.target));
});

test("successful capture still reports APPLY when the target stylesheet is unreadable", () => {
  const captured = captureMotion(source().target);
  for (const stage of ["CAPTURE", "APPLY"] as const) {
    const context = stage === "CAPTURE" ? source() : environment();
    context.element.ownerDocument.styleSheets.push({
      get cssRules() {
        throw new Error("Cross-origin SecurityError");
      },
    });
    assert.throws(
      () =>
        stage === "CAPTURE"
          ? captureMotion(context.target)
          : replayMotion(context.target, captured),
      (error: unknown) => {
        assert.ok(error instanceof MotionError);
        assert.equal(error.code, "STYLESHEET_ACCESS");
        assert.equal(error.stage, stage);
        assert.match(
          error.message,
          new RegExp(`^${stage} blocked \\[STYLESHEET_ACCESS\\]:`),
        );
        assert.match(error.message, /readable stylesheets/);
        assert.doesNotMatch(error.message, /Capture cannot/);
        return true;
      },
    );
    assert.equal(context.element.applied.length, 0);
    assert.equal(context.element.style.values.size, 0);
  }
});

test("capture and apply diagnostics retain actionable rejection codes", () => {
  const multiple = source();
  multiple.element.animations.push(new FakeAnimation());
  assert.throws(() => captureMotion(multiple.target), {
    code: "MULTIPLE_ANIMATIONS",
    stage: "CAPTURE",
  });
  const unsupported = source();
  unsupported.effect.frames[0]!.transform = "translateX(50%)";
  assert.throws(() => captureMotion(unsupported.target), {
    code: "TRANSFORM",
    stage: "CAPTURE",
  });
  const conflicting = environment();
  conflicting.element.style.setProperty("opacity", "0.8", "important");
  assert.throws(() => replayMotion(conflicting.target, recipe()), {
    code: "IMPORTANT_STYLE",
    stage: "APPLY",
  });
  assert.throws(() => replayMotion(environment(true).target, recipe()), {
    code: "REDUCED_MOTION",
    stage: "APPLY",
  });
});

test("scoped important rules cannot bypass element.matches inspection", () => {
  const style = new FakeStyle();
  style.setProperty("opacity", ".9", "important");
  const selector = source();
  selector.element.ownerDocument.styleSheets.push({
    cssRules: [{ selectorText: ":scope .source", style }],
  });
  rejects("IMPORTANT_STYLE", () => captureMotion(selector.target));
  const nested = environment();
  nested.element.ownerDocument.styleSheets.push({
    cssRules: [
      {
        cssText: "@scope (.wrapper) {}",
        cssRules: [
          {
            cssText: "@media all {}",
            cssRules: [{ selectorText: ".not-matching", style }],
          },
        ],
      },
    ],
  });
  rejects("IMPORTANT_STYLE", () => replayMotion(nested.target, recipe()));
});

test("replay uses actual recipe, restores exact origin priority, and cancellation is idempotent", () => {
  const { element, target } = environment();
  element.style.setProperty("transform-origin", "10px 20px", "important");
  const handle = replayMotion(target, recipe());
  assert.equal(element.style.getPropertyValue("transform-origin"), "40px 30px");
  assert.deepEqual(element.applied, [recipe().keyframes, recipe().timing]);
  handle.cancel();
  handle.cancel();
  assert.equal(element.style.getPropertyValue("transform-origin"), "10px 20px");
  assert.equal(
    element.style.getPropertyPriority("transform-origin"),
    "important",
  );
});

test("direct animation cancellation and browser failures clean up injected origin", () => {
  const direct = environment();
  replayMotion(direct.target, recipe()).animation.cancel();
  assert.equal(direct.element.style.values.size, 0);
  const broken = environment();
  broken.element.failAnimate = true;
  rejects("PLAYBACK", () => replayMotion(broken.target, recipe()));
  assert.equal(broken.element.style.values.size, 0);
});

test("opacity-only playback never writes origin or rejects an origin transition", () => {
  const { element, target } = environment();
  const input = recipe();
  for (const frame of input.keyframes) delete frame.transform;
  element.style.setProperty("transform-origin", "12px 34px", "important");
  element.computed.transitionProperty = "transform-origin";
  element.computed.transitionDuration = "1s";
  element.style.setProperty = () => {
    throw new Error("Opacity playback must not write any inline style");
  };
  element.style.removeProperty = () => {
    throw new Error("Opacity cleanup must not write any inline style");
  };
  const handle = replayMotion(target, input);
  handle.cancel();
  handle.cancel();
  assert.equal(element.style.getPropertyValue("transform-origin"), "12px 34px");
});

test("cleanup preserves origin edits and removals made during playback", () => {
  for (const edit of ["value", "priority", "remove"]) {
    const { element, target } = environment();
    element.style.setProperty("transform-origin", "10px 20px", "important");
    const handle = replayMotion(target, recipe());
    if (edit === "remove") element.style.removeProperty("transform-origin");
    else
      element.style.setProperty(
        "transform-origin",
        edit === "value" ? "12px 23px" : "40px 30px",
      );
    const expected = new Map(element.style.values);
    handle.cancel();
    assert.deepEqual(element.style.values, expected, edit);
    element.style.setProperty("transform-origin", "7px 8px");
    handle.cancel();
    assert.equal(element.style.getPropertyValue("transform-origin"), "7px 8px");
  }
});

test("queued cancellation cannot overwrite a newer handle or leak the earlier origin", () => {
  for (const origin of ["40px 30px", "70px 60px"]) {
    const { element, target } = environment();
    element.style.setProperty("transform-origin", "10px 20px", "important");
    const first = replayMotion(target, recipe());
    const firstAnimation = element.animation;
    // Real browsers remove a cancelled animation immediately, then dispatch
    // its cancel event asynchronously. A replacement may start in between.
    firstAnimation.cancel = () => {
      firstAnimation.cancels++;
    };
    first.animation.cancel();
    element.animation = new FakeAnimation();
    const next = recipe();
    next.context.transformOrigin = origin;
    const second = replayMotion(target, next);
    firstAnimation.dispatchEvent(new Event("cancel"));
    first.cancel();
    assert.equal(element.style.getPropertyValue("transform-origin"), origin);
    second.cancel();
    assert.equal(
      element.style.getPropertyValue("transform-origin"),
      "10px 20px",
    );
    assert.equal(
      element.style.getPropertyPriority("transform-origin"),
      "important",
    );
  }
});

test("failed animate preserves an origin edit performed before it throws", () => {
  const { element, target } = environment();
  element.style.setProperty("transform-origin", "10px 20px");
  element.animate = () => {
    element.style.setProperty("transform-origin", "7px 8px");
    throw new Error("Browser rejected effect after a caller changed origin");
  };
  rejects("PLAYBACK", () => replayMotion(target, recipe()));
  assert.equal(element.style.getPropertyValue("transform-origin"), "7px 8px");
});

test("separate standalone runtime instances share target ownership", () => {
  const { element, target } = environment();
  element.style.setProperty("transform-origin", "10px 20px");
  const first = createMotionRuntime().replayMotion(target, recipe());
  const firstAnimation = element.animation;
  firstAnimation.cancel = () => {
    firstAnimation.cancels++;
  };
  first.animation.cancel();
  element.animation = new FakeAnimation();
  const second = createMotionRuntime().replayMotion(target, recipe());
  firstAnimation.dispatchEvent(new Event("cancel"));
  assert.equal(element.style.getPropertyValue("transform-origin"), "40px 30px");
  second.cancel();
  assert.equal(element.style.getPropertyValue("transform-origin"), "10px 20px");
});

test("destination CSS rejection fails before styles or animations are changed", () => {
  for (const [property, value, code] of [
    ["transform", "translateX(60px) rotate(12deg)", "TRANSFORM"],
    ["animation-timing-function", "ease-in", "EASING"],
    ["animation-timing-function", "ease-in-out", "EASING"],
    ["transform-origin", "40px 30px", "CONTEXT"],
  ]) {
    const { element, target, view } = environment();
    element.style.setProperty("transform-origin", "10px 20px");
    const before = new Map(element.style.values);
    view.CSS.supports = (name, data) => name !== property || data !== value;
    rejects(code!, () => replayMotion(target, recipe()));
    assert.deepEqual(element.style.values, before);
    assert.equal(element.applied.length, 0);
  }
});

test("reduced motion, target conflicts, detached elements, and 3D contexts block before mutation", () => {
  const reduced = environment(true);
  rejects("REDUCED_MOTION", () => replayMotion(reduced.target, recipe()));
  assert.equal(reduced.element.style.values.size, 0);
  replayMotion(reduced.target, recipe(), { allowReducedMotion: true }).cancel();
  const conflict = environment();
  conflict.element.animations = [new FakeAnimation()];
  rejects("TARGET_CONFLICT", () => replayMotion(conflict.target, recipe()));
  const detached = environment();
  detached.element.isConnected = false;
  rejects("TARGET", () => replayMotion(detached.target, recipe()));
  const perspective = environment();
  perspective.element.computed.perspective = "1000px";
  rejects("CONTEXT", () => replayMotion(perspective.target, recipe()));
  const independent = environment();
  independent.element.computed.properties.set("translate", "20px");
  rejects("CONTEXT", () => replayMotion(independent.target, recipe()));
  const transition = environment();
  transition.element.computed.transitionDuration = "1s";
  rejects("TARGET_CONFLICT", () => replayMotion(transition.target, recipe()));
});

test("export rejects invalid recipes before producing source", () => {
  const input = recipe();
  input.keyframes[0]!.transform = "translateX(var(--user))";
  rejects("TRANSFORM", () => exportJavaScript(input));
});

test("compiled export runs in a fresh JS realm with no modules or automatic target selection", async () => {
  // tsx inserts naming helpers when it loads TypeScript; use the same clean
  // esbuild settings as the distributable to exercise shipped standalone code.
  const built = await build({
    entryPoints: ["src/core/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: false,
    keepNames: false,
  });
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(built.outputFiles[0]!.text).toString("base64")}`;
  const module = (await import(moduleUrl)) as {
    exportJavaScript(input: MotionRecipe): string;
  };
  const script = module.exportJavaScript(recipe());
  const sandbox: {
    window: {
      motionPaste?: (
        target: HTMLElement,
        options?: { allowReducedMotion?: boolean },
      ) => { cancel(): void };
    };
    TextEncoder: typeof TextEncoder;
  } = { window: {}, TextEncoder };
  vm.runInNewContext(script, sandbox, { timeout: 1000 });
  assert.equal(typeof sandbox.window.motionPaste, "function");
  const { element, target } = environment();
  const handle = sandbox.window.motionPaste!(target);
  assert.equal(element.style.getPropertyValue("transform-origin"), "40px 30px");
  handle.cancel();
  assert.equal(element.style.values.size, 0);
  const reduced = environment(true);
  assert.throws(() => sandbox.window.motionPaste!(reduced.target), {
    code: "REDUCED_MOTION",
    stage: "APPLY",
  });
  sandbox.window.motionPaste!(reduced.target, {
    allowReducedMotion: true,
  }).cancel();
  const conflict = environment();
  conflict.element.animations.push(new FakeAnimation());
  assert.throws(() => sandbox.window.motionPaste!(conflict.target), {
    code: "TARGET_CONFLICT",
    stage: "APPLY",
  });
});
