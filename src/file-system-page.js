(function initializeFileSystemPage() {
  "use strict";

  const status = document.getElementById("status");
  const error = document.getElementById("error");
  const selectRoot = document.getElementById("select-root");
  const inspectRoot = document.getElementById("inspect-root");
  const runProbe = document.getElementById("run-probe");
  const cancelProbe = document.getElementById("cancel-probe");
  const creatorDirectory = document.getElementById("creator-directory");
  const mediaURL = document.getElementById("media-url");

  function showError(message = "") {
    error.textContent = message;
    error.hidden = !message;
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.ok) {
          reject(new Error(response?.error || "Extension request failed."));
        } else {
          resolve(response);
        }
      });
    });
  }

  function renderInspection(result) {
    if (!result.configured) {
      status.textContent = "No root folder is stored.";
      return;
    }
    const directories = result.directories.length ? result.directories.join(", ") : "None found";
    status.textContent = `Folder: ${result.name}\nPermission: ${result.permission}\nCreator directories: ${directories}${result.truncated ? " (entry scan capped)" : ""}${result.active ? "\nStream test active." : ""}${result.cleanupPending ? "\nStale temporary-file cleanup pending." : ""}`;
    if (!creatorDirectory.value && result.directories.length) creatorDirectory.value = result.directories[0];
  }

  async function inspect() {
    showError();
    const response = await sendMessage({ type: "GET_FILESYSTEM_STATUS" });
    renderInspection(response.fileSystem);
  }

  selectRoot.addEventListener("click", async () => {
    showError();
    try {
      if (typeof window.showDirectoryPicker !== "function") throw new Error("Folder selection is unavailable because this browser does not expose the File System Access API to extension pages. Use Chrome for folder-based downloads.");
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      const currentStatus = await sendMessage({ type: "GET_FILESYSTEM_STATUS" });
      const existing = await TwitchFileSystem.loadRootSelection();
      if (currentStatus.fileSystem.cleanupPending && existing?.handle && !await handle.isSameEntry(existing.handle)) {
        throw new Error("Re-select the previous folder so its stale temporary file can be cleaned before choosing another folder.");
      }
      let permission = await handle.queryPermission({ mode: "readwrite" });
      if (permission !== "granted") permission = await handle.requestPermission({ mode: "readwrite" });
      if (permission !== "granted") throw new Error("Read/write folder permission was not granted.");
      await TwitchFileSystem.saveRootHandle(handle);
      await inspect();
    } catch (caught) {
      if (caught?.name !== "AbortError") showError(caught instanceof Error ? caught.message : String(caught));
    }
  });

  inspectRoot.addEventListener("click", () => {
    void inspect().catch((caught) => showError(caught instanceof Error ? caught.message : String(caught)));
  });

  runProbe.addEventListener("click", async () => {
    showError();
    runProbe.disabled = true;
    cancelProbe.disabled = false;
    status.textContent = "Streaming clip to temporary file…";
    try {
      const response = await sendMessage({
        type: "RUN_FILESYSTEM_PROBE",
        creatorDirectory: creatorDirectory.value,
        sourceURL: mediaURL.value,
      });
      status.textContent = `Stream test complete. ${response.result.bytesWritten.toLocaleString()} bytes written and temporary file removed.`;
    } catch (caught) {
      await inspect().catch(() => {});
      showError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      runProbe.disabled = false;
      cancelProbe.disabled = true;
    }
  });

  cancelProbe.addEventListener("click", async () => {
    cancelProbe.disabled = true;
    try {
      await sendMessage({ type: "CANCEL_FILESYSTEM_PROBE" });
      status.textContent = "Cancellation requested. Waiting for cleanup…";
    } catch (caught) {
      showError(caught instanceof Error ? caught.message : String(caught));
    }
  });

  void inspect().catch((caught) => showError(caught instanceof Error ? caught.message : String(caught)));
})();
