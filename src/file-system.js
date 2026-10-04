(function initializeFileSystem(global) {
  "use strict";

  const DATABASE_NAME = "twitch-clip-downloader";
  const DATABASE_VERSION = 1;
  const HANDLE_STORE = "file-system-handles";
  const ROOT_HANDLE_KEY = "download-root";

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction aborted.")), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
    });
  }

  async function openDatabase() {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(HANDLE_STORE)) request.result.createObjectStore(HANDLE_STORE);
    });
    return requestResult(request);
  }

  async function saveRootHandle(handle) {
    const existing = await loadRootSelection();
    let id = crypto.randomUUID();
    if (existing?.handle?.isSameEntry && await handle.isSameEntry(existing.handle)) id = existing.id;
    const database = await openDatabase();
    try {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      transaction.objectStore(HANDLE_STORE).put({ handle, id }, ROOT_HANDLE_KEY);
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
    return id;
  }

  async function loadRootSelection() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(HANDLE_STORE, "readonly");
      const stored = await requestResult(transaction.objectStore(HANDLE_STORE).get(ROOT_HANDLE_KEY));
      await transactionComplete(transaction);
      if (!stored) return null;
      if (stored.handle && typeof stored.id === "string") return stored;
      return { handle: stored, id: "legacy" };
    } finally {
      database.close();
    }
  }

  async function loadRootHandle() {
    return (await loadRootSelection())?.handle || null;
  }

  async function clearRootHandle() {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(HANDLE_STORE, "readwrite");
      transaction.objectStore(HANDLE_STORE).delete(ROOT_HANDLE_KEY);
      await transactionComplete(transaction);
    } finally {
      database.close();
    }
  }

  global.TwitchFileSystem = Object.freeze({ clearRootHandle, loadRootHandle, loadRootSelection, saveRootHandle });
})(globalThis);
