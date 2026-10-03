# Contributing

Keep the product small and verifiable: capture → edit → portable output. A new property or timing mode needs a defined baseline/end-state contract, rejection tests, and real browser parity cases. Do not silently discard unsupported properties or replace failed captures with presets.

Use Node 22.13+ within 22.x, or Node 24+. Run `npm ci`, `npx playwright install chromium`, then `npm run verify`. The workflow also runs Node 22/24 core checks and full Chromium verification. A failed environment setup is not a test pass.

The extension must remain local and use only `activeTab`, `scripting`, and `storage`. Do not add production-only test bypasses, a cloud dependency, telemetry, or a model API.

Source fixtures must remain independently authored and must not import Studio or the core. Test release archives in a fresh browser profile. When changing export serialization, execute the downloaded JavaScript in a separate browser without the core library or extension.

Historical evidence fixtures under `tests/fixtures/beta2-evidence/` have their local archive paths replaced by relative paths. Their reviewed digests are asserted by the fixture loader. They are synthetic-test inputs, not evidence that today's browser tests ran.

Build output, verification logs, capture recordings, and supplied materials are ignored by Git. Publish only reviewed repository files and verified release assets. `scripts/package-source.mjs` gates source packaging on a current PASS and includes only its explicit public source/document roots.

Use [Issues](https://github.com/spacegiyou/motionpaste/issues) for ordinary bugs. Include steps, expected/actual behavior, error code, browser/OS, and a minimal example you have permission to share. Follow [SECURITY.md](SECURITY.md) for vulnerabilities; avoid posting private page data or credentials.
