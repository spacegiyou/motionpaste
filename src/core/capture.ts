import {
  assertContext,
  assertWritableProperties,
  contextualizeError,
  MotionError,
  parseRecipe,
} from "./runtime";
import type { MotionKeyframe, MotionRecipe } from "./types";

/** Reads the browser's actual effect without pausing it or mutating source DOM. */
export function captureMotion(element: Element): MotionRecipe {
  try {
    return readMotion(element);
  } catch (error) {
    throw contextualizeError(error, "CAPTURE");
  }
}

function readMotion(element: Element): MotionRecipe {
  const view = element?.ownerDocument?.defaultView;
  if (!view || !(element instanceof view.HTMLElement) || !element.isConnected) {
    throw new MotionError("TARGET", "Choose a connected HTML element.");
  }
  const animations = element.getAnimations();
  if (animations.length === 0)
    throw new MotionError(
      "NO_ANIMATION",
      "This element has no active CSS or Web Animation.",
    );
  if (animations.length !== 1)
    throw new MotionError(
      "MULTIPLE_ANIMATIONS",
      "Choose an element with exactly one animation.",
    );
  const animation = animations[0]!;
  if ("transitionProperty" in animation)
    throw new MotionError(
      "TRANSITION",
      "CSS transitions are not supported in this version.",
    );
  if (animation.playbackRate !== 1)
    throw new MotionError(
      "PLAYBACK_RATE",
      "Only playbackRate: 1 is supported.",
    );
  if (animation.timeline !== element.ownerDocument.timeline)
    throw new MotionError(
      "TIMELINE",
      "Only the document timeline is supported.",
    );
  const effect = animation.effect;
  if (
    !(effect instanceof view.KeyframeEffect) ||
    effect.target !== element ||
    effect.pseudoElement
  ) {
    throw new MotionError(
      "EFFECT",
      "Pseudo-elements and non-element keyframe effects are unsupported.",
    );
  }
  if (
    effect.composite !== "replace" ||
    (effect.iterationComposite !== undefined &&
      effect.iterationComposite !== "replace")
  ) {
    throw new MotionError(
      "COMPOSITE",
      "Additive and accumulating composition are unsupported.",
    );
  }
  assertContext(element);
  const rawFrames = effect.getKeyframes();
  if (rawFrames.length < 2 || rawFrames.length > 128) {
    throw new MotionError(
      "KEYFRAMES",
      "Capture needs between 2 and 128 keyframes.",
    );
  }
  assertWritableProperties(
    element,
    ["transform", "opacity"].filter((property) =>
      rawFrames.some((frame) => Object.hasOwn(frame, property)),
    ),
  );
  const frames: MotionKeyframe[] = rawFrames.map((frame) => {
    for (const key of Object.keys(frame)) {
      if (
        ![
          "offset",
          "computedOffset",
          "easing",
          "composite",
          "transform",
          "opacity",
        ].includes(key)
      ) {
        throw new MotionError(
          "UNSUPPORTED_PROPERTY",
          `The animation also changes ${key}. Only transform and opacity are supported.`,
        );
      }
    }
    if (frame.composite !== "auto" && frame.composite !== "replace")
      throw new MotionError(
        "COMPOSITE",
        "Per-keyframe additive composition is unsupported.",
      );
    const result: MotionKeyframe = {
      offset: frame.computedOffset,
      easing: frame.easing,
    };
    if (Object.hasOwn(frame, "transform")) {
      if (typeof frame.transform !== "string")
        throw new MotionError(
          "TRANSFORM",
          "The transform must resolve to a CSS string.",
        );
      result.transform = frame.transform;
    }
    if (Object.hasOwn(frame, "opacity")) {
      const value = frame.opacity;
      if (
        typeof value !== "number" &&
        (typeof value !== "string" ||
          !/^[+-]?(?:\d+|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
      ) {
        throw new MotionError(
          "NUMBER",
          "Opacity must resolve to a finite numeric value.",
        );
      }
      result.opacity = Number(value);
    }
    return result;
  });
  const timing = effect.getTiming();
  return parseRecipe({
    version: 1,
    status: "captured",
    keyframes: frames,
    timing: {
      duration: timing.duration,
      delay: timing.delay,
      endDelay: timing.endDelay,
      iterations: timing.iterations,
      iterationStart: timing.iterationStart,
      direction: timing.direction,
      easing: timing.easing,
      fill: timing.fill,
    },
    context: {
      transformOrigin: view.getComputedStyle(element).transformOrigin,
    },
    originalDuration: timing.duration,
  });
}
