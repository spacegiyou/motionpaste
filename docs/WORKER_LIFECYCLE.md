# Actual service-worker lifecycle verification

`scripts/worker-lifecycle-test.mjs` tests the extracted release ZIP in a fresh Chromium profile. It retains the existing tab/document/one-use-token/TTL authorization model and requires no new extension permissions. The authoritative result is `artifacts/verification/worker-lifecycle-report.json`; a missing, failed, or blocked result is not a release pass.

## Method and observed boundary

The harness opens MotionPaste's actual toolbar action, obtains `activeTab` through that action, and clicks the real popup Capture button. Chrome creates and persists the authorization. A normal Studio extension tab reads `chrome.storage.session` for instrumentation; it does not issue BEGIN or create authorization. Failure requests use `chrome.scripting.executeScript` in the extension's isolated content world, so Chrome supplies their tab, document, frame, and lifecycle identities.

For each scenario the harness:

1. Writes a random, test-only sentinel to the running worker's global object and records the observed service-worker version ID and live target.
2. Invokes CDP `ServiceWorker.stopWorker` for that version. It requires the `ServiceWorker.workerVersionUpdated` event to report `stopped`, and requires the extension worker to be absent from `Target.getTargets`.
3. Reads session storage through the existing Studio page while the worker is stopped. Exact before/after values must match, and the worker must remain absent after this read. The saved report hashes synthetic tokens and recipes; it retains the test's tab/document IDs, expiry values, record IDs, and exact-storage digest.
4. Delivers the scenario's actual content-script message or actual picker click. It requires `starting` and `running` events and the return of a live worker target.
5. Confirms the worker-global sentinel is absent. This demonstrates recreated execution globals in addition to Chrome's stop/start observations. It then verifies the scenario's response, stored records, and remaining authorizations.

In the recorded Chromium run the worker target ID and Playwright `Worker` object were reused on restart. Different target IDs or a Playwright `close` event are therefore not required and are not claimed. The stopped live-target absence, lifecycle events, and lost global sentinel are the termination/recreation evidence.

Playwright/CDP debuggers remain attached during this test. A Studio extension page also remains open as a storage observer. No manual DevTools UI is opened. This is **forced service-worker termination and event-driven restart**, not a natural idle-timeout test. The browser itself is never restarted, so the test concerns retention within one browser session; it does not establish persistence across the separate `storage.session` browser-restart boundary.

## Required scenarios

| Stable check ID | Required observation |
| --- | --- |
| `archive-integrity` | Archive member hashes match; permissions are exactly `activeTab`, `scripting`, `storage`; no host permissions or externally connectable endpoint. |
| `pending-token-survives-restart` | A real popup authorization survives a confirmed worker stop. An actual source-card click wakes the worker, stores one capture, opens Studio, and consumes that authorization. |
| `consumed-token-rejected-after-restart` | Another stop/restart does not revive the consumed token. A same-document content-script replay receives a retry instruction and stores no capture. |
| `cross-tab-token-rejected-after-restart` | A second genuinely authorized tab cannot spend the first tab's token after restart. Both original approvals remain intact after the wrong-tab request. |
| `navigation-token-rejected-after-restart` | After approval and worker stop, same-origin navigation changes Chrome's document ID. The new document's late submission of the old token is rejected without storing a capture. Navigation's best-effort pagehide cancellation may be the first message to wake the worker. |
| `expired-token-rejected-after-restart` | A trusted test context deliberately sets a stored deadline in the past. After a real stop/restart, the token is rejected, the stale record is purged, and the response instructs the user to start again. This does not claim an actual five-minute wait. |
| `missing-token-rejected-and-reapproval-works` | With no stored approval, a random-token request wakes the stopped worker and receives a retry instruction. A new real toolbar approval and actual picker capture then succeed and consume the new token. |

The expected run has seven checks, six confirmed forced stop/restart cycles, two actual picker captures, and five rejected capture requests after restart. These counts are summaries of the stable scenarios above, not substitutes for their observations.

Pagehide cancellation is intentionally best effort. When navigating while the worker is stopped, the old document's authorization can remain stored until TTL expiry or a new approval replaces it. The navigation scenario accepts this only if the retained record is exactly the old record and the new document's request is rejected. It does not claim that every navigation immediately deletes storage. The following real reapproval also verifies that the stale record is replaced.

## Result and limitations

The initial scoped beta.3 run passed in Chromium **153.0.8010.12**, Playwright **1.63.0**, and Node **v25.9.0** on macOS. The full release pipeline reruns this script against its own newly built archive, so use the report's `archiveSHA256`, `measuredAt`, `finishedAt`, and outcome to identify the final evidence rather than assuming the preliminary archive is final.

The manifest installation floor is Chrome 120. It is separate from the browser version actually exercised here; this test does not verify Chrome 120. Natural idle termination without debuggers, a real five-minute TTL wait, full browser restart, public-site compatibility, and other browser versions remain untested by this script. A protocol or environment failure that prevents observing actual termination is reported as `BLOCKED`; assertion failures are `FAIL`, and both return a nonzero process exit.
