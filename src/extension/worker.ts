import { parseRecipe } from "../core/index";

type Recipe = ReturnType<typeof parseRecipe>;
interface CaptureRecord {
  id: string;
  createdAt: number;
  recipe: Recipe;
}
interface CaptureSession {
  tabId: number;
  documentId: string;
  token: string;
  expiresAt: number;
}
type Response =
  { ok: true; id?: string; recipe?: Recipe } | { ok: false; error: string };
const TTL_MS = 30 * 60 * 1_000;
const PICKER_TTL_MS = 5 * 60 * 1_000;
const MAX_SESSIONS = 20;
const MAX_RECORDS = 10;
const MAX_STORAGE_BYTES = 512 * 1_024;
const encoder = new TextEncoder();
let operations: Promise<unknown> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializedSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function fromStudio(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    const studio = new URL(chrome.runtime.getURL("studio.html"));
    return (
      url.protocol === studio.protocol &&
      url.host === studio.host &&
      url.pathname === studio.pathname
    );
  } catch {
    return false;
  }
}

function fromPage(
  sender: chrome.runtime.MessageSender,
  allowInactive = false,
): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.tab?.id !== undefined &&
    sender.frameId === 0 &&
    typeof sender.documentId === "string" &&
    (allowInactive || sender.documentLifecycle === "active") &&
    typeof sender.url === "string" &&
    /^https?:\/\//i.test(sender.url)
  );
}

async function readFreshSessions(): Promise<CaptureSession[]> {
  const data: Record<string, unknown> =
    await chrome.storage.session.get("captureSessions");
  if (!Array.isArray(data.captureSessions)) return [];
  const now = Date.now();
  return data.captureSessions
    .slice(-MAX_SESSIONS)
    .filter(
      (value): value is CaptureSession =>
        isRecord(value) &&
        Number.isInteger(value.tabId) &&
        typeof value.documentId === "string" &&
        typeof value.token === "string" &&
        /^[a-f0-9-]{36}$/i.test(value.token) &&
        typeof value.expiresAt === "number" &&
        value.expiresAt > now &&
        value.expiresAt <= now + PICKER_TTL_MS,
    )
    .map(({ tabId, documentId, token, expiresAt }) => ({
      tabId,
      documentId,
      token,
      expiresAt,
    }));
}

async function currentDocument(tabId: number): Promise<string> {
  // Chrome, rather than page-controlled data, supplies this document identity.
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: "ISOLATED",
    func: () => undefined,
  });
  const documentId = results.find((result) => result.frameId === 0)?.documentId;
  if (!documentId)
    throw new Error("The selected page changed. Start capture again.");
  return documentId;
}

async function beginCapture(
  tabId: number,
  windowId: number,
): Promise<Response> {
  // Only the trusted popup chooses the target. The worker's currentWindow can
  // change while the popup message crosses contexts; never reselect a tab here.
  const tab = await chrome.tabs.get(tabId);
  if (
    tab.id !== tabId ||
    tab.windowId !== windowId ||
    !tab.url ||
    !/^https?:\/\//i.test(tab.url)
  )
    throw new Error(
      "Open a normal HTTP or HTTPS page first. Browser settings, local files, and extension pages cannot be captured.",
    );
  const session: CaptureSession = {
    tabId: tab.id,
    documentId: await currentDocument(tab.id),
    token: crypto.randomUUID(),
    expiresAt: Date.now() + PICKER_TTL_MS,
  };
  const sessions = (await readFreshSessions()).filter(
    (item) => item.tabId !== session.tabId,
  );
  // Registration must finish before any picker code can emit a capture.
  await chrome.storage.session.set({
    captureSessions: [...sessions, session].slice(-MAX_SESSIONS),
  });
  const target = { tabId: session.tabId, documentIds: [session.documentId] };
  try {
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      func: (token: string, expiresAt: number) => {
        const scope = globalThis as typeof globalThis & {
          __motionPasteAuthorization?: { token: string; expiresAt: number };
        };
        scope.__motionPasteAuthorization = { token, expiresAt };
      },
      args: [session.token, session.expiresAt],
    });
    await chrome.scripting.executeScript({
      target,
      world: "ISOLATED",
      files: ["picker.js"],
    });
    return { ok: true };
  } catch (error) {
    await chrome.storage.session.set({
      captureSessions: (await readFreshSessions()).filter(
        (item) => item.token !== session.token,
      ),
    });
    throw error;
  }
}

async function takeSession(
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  allowInactive = false,
): Promise<CaptureSession | undefined> {
  const sessions = await readFreshSessions();
  const session = fromPage(sender, allowInactive)
    ? sessions.find(
        (item) =>
          item.token === message.token &&
          item.tabId === sender.tab?.id &&
          item.documentId === sender.documentId,
      )
    : undefined;
  // Consume before parsing/capturing so even concurrent replays cannot succeed.
  // A cancellation from an old picker cannot remove its replacement.
  await chrome.storage.session.set({
    captureSessions: sessions.filter((item) => item !== session),
  });
  return session;
}

async function readFreshCaptures(): Promise<CaptureRecord[]> {
  const data: Record<string, unknown> =
    await chrome.storage.session.get("captures");
  if (!Array.isArray(data.captures)) return [];
  const now = Date.now();
  const records: CaptureRecord[] = [];
  for (const record of data.captures.slice(-MAX_RECORDS)) {
    if (
      !isRecord(record) ||
      typeof record.id !== "string" ||
      typeof record.createdAt !== "number" ||
      !Number.isFinite(record.createdAt) ||
      record.createdAt > now ||
      now - record.createdAt >= TTL_MS
    )
      continue;
    try {
      records.push({
        id: record.id,
        createdAt: record.createdAt,
        recipe: parseRecipe(record.recipe),
      });
    } catch {
      // Discard stale or invalid session data; never return unchecked data across the boundary.
    }
  }
  while (records.length > 0 && serializedSize(records) > MAX_STORAGE_BYTES)
    records.shift();
  return records;
}

async function handleMessage(
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Response> {
  if (!isRecord(message))
    return { ok: false, error: "Invalid MotionPaste message." };
  if (message.type === "MOTIONPASTE_BEGIN_CAPTURE") {
    if (
      sender.id !== chrome.runtime.id ||
      sender.url !== chrome.runtime.getURL("popup.html")
    )
      return { ok: false, error: "Start capture from the MotionPaste popup." };
    if (!Number.isInteger(message.tabId) || !Number.isInteger(message.windowId))
      return {
        ok: false,
        error: "The selected tab changed. Start capture again.",
      };
    return beginCapture(message.tabId as number, message.windowId as number);
  }
  if (message.type === "MOTIONPASTE_CANCEL_CAPTURE") {
    // pagehide may have already moved this document to the back/forward cache.
    await takeSession(message, sender, true);
    return { ok: true };
  }
  if (message.type === "MOTIONPASTE_CAPTURE") {
    const session = await takeSession(message, sender);
    if (!session)
      return {
        ok: false,
        error:
          "This capture session expired or changed. Click MotionPaste to start again.",
      };
    if ((await currentDocument(session.tabId)) !== session.documentId)
      return {
        ok: false,
        error: "The selected page changed. Start capture again.",
      };
    const recipe = parseRecipe(message.recipe);
    const record: CaptureRecord = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      recipe,
    };
    if (serializedSize([record]) > MAX_STORAGE_BYTES)
      throw new Error(
        "This capture is too large for the temporary session store.",
      );
    const records = [...(await readFreshCaptures()), record].slice(
      -MAX_RECORDS,
    );
    while (serializedSize(records) > MAX_STORAGE_BYTES) records.shift();
    await chrome.storage.session.set({ captures: records });
    await chrome.tabs.create({
      url: chrome.runtime.getURL(
        `studio.html?id=${encodeURIComponent(record.id)}`,
      ),
    });
    return { ok: true, id: record.id };
  }
  if (message.type === "MOTIONPASTE_GET_CAPTURE") {
    if (!fromStudio(sender))
      return {
        ok: false,
        error: "Captures can only be opened in MotionPaste Studio.",
      };
    if (
      typeof message.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(message.id)
    ) {
      return {
        ok: false,
        error:
          "Invalid capture link. Select an element again or import a recipe.",
      };
    }
    const records = await readFreshCaptures();
    await chrome.storage.session.set({ captures: records });
    const record = records.find((capture) => capture.id === message.id);
    return record
      ? { ok: true, recipe: record.recipe }
      : {
          ok: false,
          error:
            "This capture expired or was removed. Captures last 30 minutes; select the element again or import an exported recipe.",
        };
  }
  return { ok: false, error: "Unsupported MotionPaste message." };
}

// Content scripts cannot read the capture store; only this worker and extension pages can.
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (response: Response) => void) => {
    // Serialize read/modify/write transactions, including expiry cleanup.
    const response = operations.then(() => handleMessage(message, sender));
    operations = response.catch(() => undefined);
    void response.then(sendResponse, (error: unknown) => {
      sendResponse({
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Capture failed. Reload the extension and try again.",
      });
    });
    return true;
  },
);
