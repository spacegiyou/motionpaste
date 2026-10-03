const captureButton = document.querySelector<HTMLButtonElement>("#capture");
const studioButton = document.querySelector<HTMLButtonElement>("#studio");
const statusElement = document.querySelector<HTMLElement>("#status");

function setStatus(message: string): void {
  if (statusElement) statusElement.textContent = message;
}

captureButton?.addEventListener("click", async () => {
  captureButton.disabled = true;
  setStatus("");
  try {
    // Resolve the user's tab in this popup's window before crossing contexts.
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab?.id === undefined)
      throw new Error("Open a normal HTTP or HTTPS page first.");
    const response: { ok: boolean; error?: string } | undefined =
      await chrome.runtime.sendMessage({
        type: "MOTIONPASTE_BEGIN_CAPTURE",
        tabId: tab.id,
        windowId: tab.windowId,
      });
    if (!response?.ok)
      throw new Error(response?.error ?? "Capture could not start. Try again.");
    window.close();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Capture could not start.";
    setStatus(
      /Cannot access|Missing host permission|extensions gallery|Web Store/i.test(
        message,
      )
        ? "Chrome protects this page from extensions. Try your own normal web page, then click MotionPaste again."
        : message,
    );
    captureButton.disabled = false;
  }
});

studioButton?.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("studio.html") });
    window.close();
  } catch {
    setStatus("Studio could not open. Reload the extension and try again.");
  }
});
