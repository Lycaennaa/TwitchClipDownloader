(function initializeDashboardPanel() {
  "use strict";

  const PAGE_SOURCE = "tcd-page";
  const CONTENT_SOURCE = "tcd-content";
  const clips = new Map();
  let scanRequested = false;
  let pollTimer = null;
  let polling = false;
  let refreshPromise = null;
  let folderRefreshPromise = null;
  let latestVersion = 0;
  let toolbarAnchor = null;
  let toolbarButton = null;
  let toolbarPositionScheduled = false;
  const PANEL_MARGIN = 8;

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!response?.ok) {
          reject(new Error(response?.error || "Extension request failed"));
        } else {
          resolve(response);
        }
      });
    });
  }

  function postToPage(type) {
    window.postMessage({ source: CONTENT_SOURCE, type }, "*");
  }

  function positionPanel(panel, left, top) {
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(PANEL_MARGIN, window.innerWidth - rect.width - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, window.innerHeight - rect.height - PANEL_MARGIN);
    panel.style.left = `${Math.min(Math.max(PANEL_MARGIN, left), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(PANEL_MARGIN, top), maxTop)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function keepPanelInViewport() {
    const panel = element("tcd-panel");
    if (!panel || panel.hidden) return;
    const rect = panel.getBoundingClientRect();
    positionPanel(panel, rect.left, rect.top);
  }

  function setPanelOpen(open) {
    const panel = element("tcd-panel");
    const toolbarButton = element("tcd-toolbar-button");
    if (!panel) return;
    panel.hidden = !open;
    toolbarButton?.setAttribute("aria-expanded", String(open));
    if (open) keepPanelInViewport();
  }

  function isElementVisible(element) {
    for (let current = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function positionToolbarButton() {
    const button = toolbarButton;
    if (!button) return null;
    const searchButton = [...document.querySelectorAll('button[aria-label*="Search"]')]
      .find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= 60
          && rect.right > 0 && rect.left < window.innerWidth
          && isElementVisible(candidate);
      });
    if (!searchButton) {
      toolbarAnchor?.classList.remove("tcd-toolbar-anchor");
      toolbarAnchor = null;
      const fallback = document.body || document.documentElement;
      if (button.parentElement !== fallback) fallback.append(button);
      return null;
    }
    const anchor = searchButton.parentElement;
    if (anchor !== toolbarAnchor || button.parentElement !== anchor) {
      toolbarAnchor?.classList.remove("tcd-toolbar-anchor");
      anchor.classList.add("tcd-toolbar-anchor");
      anchor.append(button);
      toolbarAnchor = anchor;
    }
    return searchButton;
  }

  function scheduleToolbarPosition() {
    if (toolbarPositionScheduled) return;
    toolbarPositionScheduled = true;
    window.requestAnimationFrame(() => {
      toolbarPositionScheduled = false;
      positionToolbarButton();
    });
  }

  function mountToolbarButton() {
    if (element("tcd-toolbar-button")) return;
    const button = document.createElement("button");
    toolbarButton = button;
    button.id = "tcd-toolbar-button";
    button.type = "button";
    button.textContent = "Clip Downloader";
    button.title = "Open Twitch Clip Downloader";
    button.setAttribute("aria-controls", "tcd-panel");
    button.setAttribute("aria-expanded", "true");
    button.addEventListener("click", () => setPanelOpen(true));
    (document.body || document.documentElement).append(button);
    positionToolbarButton();
    new MutationObserver(() => {
      if (!button.isConnected) (document.body || document.documentElement).append(button);
      scheduleToolbarPosition();
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["aria-label", "class", "hidden", "style"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", scheduleToolbarPosition);
  }

  function enablePanelMovement(panel) {
    const handle = panel.querySelector("#tcd-panel-header");
    let drag = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      positionPanel(panel, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    });
    const endDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag = null;
      handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
    handle.addEventListener("keydown", (event) => {
      if (!event.altKey) return;
      const offsets = {
        ArrowLeft: [-10, 0],
        ArrowRight: [10, 0],
        ArrowUp: [0, -10],
        ArrowDown: [0, 10],
      };
      const offset = offsets[event.key];
      if (!offset) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      positionPanel(panel, rect.left + offset[0], rect.top + offset[1]);
    });
    window.addEventListener("resize", keepPanelInViewport);
    new ResizeObserver(keepPanelInViewport).observe(panel);
  }

  function mountPanel() {
    if (document.getElementById("tcd-panel")) return;
    mountToolbarButton();
    const panel = document.createElement("aside");
    panel.id = "tcd-panel";
    panel.innerHTML = `
      <div id="tcd-panel-header" tabindex="0" aria-label="Move downloader panel. Drag or use Alt plus arrow keys.">
        <h2>Twitch Clip Downloader</h2>
        <button id="tcd-close" type="button" aria-label="Close Twitch Clip Downloader" title="Close">×</button>
      </div>
      <p id="tcd-folder-status">Folder: Loading…</p>
      <p id="tcd-status">Waiting for Twitch clip data…</p>
      <p id="tcd-warning" hidden></p>
      <p id="tcd-error" hidden></p>
      <div class="tcd-row">
        <label>Orientation
          <select id="tcd-orientation">
            <option value="landscape">Landscape</option>
            <option value="portrait">Portrait</option>
          </select>
        </label>
        <label>Quality
          <select id="tcd-quality">
            <option value="highest">Highest</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>
        </label>
      </div>
      <div class="tcd-row">
        <button id="tcd-scan" class="tcd-secondary">Scan all</button>
        <button id="tcd-download" disabled>Download all</button>
      </div>
        <p id="tcd-progress">No active download queue.</p>
        <div id="tcd-download-progress" hidden></div>
       <div class="tcd-row">
         <button id="tcd-folder" class="tcd-secondary">Folder access</button>
         <button id="tcd-cancel" class="tcd-danger" disabled>Cancel all</button>
       </div>
    `;
    (document.body || document.documentElement).append(panel);

    panel.querySelector("#tcd-close").addEventListener("click", () => setPanelOpen(false));
    panel.querySelector("#tcd-scan").addEventListener("click", () => requestScan(true));
    panel.querySelector("#tcd-download").addEventListener("click", downloadAll);
    panel.querySelector("#tcd-folder").addEventListener("click", openFileSystemPage);
    panel.querySelector("#tcd-cancel").addEventListener("click", cancelQueue);
    enablePanelMovement(panel);
    window.addEventListener("focus", refreshFolderStatus);
    void refreshFolderStatus();
    void refreshQueue();
  }

  function element(id) {
    return document.getElementById(id);
  }

  function showError(message = "") {
    const error = element("tcd-error");
    if (!error) return;
    error.textContent = message;
    error.hidden = !message;
  }

  function refreshFolderStatus() {
    if (folderRefreshPromise) return folderRefreshPromise;
    const folder = element("tcd-folder-status");
    if (!folder) return Promise.resolve();
    folderRefreshPromise = sendMessage({ type: "GET_FILESYSTEM_STATUS" })
      .then((response) => {
        folder.textContent = response.fileSystem.configured ? `Folder: ${response.fileSystem.name}` : "Folder: Not selected";
        folder.title = response.fileSystem.configured ? response.fileSystem.name : "";
      })
      .catch(() => {
        folder.textContent = "Folder: Unavailable";
        folder.title = "";
      })
      .finally(() => {
        folderRefreshPromise = null;
      });
    return folderRefreshPromise;
  }

  async function openFileSystemPage() {
    showError();
    try {
      await sendMessage({ type: "OPEN_FILESYSTEM_PAGE" });
    } catch (error) {
      showError(error.message);
    }
  }

  function renderClipCount(hasNextPage = false) {
    const status = element("tcd-status");
    const download = element("tcd-download");
    if (!status || !download) return;
    status.textContent = `${clips.size} clip${clips.size === 1 ? "" : "s"} found.`;
    download.disabled = clips.size === 0;

    const warning = element("tcd-warning");
    warning.hidden = !hasNextPage;
    warning.textContent = hasNextPage ? "Twitch returned more than 100 clips. Narrow the dashboard date filter, then scan each range." : "";
  }

  function requestScan(manual = false) {
    if (manual) showError();
    scanRequested = true;
    const status = element("tcd-status");
    if (status) status.textContent = "Scanning current dashboard filters…";
    postToPage("SCAN");
  }

  async function downloadAll() {
    showError();
    try {
      const quality = element("tcd-quality").value;
      const orientation = element("tcd-orientation").value;
      const response = await sendMessage({
        type: "DOWNLOAD_CLIPS",
        clips: [...clips.values()],
        quality,
        orientation,
      });
      renderQueue(response.queue);
      startPolling();
    } catch (error) {
      showError(error.message);
    }
  }

  async function cancelQueue() {
    showError();
    try {
      const response = await sendMessage({ type: "CANCEL_QUEUE" });
      renderQueue(response.queue);
    } catch (error) {
      showError(error.message);
    }
  }

  function formatBytes(value) {
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
  }

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
    return `${Math.ceil(seconds / 86400)}d`;
  }

  function progressText(download) {
    if (download.phase === "preparing") return "Preparing…";
    if (download.phase === "fetching") return "Connecting…";
    if (download.phase === "finalizing") return "Finalizing…";
    if (download.phase === "committed") return "Finishing…";
    const parts = [];
    if (download.totalBytes) {
      const percent = Math.min(100, Math.floor(download.bytesWritten / download.totalBytes * 100));
      parts.push(`${formatBytes(download.bytesWritten)} / ${formatBytes(download.totalBytes)} · ${percent}%`);
    } else {
      parts.push(`${formatBytes(download.bytesWritten)} downloaded`);
    }
    if (Number.isFinite(download.bytesPerSecond) && download.bytesPerSecond > 0) parts.push(`${formatBytes(download.bytesPerSecond)}/s`);
    if (Number.isFinite(download.etaSeconds) && download.etaSeconds >= 0) parts.push(`ETA ${formatDuration(download.etaSeconds)}`);
    return parts.join(" · ");
  }

  function renderDownloadProgress(downloads = []) {
    const container = element("tcd-download-progress");
    if (!container) return;
    container.replaceChildren();
    container.hidden = downloads.length === 0;
    for (const download of downloads) {
      const item = document.createElement("div");
      item.className = "tcd-download-item";
      const label = document.createElement("div");
      label.className = "tcd-download-label";
      const slug = document.createElement("span");
      slug.textContent = download.label || download.slug;
      const detail = document.createElement("span");
      detail.textContent = progressText(download);
      label.append(slug, detail);
      const progress = document.createElement("progress");
      if (download.totalBytes) {
        progress.max = download.totalBytes;
        progress.value = Math.min(download.bytesWritten, download.totalBytes);
      }
      item.append(label, progress);
      container.append(item);
    }
  }

  function renderQueue(queue) {
    if (!queue || !element("tcd-progress")) return;
    const running = queue.pending + queue.active > 0;
    element("tcd-progress").textContent = queue.total
      ? `${queue.completed}/${queue.total} complete · ${queue.skipped} skipped · ${queue.active} active · ${queue.pending} queued · ${queue.failed} failed`
      : "No active download queue.";
    renderDownloadProgress(queue.activeDownloads);
    element("tcd-cancel").disabled = !running;
    if (queue.failedMessages?.length) showError(queue.failedMessages.join(" · "));
    if (!running) stopPolling();
  }

  function refreshQueue() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = sendMessage({ type: "GET_QUEUE_STATUS" })
      .then((response) => {
        renderQueue(response.queue);
        if (response.queue.pending + response.queue.active > 0) startPolling();
      })
      .catch((error) => showError(error.message))
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  }

  async function pollQueue() {
    pollTimer = null;
    if (!polling) return;
    await refreshQueue();
    if (polling) pollTimer = window.setTimeout(pollQueue, 1000);
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    pollTimer = window.setTimeout(pollQueue, 1000);
  }

  function stopPolling() {
    polling = false;
    if (!pollTimer) return;
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }

  function beginRequest(version, statusText) {
    if (version < latestVersion) return false;
    latestVersion = version;
    clips.clear();
    renderClipCount(false);
    showError();
    const status = element("tcd-status");
    if (status) status.textContent = statusText;
    return true;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== PAGE_SOURCE) return;
    if (event.data.type === "LOADING") {
      const version = Number(event.data.version) || 0;
      if (beginRequest(version, "Loading current dashboard filters…")) scanRequested = false;
      return;
    }
    if (event.data.type === "CLIPS") {
      const version = Number(event.data.version) || 0;
      if (version < latestVersion) return;
      latestVersion = version;
      clips.clear();
      for (const clip of event.data.clips || []) clips.set(clip.slug, clip);
      scanRequested = false;
      renderClipCount(event.data.hasNextPage === true);
      showError();
      if (event.data.hasNextPage && event.data.limit < 100) requestScan();
      return;
    }
    if (event.data.type === "SCANNING") {
      const version = Number(event.data.version) || 0;
      beginRequest(version, "Scanning current dashboard filters…");
      return;
    }
    if (event.data.type === "ERROR") {
      const version = Number(event.data.version) || 0;
      if (version && version < latestVersion) return;
      if (version) {
        latestVersion = version;
        clips.clear();
        renderClipCount(false);
      }
      scanRequested = false;
      showError(event.data.message);
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
  } else {
    mountPanel();
  }
})();
