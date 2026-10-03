export interface MotionKeyframe {
  offset: number;
  easing: string;
  transform?: string;
  opacity?: number;
}

export interface MotionTiming {
  duration: number;
  delay: number;
  endDelay: number;
  iterations: number;
  iterationStart: number;
  direction: PlaybackDirection;
  easing: string;
  fill: "both";
}

/** Version 1 intentionally supports only finite, replace-composited 2D motion. */
export interface MotionRecipe {
  version: 1;
  status: "captured" | "edited";
  keyframes: MotionKeyframe[];
  timing: MotionTiming;
  context: { transformOrigin: string };
  originalDuration: number;
}

export interface ReplayOptions {
  allowReducedMotion?: boolean;
}

export type MotionStage = "CAPTURE" | "APPLY";

export interface MotionHandle {
  animation: Animation;
  cancel(): void;
}
