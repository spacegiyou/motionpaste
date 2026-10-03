import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import type { MotionRecipe } from "../src/core/index";

type Reply =
  | { ok: true; id?: string; recipe?: MotionRecipe }
  | { ok: false; error: string };
interface Capture {
  id: string;
  createdAt: number;
  recipe: MotionRecipe;
}
interface Session {
  tabId: number;
  documentId: string;
  token: string;
  expiresAt: number;
}
type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  respond: (reply: Reply) => void,
) => boolean;
interface Injection {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
  world: string;
  args?: unknown[];
  files?: string[];
}

const compiled = await build({
  entryPoints: ["src/extension/worker.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "chrome120",
});
const workerCode = compiled.outputFiles[0]!.text;
const pageSender = {
  id: "test-extension",
  url: "https://source.example/private-project",
  tab: { id: 2 },
  frameId: 0,
  documentId: "document-2",
  documentLifecycle: "active",
};
const popupSender = {
  id: "test-extension",
  url: "chrome-extension://test-extension/popup.html",
};
const studioSender = {
  id: "test-extension",
  url: "chrome-extension://test-extension/studio.html?id=anything",
};

function recipe(): MotionRecipe {
  return {
    version: 1,
    status: "captured",
    keyframes: [
      { offset: 0, easing: "linear", opacity: 0 },
      { offset: 1, easing: "linear", opacity: 1 },
    ],
    timing: {
      duration: 1000,
      delay: 0,
      endDelay: 0,
      iterations: 1,
      iterationStart: 0,
      direction: "normal",
      easing: "linear",
      fill: "both",
    },
    context: { transformOrigin: "50px 50px" },
    originalDuration: 1000,
  };
}

/** Exercises the bundled listener and its transaction order with mocked Chrome
 * APIs. Real activeTab permissions, document IDs, and CSP require browser tests. */
function harness() {
  const stored: { captures?: Capture[]; captureSessions?: Session[] } = {};
  const tabs: { url: string }[] = [];
  const injections: Injection[] = [];
  const documents = new Map([[2, "document-2"]]);
  const browser: {
    selected?: { id: number; url: string };
    onInject?: (injection: Injection) => void | Promise<void>;
    onCreate?: (tab: { url: string }) => void;
  } = { selected: { id: 2, url: pageSender.url } };
  let listener: Listener | undefined;
  let accessLevel: string | undefined;
  let context: vm.Context;
  function restart() {
    context = vm.createContext({
      TextEncoder,
      URL,
      crypto: webcrypto,
      chrome: {
        runtime: {
          id: "test-extension",
          getURL: (path: string) => `chrome-extension://test-extension/${path}`,
          onMessage: {
            addListener: (value: Listener) => {
              listener = value;
            },
          },
        },
        storage: {
          session: {
            get: async () => stored,
            set: async (value: Partial<typeof stored>) => {
              Object.assign(stored, value);
            },
            setAccessLevel: async (value: { accessLevel: string }) => {
              accessLevel = value.accessLevel;
            },
          },
        },
        tabs: {
          query: async () => {
            throw new Error(
              "Worker must use the popup-selected tab, never requery focus.",
            );
          },
          get: async (tabId: number) => {
            if (!browser.selected) throw new Error("No tab");
            if (browser.selected.id === tabId)
              return { ...browser.selected, windowId: 1 };
            if (documents.has(tabId))
              return { id: tabId, url: pageSender.url, windowId: 1 };
            throw new Error("No tab");
          },
          create: async (value: { url: string }) => {
            assert.ok(
              stored.captures?.length,
              "capture is committed before Studio opens",
            );
            browser.onCreate?.(value);
            tabs.push(value);
            return { id: tabs.length };
          },
        },
        scripting: {
          executeScript: async (injection: Injection) => {
            injections.push(injection);
            await browser.onInject?.(injection);
            const documentId = documents.get(injection.target.tabId);
            if (
              !documentId ||
              (injection.target.documentIds &&
                !injection.target.documentIds.includes(documentId))
            )
              throw new Error("The selected document is no longer available.");
            return [{ frameId: 0, documentId }];
          },
        },
      },
    });
    vm.runInContext(workerCode, context);
    assert.ok(listener, "worker registers its message listener synchronously");
  }
  restart();
  const send = async (message: unknown, sender: unknown): Promise<Reply> => {
    // Deserialize within the worker realm so core's plain-object guard applies.
    Object.assign(context, {
      wire: JSON.stringify({ message, sender }),
      listener,
    });
    return (await vm.runInContext(
      "new Promise(resolve => { const payload = JSON.parse(wire); listener(payload.message, payload.sender, resolve); })",
      context,
    )) as Reply;
  };
  const authorize = async (tabId = 2) => {
    browser.selected = { id: tabId, url: pageSender.url };
    if (!documents.has(tabId)) documents.set(tabId, `document-${tabId}`);
    assert.equal(
      (
        await send(
          { type: "MOTIONPASTE_BEGIN_CAPTURE", tabId, windowId: 1 },
          popupSender,
        )
      ).ok,
      true,
    );
    const session = stored.captureSessions?.find(
      (item) => item.tabId === tabId,
    );
    assert.ok(session);
    return session;
  };
  const capture = (session: Session, motion = recipe()) =>
    send(
      { type: "MOTIONPASTE_CAPTURE", token: session.token, recipe: motion },
      {
        ...pageSender,
        tab: { id: session.tabId },
        documentId: session.documentId,
      },
    );
  return {
    stored,
    tabs,
    send,
    accessLevel,
    authorize,
    capture,
    browser,
    documents,
    injections,
    restart,
  };
}

test("worker rejects a capture without an authorized picker session", async () => {
  const app = harness();
  const result = await app.send(
    { type: "MOTIONPASTE_CAPTURE", recipe: recipe() },
    pageSender,
  );
  assert.equal(result.ok, false);
  assert.equal(app.tabs.length, 0);
  assert.equal(app.stored.captures, undefined);
});

test("only the own popup can begin capture and only a normal active page is eligible", async () => {
  const app = harness();
  for (const sender of [
    pageSender,
    studioSender,
    { ...popupSender, id: "other" },
    { ...popupSender, url: "https://test-extension/popup.html" },
  ]) {
    assert.equal(
      (
        await app.send(
          { type: "MOTIONPASTE_BEGIN_CAPTURE", tabId: 2, windowId: 1 },
          sender,
        )
      ).ok,
      false,
    );
  }
  for (const selected of [
    undefined,
    { id: 2, url: "chrome://settings" },
    { id: 2, url: "file:///private" },
  ]) {
    app.browser.selected = selected;
    assert.equal(
      (
        await app.send(
          { type: "MOTIONPASTE_BEGIN_CAPTURE", tabId: 2, windowId: 1 },
          popupSender,
        )
      ).ok,
      false,
    );
  }
  assert.equal(app.injections.length, 0);
  assert.equal(app.stored.captureSessions, undefined);
});

test("worker keeps the popup-selected tab when browser focus changes", async () => {
  const app = harness();
  app.browser.selected = { id: 3, url: "https://another.example/" };
  app.documents.set(3, "document-3");
  assert.equal(
    (
      await app.send(
        { type: "MOTIONPASTE_BEGIN_CAPTURE", tabId: 2, windowId: 1 },
        popupSender,
      )
    ).ok,
    true,
  );
  assert.equal(app.stored.captureSessions?.[0]?.tabId, 2);
  assert.ok(app.injections.every((injection) => injection.target.tabId === 2));
  for (const target of [
    {},
    { tabId: "2", windowId: 1 },
    { tabId: 2, windowId: 9 },
  ]) {
    assert.equal(
      (
        await app.send(
          { type: "MOTIONPASTE_BEGIN_CAPTURE", ...target },
          popupSender,
        )
      ).ok,
      false,
    );
  }
});

test("worker stores validated motion only and serves it exclusively to Studio", async () => {
  const app = harness();
  assert.equal(app.accessLevel, "TRUSTED_CONTEXTS");
  const session = await app.authorize();
  assert.deepEqual(Object.keys(session).sort(), [
    "documentId",
    "expiresAt",
    "tabId",
    "token",
  ]);
  const result = await app.capture(session);
  assert.ok(result.ok && result.id);
  const id = result.id;
  assert.equal(app.tabs.length, 1);
  assert.equal(
    app.tabs[0]!.url,
    `chrome-extension://test-extension/studio.html?id=${id}`,
  );
  assert.equal(app.stored.captures?.length, 1);
  assert.equal(app.stored.captureSessions?.length, 0);
  assert.equal(JSON.stringify(app.stored).includes("source.example"), false);
  const loaded = await app.send(
    { type: "MOTIONPASTE_GET_CAPTURE", id },
    studioSender,
  );
  assert.ok(loaded.ok && loaded.recipe);
  assert.equal(JSON.stringify(loaded.recipe), JSON.stringify(recipe()));
  for (const sender of [
    pageSender,
    { ...studioSender, id: "other-extension" },
    popupSender,
    { ...studioSender, url: "https://test-extension/studio.html" },
  ]) {
    assert.equal(
      (await app.send({ type: "MOTIONPASTE_GET_CAPTURE", id }, sender)).ok,
      false,
    );
  }
});

test("worker binds random tokens to tab, document, top frame, extension and active lifecycle", async () => {
  const app = harness();
  const session = await app.authorize();
  assert.match(session.token, /^[a-f0-9-]{36}$/);
  for (const sender of [
    { ...pageSender, id: "other-extension" },
    { ...pageSender, frameId: 1 },
    { ...pageSender, url: "chrome://settings" },
    { ...pageSender, tab: undefined },
    { ...pageSender, tab: { id: 3 } },
    { ...pageSender, documentId: "document-new" },
    { ...pageSender, documentId: undefined },
    { ...pageSender, documentLifecycle: "cached" },
    studioSender,
  ]) {
    assert.equal(
      (
        await app.send(
          {
            type: "MOTIONPASTE_CAPTURE",
            token: session.token,
            recipe: recipe(),
          },
          sender,
        )
      ).ok,
      false,
    );
  }
  for (const token of [undefined, "wrong-token", crypto.randomUUID()]) {
    assert.equal(
      (
        await app.send(
          { type: "MOTIONPASTE_CAPTURE", token, recipe: recipe() },
          pageSender,
        )
      ).ok,
      false,
    );
  }
  assert.equal(app.tabs.length, 0);
  assert.equal(
    (await app.capture(session)).ok,
    true,
    "foreign attempts cannot revoke the real session",
  );
});

test("authorization persists across worker restart and is consumed exactly once", async () => {
  const app = harness();
  const session = await app.authorize();
  app.restart();
  const results = await Promise.all(
    Array.from({ length: 5 }, () => app.capture(session)),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  app.restart();
  assert.equal((await app.capture(session)).ok, false);
  assert.equal(app.tabs.length, 1);
});

test("expired sessions and messages from a document navigated away are rejected", async () => {
  const app = harness();
  const expired = await app.authorize();
  expired.expiresAt = Date.now() - 1;
  assert.equal((await app.capture(expired)).ok, false);
  assert.equal(app.stored.captureSessions?.length, 0);
  const priorDocument = await app.authorize();
  app.documents.set(2, "document-after-navigation");
  assert.equal((await app.capture(priorDocument)).ok, false);
  assert.equal(app.stored.captureSessions?.length, 0);
  assert.equal(app.tabs.length, 0);
});

test("revoked access fails closed and consumes the authorization", async () => {
  const app = harness();
  const session = await app.authorize();
  app.browser.onInject = () => {
    throw new Error("Missing host permission");
  };
  assert.equal((await app.capture(session)).ok, false);
  assert.equal(app.stored.captureSessions?.length, 0);
  assert.equal(app.tabs.length, 0);
});

test("registration precedes picker injection and Studio data is ready during tab creation", async () => {
  const app = harness();
  let earlyCapture: Promise<Reply> | undefined;
  let earlyRead: Promise<Reply> | undefined;
  app.browser.onInject = (injection) => {
    if (!injection.target.documentIds) return;
    const session = app.stored.captureSessions?.[0];
    assert.ok(
      session,
      "authorization is persisted before config or picker executes",
    );
    assert.equal(injection.world, "ISOLATED");
    assert.deepEqual(Array.from(injection.target.documentIds), [
      session.documentId,
    ]);
    if (injection.args) {
      assert.equal(injection.args[0], session.token);
      assert.equal(injection.args[1], session.expiresAt);
    }
    if (injection.files) earlyCapture = app.capture(session);
  };
  app.browser.onCreate = (tab) => {
    const id = new URL(tab.url).searchParams.get("id");
    earlyRead = app.send({ type: "MOTIONPASTE_GET_CAPTURE", id }, studioSender);
  };
  assert.equal(
    (
      await app.send(
        { type: "MOTIONPASTE_BEGIN_CAPTURE", tabId: 2, windowId: 1 },
        popupSender,
      )
    ).ok,
    true,
  );
  assert.ok(earlyCapture);
  assert.equal((await earlyCapture).ok, true);
  assert.ok(earlyRead);
  assert.equal((await earlyRead).ok, true);
});

test("repeat invocation supersedes old token and late old cleanup cannot revoke the new picker", async () => {
  const app = harness();
  const old = await app.authorize();
  let lateCancel: Promise<Reply> | undefined;
  app.browser.onInject = (injection) => {
    if (injection.files)
      lateCancel = app.send(
        { type: "MOTIONPASTE_CANCEL_CAPTURE", token: old.token },
        pageSender,
      );
  };
  const replacement = await app.authorize();
  assert.notEqual(replacement.token, old.token);
  assert.ok(lateCancel);
  await lateCancel;
  assert.equal((await app.capture(old)).ok, false);
  assert.equal((await app.capture(replacement)).ok, true);
  assert.equal(app.tabs.length, 1);
});

test("cancellation revokes only its own session and repeated cancellation is harmless", async () => {
  const app = harness();
  const session = await app.authorize();
  const other = await app.authorize(3);
  for (let index = 0; index < 2; index++) {
    assert.equal(
      (
        await app.send(
          { type: "MOTIONPASTE_CANCEL_CAPTURE", token: session.token },
          pageSender,
        )
      ).ok,
      true,
    );
  }
  assert.equal((await app.capture(session)).ok, false);
  assert.equal((await app.capture(other)).ok, true);
});

test("pagehide cancellation can revoke its own inactive document session", async () => {
  const app = harness();
  const session = await app.authorize();
  assert.equal(
    (
      await app.send(
        { type: "MOTIONPASTE_CANCEL_CAPTURE", token: session.token },
        { ...pageSender, documentLifecycle: "cached" },
      )
    ).ok,
    true,
  );
  assert.equal(app.stored.captureSessions?.length, 0);
  assert.equal((await app.capture(session)).ok, false);
});

test("injection failure or navigation during setup clears the pending authorization", async () => {
  for (const stage of ["config", "picker", "navigation"] as const) {
    const app = harness();
    app.browser.onInject = (injection) => {
      if (
        (stage === "config" && injection.args) ||
        (stage === "picker" && injection.files)
      )
        throw new Error("Cannot inject");
      if (stage === "navigation" && injection.args)
        app.documents.set(2, "new-document");
    };
    assert.equal(
      (
        await app.send(
          { type: "MOTIONPASTE_BEGIN_CAPTURE", tabId: 2, windowId: 1 },
          popupSender,
        )
      ).ok,
      false,
    );
    assert.equal(app.stored.captureSessions?.length, 0);
    assert.equal(app.tabs.length, 0);
  }
});

test("malformed capture payloads consume their token without storing or opening anything", async () => {
  const app = harness();
  for (const invalid of [
    { ...recipe(), url: "https://source.example/" },
    { ...recipe(), version: 2 },
    { ...recipe(), keyframes: [] },
    "not json",
  ]) {
    const session = await app.authorize();
    assert.equal(
      (
        await app.send(
          {
            type: "MOTIONPASTE_CAPTURE",
            token: session.token,
            recipe: invalid,
          },
          pageSender,
        )
      ).ok,
      false,
    );
    assert.equal((await app.capture(session)).ok, false);
  }
  assert.equal((await app.send(null, pageSender)).ok, false);
  assert.equal((await app.send({ type: "UNKNOWN" }, pageSender)).ok, false);
  assert.equal(app.tabs.length, 0);
  assert.equal(app.stored.captures, undefined);
});

test("worker serializes concurrent authorized captures, caps history and expires old data on access", async () => {
  const app = harness();
  const sessions = [];
  for (let tabId = 2; tabId < 16; tabId++)
    sessions.push(await app.authorize(tabId));
  const results = await Promise.all(
    sessions.map((session) => app.capture(session)),
  );
  assert.ok(results.every((result) => result.ok));
  assert.equal(app.stored.captures?.length, 10);
  assert.equal(
    new Set(app.stored.captures?.map((capture) => capture.id)).size,
    10,
  );
  const first = results[0]!;
  assert.ok(first.ok && first.id);
  assert.equal(
    (
      await app.send(
        { type: "MOTIONPASTE_GET_CAPTURE", id: first.id },
        studioSender,
      )
    ).ok,
    false,
  );
  const expired = app.stored.captures![0]!;
  expired.createdAt -= 31 * 60 * 1000;
  const result = await app.send(
    { type: "MOTIONPASTE_GET_CAPTURE", id: expired.id },
    studioSender,
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /expired/.test(result.error));
  assert.equal(app.stored.captures?.length, 9);
});

test("worker bounds stored bytes even when individual recipes approach their size limit", async () => {
  const app = harness();
  const large = recipe();
  const transform = Array.from({ length: 16 }, () => "translateX(0px)").join(
    " ".repeat(230),
  );
  large.keyframes = Array.from({ length: 16 }, (_, index) => ({
    offset: index / 15,
    easing: "linear",
    transform,
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 65536);
  const sessions = [];
  for (let tabId = 2; tabId < 14; tabId++)
    sessions.push(await app.authorize(tabId));
  const results = await Promise.all(
    sessions.map((session) => app.capture(session, large)),
  );
  assert.ok(results.every((result) => result.ok));
  assert.ok(app.stored.captures!.length < 10);
  assert.ok(
    Buffer.byteLength(JSON.stringify(app.stored.captures)) <= 512 * 1024,
  );
  const newest = results.at(-1)!;
  assert.ok(newest.ok && newest.id);
  assert.equal(
    (
      await app.send(
        { type: "MOTIONPASTE_GET_CAPTURE", id: newest.id },
        studioSender,
      )
    ).ok,
    true,
  );
});
