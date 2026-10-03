# Architecture and implementation contract

`popup` uses an explicit toolbar action's temporary `activeTab` access to inject a bundled picker. The picker calls `captureMotion()` in an isolated world. A Shadow DOM overlay shows selection bounds without modifying the chosen element. Escape, cancellation, repeat injection, and disconnected targets are handled. HTTP(S) top-level HTML is the capture boundary; frame traversal and closed shadow trees are not implemented.

`worker` validates sender and recipe before a serialized session-store transaction, creates a random capture ID, and opens extension-owned `studio.html?id=…`. GET requests require a Studio sender. Source URLs and text never enter the stored record. Logical expiry is checked on access.

In beta.2, starting the picker is also a worker transaction: resolve the current top-level document, persist a bounded five-minute one-use approval, inject the authorization into the isolated world, then inject the picker into that exact `documentId`. Capture matches browser-owned sender tab/document/lifecycle and the token, consumes it, and checks the current document again. Capture storage commits before Studio is opened. See `R1_AUTHORIZATION.md` for message and race tests.

`core` defines recipe version 1. Fields are `version`, `status`, `keyframes`, `timing`, `context`, and `originalDuration`. Frames carry `offset`, `easing`, and transform and/or opacity. Timing retains duration, delay, endDelay, iterations, iterationStart, direction, easing and fill. Context is the absolute pixel transform origin; it is not the source DOM. Validation produces a clean data copy.

`Studio` revalidates captures and imports, renders real frame offsets and values, and applies the recipe to neutral and alternative designs. The UI owns replay handles and cancels them before restart, design changes, edits, or new imports. The immutable loaded recipe remains available for restore. Reduced-motion playback requires explicit opt-in.

Studio retains an immutable loaded recipe for comparison and reset. Imported provenance is displayed separately from schema edit history; resetting a previously edited import restores its loaded duration, not an invented original state. Both numeric and range duration inputs use 1–60,000 ms. Failed imports/downloads leave the current recipe intact.

`exportJavaScript()` serializes a self-contained, compiled runtime factory and a validated recipe. This deliberately shares parser/playback guards with the product. Build must retain this function's self-contained closure: do not add external helpers through name preservation or aggressive transforms without an independent export test. The result defines `window.motionPaste` and requires an explicit caller-provided target. It does not contact the extension.

Official API references checked during implementation:

- [Chrome activeTab permission](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)
- [Chrome extension session storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [KeyframeEffect.getKeyframes](https://developer.mozilla.org/en-US/docs/Web/API/KeyframeEffect/getKeyframes)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)
- [Chrome DevTools Extensions protocol](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)

Tests invoke the extension action using the browser's extension testing protocol. This grants the same activeTab action permission without broadening the manifest. This is automated unpacked-install verification, not Chrome Web Store installation or testing in the user's everyday profile.
