# Security and privacy

MotionPaste runs locally. It requests only `activeTab`, `scripting`, and `storage`. It has no persistent host permissions, telemetry, analytics, account, cloud service, external messages, remote scripts, or network dependency.

The user invokes capture on the current HTTP(S) tab. The picker runs in Chrome's isolated world, reads a selected element's browser animation data, and adds its own temporary overlay. It does not alter the source element's HTML, inline styles, playback time, or animation options. The click used to select is consumed so it does not follow a link or submit a form.

The recipe contains only known numeric timing/keyframe values, validated transform/easing strings, a pixel transform origin, a format version, and edit status. Page HTML, text, URLs, cookies, storage, screenshots, and scripts are not captured. Chrome exposes the sender URL for origin checks; it is not saved in the recipe or session record.

The worker validates again, accepts captures only from this extension's top-frame HTTP(S) content script, and returns recipes only to its own Studio. Session storage is restricted to trusted extension contexts and bounded to ten captures / 512 KiB. A capture expires logically after 30 minutes and is pruned on the next capture/read; it is not promised to be physically deleted at exactly 30 minutes. Session data disappears when the browser session ends. Downloaded files remain wherever the user saves them.

Before injection, the worker commits a short-lived picker authorization bound to the browser-owned tab ID, document ID and a random one-use token. Captures require a matching active document and consume the authorization before processing. Replays, cross-tab/document submissions and stale cancellations cannot reuse or clear a replacement authorization. Picker authorizations also live in trusted session storage so worker suspension does not erase valid approvals. They expire after five minutes and are bounded to twenty entries. No source URL is stored with them.

Recipes are not code. Unknown fields, unsupported versions, excessive input, unsafe CSS syntax, non-finite numbers, and unsupported animation semantics are rejected. Studio inserts imported data as text. The extension CSP disallows remote scripts, object content, and network connections. Standalone exports contain only the validated data and bundled runtime; no `eval` or `Function` constructor is used by the product.

Replay refuses existing target animations and respects reduced-motion preferences. Cleanup restores the transform-origin inline value and priority; it does not cancel unrelated animations. Source and target document contexts can still affect appearance; MotionPaste does not claim an exact visual clone across arbitrary designs.

Origin cleanup is conditional on ownership and the exact installed value/priority. Caller edits made during playback are retained. Opacity-only playback does not write the origin. A destination-window `Symbol.for` key stores a WeakMap of target ownership callbacks to prevent delayed cancellation across independent exports; it is created only when playback is explicitly called and contains no page data or network connection.

This is not a formal security audit. Report vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/spacegiyou/motionpaste/security/advisories/new). Please do not publish credentials, private page data, or working exploits in public issues. Ordinary non-security bugs belong in Issues.
