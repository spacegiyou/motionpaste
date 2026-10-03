import { createMotionRuntime, parseRecipe } from "./runtime";
import type { MotionRecipe } from "./types";

export { captureMotion } from "./capture";
export {
  MotionError,
  parseRecipe,
  replayMotion,
  editDuration,
} from "./runtime";
export type {
  MotionRecipe,
  MotionTiming,
  MotionKeyframe,
  ReplayOptions,
  MotionHandle,
  MotionStage,
} from "./types";

/** Returns a standalone script. Loading it never searches for or mutates targets. */
export function exportJavaScript(input: MotionRecipe): string {
  const recipe = parseRecipe(input);
  const data = JSON.stringify(recipe)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `/* MotionPaste v1 — Copy the motion. Keep your design.
 * Usage: const motion = window.motionPaste(document.querySelector('.your-target'));
 * Cleanup: motion.cancel(); Reduced-motion opt-in: { allowReducedMotion: true }
 * Requires an HTML target with no existing animations or 3D context.
 */
(() => {
  "use strict";
  const runtime = (${createMotionRuntime.toString()})();
  const recipe = ${data};
  window.motionPaste = (target, options) => runtime.replayMotion(target, recipe, options);
})();
`;
}
