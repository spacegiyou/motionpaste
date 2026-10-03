import assert from "node:assert/strict";
export async function openPicker(context, source, extensionId) {
  const cdp = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send("Target.getTargets", {
    filter: [{ type: "tab" }],
  });
  const targetInfo = targetInfos.find((t) => t.url === source.url());
  assert.ok(targetInfo, "Source tab is available");
  await source.bringToFront();
  await cdp.send("Extensions.triggerAction", {
    id: extensionId,
    targetId: targetInfo.targetId,
  });
  let popupTarget;
  for (let attempt = 0; attempt < 30; attempt++) {
    const { targetInfos } = await cdp.send("Target.getTargets", {
      filter: [{ type: "page" }],
    });
    popupTarget = targetInfos.find(
      (t) => t.url === `chrome-extension://${extensionId}/popup.html`,
    );
    if (popupTarget) break;
    await source.waitForTimeout(100);
  }
  assert.ok(popupTarget, "Actual toolbar popup opened");
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: popupTarget.targetId,
    flatten: false,
  });
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off("Target.receivedMessageFromTarget", listener);
      reject(Error("Popup capture click timed out"));
    }, 10000);
    const listener = (event) => {
      if (event.sessionId !== sessionId) return;
      const data = JSON.parse(event.message);
      if (data.id !== 1) return;
      clearTimeout(timer);
      cdp.off("Target.receivedMessageFromTarget", listener);
      data.error ? reject(Error(data.error.message)) : resolve(data);
    };
    cdp.on("Target.receivedMessageFromTarget", listener);
  });
  await cdp.send("Target.sendMessageToTarget", {
    sessionId,
    message: JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: {
        expression:
          "new Promise(resolve => { const click = () => { const button = document.querySelector('#capture'); if (document.readyState === 'complete' && button && !button.disabled) { button.click(); resolve(true); } else { setTimeout(click, 25); } }; click(); })",
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  });
  await response;
  try {
    await source.locator("#motionpaste-picker").waitFor({ state: "attached" });
  } catch (error) {
    const diagnostic = new Promise((resolve) => {
      const timer = setTimeout(() => resolve("Popup was unavailable."), 1000);
      const listener = (event) => {
        if (event.sessionId !== sessionId) return;
        const data = JSON.parse(event.message);
        if (data.id !== 2) return;
        clearTimeout(timer);
        cdp.off("Target.receivedMessageFromTarget", listener);
        resolve(data.result?.result?.value || data.error);
      };
      cdp.on("Target.receivedMessageFromTarget", listener);
    });
    await cdp
      .send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 2,
          method: "Runtime.evaluate",
          params: {
            expression:
              "JSON.stringify({state:document.readyState,status:document.querySelector('#status')?.textContent,disabled:document.querySelector('#capture')?.disabled})",
            returnByValue: true,
          },
        }),
      })
      .catch(() => undefined);
    const state = await context
      .serviceWorkers()[0]
      ?.evaluate(async () => ({
        tabs: (await chrome.tabs.query({})).map(
          ({ id, active, windowId, url }) => ({ id, active, windowId, url }),
        ),
        sessions: (
          (await chrome.storage.session.get("captureSessions"))
            .captureSessions || []
        ).map(({ tabId, documentId }) => ({ tabId, documentId })),
      }))
      .catch(() => undefined);
    throw new Error(
      `${error.message}\nPopup: ${await diagnostic}\nBrowser: ${JSON.stringify(state)}`,
    );
  }
  // The host may attach before the worker replies to BEGIN and the popup closes.
  // Wait for that reply so a subsequent invocation cannot toggle the old popup.
  let closed = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    const { targetInfos } = await cdp.send("Target.getTargets", {
      filter: [{ type: "page" }],
    });
    if (
      !targetInfos.some((target) => target.targetId === popupTarget.targetId)
    ) {
      closed = true;
      break;
    }
    await source.waitForTimeout(50);
  }
  assert.ok(closed, "Popup confirmed the picker started and closed");
  await cdp.detach();
}
