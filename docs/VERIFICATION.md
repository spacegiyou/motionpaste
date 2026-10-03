# Verification and review scope

MotionPaste beta.3 is a deliberately limited local extension beta. The product was checked against independently authored local fixtures. Passing these checks does not establish compatibility with arbitrary websites or reproduce every source layout and CSS context.

## Executed checks

The local release pipeline contains 15 required stages. Its browser suites install the actual generated ZIP into fresh Chromium profiles and check the real toolbar action, picker, Studio, downloads, and JavaScript running without the extension.

| Check | Cases |
| --- | --- |
| Core and worker unit tests | 60 (44 + 16) |
| Evidence, promotion, packaging and cleanup regressions | 99 |
| Local fixture server tests | 15 |
| Extension end-to-end checks | 8, including 50 CSS/WAAPI cases at 1,300 times |
| Browser authorization | 8 |
| Actual forced worker stop/restart | 7 checks, 6 cycles |
| Browser rejection and cleanup | 59 |
| Extracted archive smoke | 8 |
| Studio UI regression | 13 |
| Downloaded JavaScript parity | 18 cases, 916 paired times, 18 detected no-op controls |

The 18-case matrix uses the capture core and the actual import/download UI. It does not represent 18 toolbar captures or 916 websites. The separate end-to-end and archive suites exercise the actual toolbar route.

Worker lifecycle verification observes Chrome stopped/starting/running events, absence of the live worker target, retained session storage, and loss of a worker-global sentinel. CDP debuggers remain attached. This establishes forced termination and event-driven restart within one browser session; natural idle termination, a full browser restart, and a real five-minute TTL wait remain untested. Expiry tests inject the deadline explicitly. See [the lifecycle method](WORKER_LIFECYCLE.md).

Evidence guards reject empty or failed checks, missing stages, invalid timing, mismatched source/archive hashes, inconsistent raw export observations, lifecycle events from the wrong cycle, error fields alongside PASS, and contradictory machine summaries. Expected negative-control FAIL is valid. These are explicit consistency contracts, not signatures or proof against coordinated fabrication.

## Review

The local beta underwent a separate web GPT 6 Pro review, followed by fixes and a focused second review. The first review identified two P2 evidence-handling issues: error fields alongside PASS and unchecked supplementary summary counts. Both were reproduced with the reviewer's original tool, fixed, and rechecked through promotion and packaging. The follow-up found both resolved and no additional required fixes for this limited beta.

The reviewer directly reran 99 related tests and the original packaging mutation tool: a normal package was accepted and all 15 malformed variants rejected. Its environment temporarily resolved the missing `playwright` import to an already installed real `playwright-core`; test files were unchanged and no browser was launched. This is not a complete reproduction of the lockfile environment or an independent security audit. The full 15-stage pipeline and actual extension/worker/export browser suites were reviewed as code and records, not rerun by that reviewer.

The public preparation changes fixture archive paths to relative paths, corrects the Node engine declaration, limits source-package contents, and adds CI and public documentation. It does not expand the product contract. The public tree is verified again from a fresh dependency installation before publication.

## Reproduce

```sh
npm ci
npx playwright install chromium
npm run verify
```

Use Node 22.13+ within 22.x, or Node 24+. The local verification environment used macOS arm64, Node 25.9.0, Playwright 1.63.0 and Chromium 153.0.8010.12. Chrome 120 is the installation floor, not the tested minimum browser version.

[GitHub Actions](https://github.com/spacegiyou/motionpaste/actions/workflows/ci.yml) independently runs Node 22/24 core checks and the full Chromium pipeline on Ubuntu. Consult completed run results for the actual CI verdict. Generated reports and ZIP artifacts are attached to the runs with limited retention.

The [release evidence summary](verification/beta3.json) records the local publication run, its exact installable ZIP hash and verified source inputs. Raw development logs and external conversation materials remain local. GitHub CI logs and generated reports provide a reproducible public execution trail.

## Demo provenance and limitations

The [15-second clip](assets/MotionPaste-promo.mp4) and [35-second demo](assets/MotionPaste-demo.mp4) show actual capture, Studio editing/download, and the downloaded code in a separate browser without the extension. They use cuts and captions at normal speed. Browser toolbar chrome and the system pointer are outside the viewport recording; there is no fabricated toolbar or pointer. Output lengths are checked at 30 fps: 450 and 1,050 frames.

No Chrome Web Store installation, public-site compatibility campaign, outside-user success study, exhaustive accessibility audit, or external security audit has been completed. Test volume is not evidence of market adoption.
