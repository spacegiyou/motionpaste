import { captureMotion } from "../core/index";
import { contextualizeError } from "../core/runtime";

interface PickerGlobal {
  __motionPasteCleanup?: () => void;
  __motionPasteAuthorization?: { token: string; expiresAt: number };
}
interface CaptureResponse {
  ok: boolean;
  error?: string;
}

const pickerGlobal: typeof globalThis & PickerGlobal = globalThis;
const authorization = pickerGlobal.__motionPasteAuthorization;
delete pickerGlobal.__motionPasteAuthorization;
if (!authorization || authorization.expiresAt <= Date.now())
  throw new Error("Start capture from the MotionPaste popup.");
const { token, expiresAt } = authorization;
pickerGlobal.__motionPasteCleanup?.();

const host = document.createElement("div");
host.id = "motionpaste-picker";
host.style.cssText =
  "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important;display:block!important;visibility:visible!important;";
const shadow = host.attachShadow({ mode: "closed" });
const style = document.createElement("style");
style.textContent = `
  :host { color-scheme: dark; }
  * { box-sizing: border-box; }
  .outline { position:fixed; border:2px solid #bdff78; border-radius:5px; background:rgba(189,255,120,.07); box-shadow:0 0 0 1px rgba(0,0,0,.45); display:none; pointer-events:none; }
  .bar { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); max-width:calc(100vw - 32px); width:580px; display:flex; align-items:center; gap:14px; padding:15px 17px; border:1px solid #424a59; border-radius:13px; background:#171b25; color:#f4f6fb; box-shadow:0 14px 55px #0006; pointer-events:auto; font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .badge { flex:none; border-radius:8px; padding:8px; background:#bdff78; color:#18230e; font-weight:800; font-size:17px; }
  .text { flex:1; min-width:0; }
  strong { font-weight:650; display:block; margin-bottom:3px; }
  .hint { color:#b9c1d0; font-size:11px; }
  button { flex:none; background:#303747; color:#f4f6fb; padding:9px 11px; border:1px solid #596377; border-radius:7px; cursor:pointer; font:inherit; }
  button:hover { background:#454e61; }
  button:focus-visible { outline:2px solid #bdff78; outline-offset:3px; }
  @media (max-width:420px) { .bar { bottom:12px; gap:9px; padding:11px; } .badge { display:none; } }
`;
const outline = document.createElement("div");
outline.className = "outline";
outline.setAttribute("aria-hidden", "true");
const bar = document.createElement("div");
bar.className = "bar";
bar.setAttribute("role", "region");
bar.setAttribute("aria-label", "MotionPaste element picker");
const badge = document.createElement("span");
badge.className = "badge";
badge.textContent = "m↗";
badge.setAttribute("aria-hidden", "true");
const text = document.createElement("div");
text.className = "text";
const title = document.createElement("strong");
title.textContent = "Select an animated element";
title.setAttribute("role", "status");
title.setAttribute("aria-live", "polite");
const hint = document.createElement("div");
hint.className = "hint";
hint.textContent =
  "Hover + click to capture · Tab to focus, Enter to select · Esc to cancel";
const cancel = document.createElement("button");
cancel.type = "button";
cancel.textContent = "Cancel";
text.append(title, hint);
bar.append(badge, text, cancel);
shadow.append(style, outline, bar);
document.documentElement.append(host);

let selected: Element | null = null;
let active = true;
let capturing = false;
let frame = 0;
// Session cleanup also runs if a tab is left open without making a selection.
const clearTimer = setTimeout(cleanup, Math.max(0, expiresAt - Date.now()));
const listeners = new AbortController();

function cleanup(): void {
  if (!active) return;
  active = false;
  listeners.abort();
  cancelAnimationFrame(frame);
  clearTimeout(clearTimer);
  host.remove();
  // Best effort on pagehide; the worker also enforces expiry and document identity.
  void chrome.runtime
    .sendMessage({ type: "MOTIONPASTE_CANCEL_CAPTURE", token })
    .catch(() => undefined);
  if (pickerGlobal.__motionPasteCleanup === cleanup)
    delete pickerGlobal.__motionPasteCleanup;
}
pickerGlobal.__motionPasteCleanup = cleanup;

function updateOutline(): void {
  if (!active) return;
  if (!host.isConnected) {
    cleanup();
    return;
  }
  if (selected && !selected.isConnected) {
    selected = null;
    title.textContent = "That element was removed. Select another element.";
  }
  if (selected) {
    const bounds = selected.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.left = `${bounds.left}px`;
    outline.style.top = `${bounds.top}px`;
    outline.style.width = `${bounds.width}px`;
    outline.style.height = `${bounds.height}px`;
  } else outline.style.display = "none";
  frame = requestAnimationFrame(updateOutline);
}

function eventElement(event: Event): Element | null {
  const path = event.composedPath();
  if (path.includes(host)) return null;
  // Text and icons often sit inside the animated card/button. Highlight the
  // nearest element that owns an effect so the selected box matches the capture.
  for (const candidate of path) {
    if (candidate instanceof Element && candidate.getAnimations().length > 0)
      return candidate;
  }
  const first = path[0];
  return first instanceof Element ? first : null;
}

function pointAt(event: Event): void {
  if (capturing) return;
  const candidate = eventElement(event);
  if (candidate) selected = candidate;
}

async function capture(element: Element): Promise<void> {
  if (capturing || !active) return;
  if (!element.isConnected) {
    title.textContent = "That element was removed. Select another element.";
    selected = null;
    return;
  }
  capturing = true;
  let submitted = false;
  title.textContent = "Reading this element’s motion…";
  try {
    const recipe = captureMotion(element);
    submitted = true;
    const response: CaptureResponse | undefined =
      await chrome.runtime.sendMessage({
        type: "MOTIONPASTE_CAPTURE",
        token,
        recipe,
      });
    if (!response?.ok)
      throw new Error(
        response?.error ??
          "Studio did not respond. Reload the extension and try again.",
      );
    cleanup();
  } catch (error) {
    if (!active) return;
    title.textContent = contextualizeError(error, "CAPTURE").message;
    hint.textContent = submitted
      ? "Click MotionPaste to start a new capture. Esc to close."
      : "Choose another element. Only supported transform/opacity animations are captured. Esc to cancel.";
    capturing = submitted;
  }
}

document.addEventListener("pointermove", pointAt, {
  capture: true,
  passive: true,
  signal: listeners.signal,
});
document.addEventListener("focusin", pointAt, {
  capture: true,
  passive: true,
  signal: listeners.signal,
});
document.addEventListener(
  "click",
  (event) => {
    const element = eventElement(event);
    if (!element) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selected = element;
    void capture(element);
  },
  { capture: true, signal: listeners.signal },
);
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      cleanup();
    } else if (
      event.key === "Enter" &&
      selected &&
      !event.composedPath().includes(host)
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void capture(selected);
    }
  },
  { capture: true, signal: listeners.signal },
);
window.addEventListener("pagehide", cleanup, {
  once: true,
  signal: listeners.signal,
});
cancel.addEventListener("click", cleanup, { signal: listeners.signal });
updateOutline();
