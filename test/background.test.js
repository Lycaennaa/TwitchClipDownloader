import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const clipDataSource = await readFile(new URL("../src/clip-data.js", import.meta.url), "utf8");
const downloadFileSystemSource = await readFile(new URL("../src/download-file-system.js", import.meta.url), "utf8");
const backgroundSource = await readFile(new URL("../src/background.js", import.meta.url), "utf8");

function extensionEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    },
    listeners,
  };
}

function notFoundError() {
  const error = new Error("Entry not found");
  error.name = "NotFoundError";
  return error;
}

function createRootHandle({ abortPending = false, createWritableError = null, directoryNames = ["Channel"], existingFiles = [], onFileHandle = null, permission = "granted", removeError = null, writeError = null, writePending = false, writePendingCount = 0 } = {}) {
  const directoryFiles = new Map();
  const writes = [];
  const removeCalls = [];
  let permissionState = permission;
  let pendingWrites = writePending ? Number.POSITIVE_INFINITY : writePendingCount;
  let removalError = removeError;
  let resolveAbort = null;
  let writeStarted = false;

  function directoryHandle(name) {
    const files = new Map(name === directoryNames[0] ? existingFiles.map((filename) => [filename, new Uint8Array()]) : []);
    directoryFiles.set(name, files);
    return {
      kind: "directory",
      name,
      async getFileHandle(filename, options) {
        if (!files.has(filename) && !options?.create) throw notFoundError();
        if (!files.has(filename)) files.set(filename, new Uint8Array());
        if (onFileHandle) await onFileHandle({ files, filename, options });
        return {
          async getFile() {
            const bytes = files.get(filename) || new Uint8Array();
            return {
              size: bytes.byteLength,
              stream() {
                let read = false;
                return {
                  getReader() {
                    return {
                      async cancel() {},
                      async read() {
                        if (read) return { done: true, value: undefined };
                        read = true;
                        return { done: false, value: bytes };
                      },
                    };
                  },
                };
              },
            };
          },
          async createWritable() {
            if (createWritableError) throw new Error(createWritableError);
            const chunks = [];
            return {
              abort() {
                if (!abortPending) return Promise.resolve();
                return new Promise((resolve) => {
                  resolveAbort = resolve;
                });
              },
              async close() {
                const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
                const data = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                  data.set(chunk, offset);
                  offset += chunk.byteLength;
                }
                files.set(filename, data);
              },
              async write(value) {
                writeStarted = true;
                if (writeError) throw new Error(writeError);
                writes.push(value.byteLength);
                chunks.push(new Uint8Array(value));
                if (pendingWrites > 0) {
                  pendingWrites -= 1;
                  return new Promise(() => {});
                }
              },
            };
          },
        };
      },
      async removeEntry(filename) {
        removeCalls.push(filename);
        if (removalError) throw new Error(removalError);
        if (!files.delete(filename)) throw notFoundError();
      },
      async *entries() {
        for (const filename of files.keys()) yield [filename, { kind: "file", name: filename }];
      },
    };
  }

  const directories = new Map(directoryNames.map((name) => [name, directoryHandle(name)]));
  const files = directoryFiles.get(directoryNames[0]) || new Map();
  const handle = {
    kind: "directory",
    name: "Twitch Clips",
    async queryPermission() {
      return permissionState;
    },
    async getDirectoryHandle(name, options) {
      if (!directories.has(name) && options?.create) directories.set(name, directoryHandle(name));
      const directory = directories.get(name);
      if (!directory) throw notFoundError();
      return directory;
    },
    async *entries() {
      for (const entry of directories) yield entry;
    },
  };

  return {
    completeAbort() {
      resolveAbort?.();
    },
    files,
    filesFor(name) {
      return directoryFiles.get(name) || new Map();
    },
    handle,
    removeCalls,
    setPermission(value) {
      permissionState = value;
    },
    setRemoveError(value) {
      removalError = value;
    },
    get writeStarted() {
      return writeStarted;
    },
    writes,
  };
}

function responseFromChunks(chunks, totalBytes = null) {
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get(name) {
        return name.toLowerCase() === "content-length" && totalBytes !== null ? String(totalBytes) : null;
      },
    },
    body: {
      getReader() {
        return {
          async cancel() {},
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
        };
      },
    },
  };
}

async function createBackground({ cancelError = null, clearTimeoutImpl = clearTimeout, fetchImpl = async () => { throw new Error("unexpected fetch"); }, initialProbeState = null, initialQueueState = null, root = null, searchError = null, setTimeoutImpl = setTimeout, uuid = randomUUID } = {}) {
  const storage = {};
  if (initialProbeState) storage.fileSystemProbe = structuredClone(initialProbeState);
  if (initialQueueState) storage.downloadQueue = structuredClone(initialQueueState);
  const downloadItems = new Map();
  const downloadCalls = [];
  const cancelCalls = [];
  const runtimeMessages = extensionEvent();
  const downloadChanges = extensionEvent();
  const alarms = extensionEvent();
  const tabCalls = [];
  let nextDownloadId = 1;
  let storageSetFailureCountdown = null;
  let downloadSearchError = searchError;
  let context;

  const chrome = {
    storage: {
      local: {
        async get(key) {
          return storage[key] === undefined ? {} : { [key]: structuredClone(storage[key]) };
        },
        async set(values) {
          if (Number.isInteger(storageSetFailureCountdown)) {
            storageSetFailureCountdown -= 1;
            if (storageSetFailureCountdown === 0) {
              storageSetFailureCountdown = null;
              throw new Error("storage unavailable");
            }
          }
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    downloads: {
      async download(options) {
        const id = nextDownloadId++;
        downloadCalls.push({ id, ...options });
        downloadItems.set(id, {
          id,
          state: "in_progress",
          exists: true,
          filename: `/Downloads/${options.filename}`,
          startTime: new Date().toISOString(),
          url: options.url,
        });
        return id;
      },
      async search(query) {
        if (Number.isInteger(query.id)) {
          const item = downloadItems.get(query.id);
          return item ? [structuredClone(item)] : [];
        }
        if (downloadSearchError) throw new Error(downloadSearchError);
        const filenameRegex = new RegExp(query.filenameRegex);
        return [...downloadItems.values()]
          .filter((item) => typeof item.filename === "string" && filenameRegex.test(item.filename))
          .slice(0, query.limit)
          .map((item) => structuredClone(item));
      },
      async cancel(id) {
        cancelCalls.push(id);
        if (cancelError) throw new Error(cancelError);
        const item = downloadItems.get(id);
        if (item) item.state = "interrupted";
      },
      onChanged: downloadChanges,
    },
    alarms: {
      async create() {},
      async clear() {
        return true;
      },
      onAlarm: alarms,
    },
    runtime: {
      getURL(path) {
        return `chrome-extension://test/${path}`;
      },
      onMessage: runtimeMessages,
    },
    tabs: {
      async create(options) {
        tabCalls.push(options);
        return { id: 1, ...options };
      },
    },
  };

  context = vm.createContext({
    AbortController,
    DOMException,
    URL,
    chrome,
    console,
    crypto: { randomUUID: uuid },
    fetch: fetchImpl,
    importScripts(...scripts) {
      if (scripts.includes("clip-data.js")) vm.runInContext(clipDataSource, context);
      if (scripts.includes("download-file-system.js")) vm.runInContext(downloadFileSystemSource, context);
    },
    setTimeout: setTimeoutImpl,
    clearTimeout: clearTimeoutImpl,
    structuredClone,
    TwitchFileSystem: {
      async loadRootSelection() {
        return root ? { handle: root.handle, id: "root-1" } : null;
      },
    },
  });
  vm.runInContext(backgroundSource, context);
  await new Promise((resolve) => setImmediate(resolve));

  async function send(message) {
    const listener = runtimeMessages.listeners[0];
    return new Promise((resolve) => listener(message, {}, resolve));
  }

  function completeActiveDownloads() {
    for (const item of downloadItems.values()) {
      if (item.state !== "in_progress") continue;
      item.state = "complete";
      downloadChanges.emit({ id: item.id, state: { current: "complete" } });
    }
  }

  function removeDownloadedFiles() {
    for (const item of downloadItems.values()) item.exists = false;
  }

  function failStorageSetIn(callCount) {
    storageSetFailureCountdown = callCount;
  }

  function setSearchError(message) {
    downloadSearchError = message;
  }

  return { cancelCalls, completeActiveDownloads, downloadCalls, failStorageSetIn, removeDownloadedFiles, send, setSearchError, storage, tabCalls };
}

function clips(count, withMedia = true) {
  return Array.from({ length: count }, (_, index) => ({
    slug: `clip-${index}`,
    title: `Clip ${index}`,
    broadcaster: "Channel",
    createdAt: "2026-07-28T10:12:35Z",
    qualities: withMedia
      ? [{ quality: "1080", width: 1920, height: 1080, frameRate: 60, orientation: "landscape", sourceURL: `https://production.assets.clips.twitchcdn.net/${index}.mp4` }]
      : [],
  }));
}

test("does not start a stored pending queue when the dashboard loads", async () => {
  const root = createRootHandle();
  let fetchCalls = 0;
  const queuedAt = "2026-07-28T10:12:35Z";
  const initialQueueState = {
    version: 1,
    createdAt: queuedAt,
    queueId: "queue-1",
    jobs: [{
      slug: "clip-0",
      sourceURL: "https://production.assets.clips.twitchcdn.net/0.mp4",
      filename: "Twitch Clips/Channel/20260728 101235 - Channel - Clip 0 [clip-0].mp4",
      operationId: "queue-1:0",
      engine: "filesystem",
      queuedAt,
      status: "pending",
      downloadId: null,
      error: "",
    }],
  };
  const background = await createBackground({
    initialQueueState,
    root,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });

  assert.equal(fetchCalls, 0);
  const response = await background.send({ type: "GET_QUEUE_STATUS" });
  assert.equal(response.ok, true);
  assert.equal(response.queue.pending, 1);
  assert.equal(response.queue.active, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(root.files.size, 0);
});

test("loads the stored handle and bounds creator-directory enumeration", async () => {
  const directoryNames = Array.from({ length: 1002 }, (_, index) => `creator-${index}`);
  const root = createRootHandle({ directoryNames });
  const background = await createBackground({ root });

  const response = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(response.ok, true);
  assert.equal(response.fileSystem.configured, true);
  assert.equal(response.fileSystem.permission, "granted");
  assert.equal(response.fileSystem.directories.length, 100);
  assert.equal(response.fileSystem.truncated, true);
});

test("surfaces revoked folder permission without enumerating", async () => {
  const root = createRootHandle({ permission: "prompt" });
  const background = await createBackground({ root });

  const response = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(response.ok, true);
  assert.equal(response.fileSystem.permission, "prompt");
  assert.equal(response.fileSystem.directories.length, 0);
});

test("streams media with bounded writes and removes the temporary file", async () => {
  const root = createRootHandle();
  const chunks = [new Uint8Array(7), new Uint8Array(11), new Uint8Array(13)];
  let fetchOptions;
  const background = await createBackground({
    root,
    fetchImpl: async (_url, options) => {
      fetchOptions = options;
      return responseFromChunks(chunks);
    },
  });

  const response = await background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.bytesWritten, 31);
  assert.deepEqual(root.writes, [7, 11, 13]);
  assert.equal(root.files.size, 0);
  assert.equal(background.storage.fileSystemProbe, null);
  assert.equal(fetchOptions.redirect, "error");
});

test("surfaces write failure and removes the partial file", async () => {
  const root = createRootHandle({ writeError: "disk full" });
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(8)]) });

  const response = await background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://clips-media-assets2.twitch.tv/clip.mp4",
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /disk full/);
  assert.equal(root.files.size, 0);
  assert.equal(background.storage.fileSystemProbe, null);
});

test("does not overwrite or remove a colliding temporary filename", async () => {
  const uuid = "33333333-3333-4333-8333-333333333333";
  const tempFilename = `.tcd-filesystem-probe-${uuid}.partial`;
  const root = createRootHandle({ existingFiles: [tempFilename] });
  const background = await createBackground({
    root,
    uuid: () => uuid,
    fetchImpl: async () => responseFromChunks([new Uint8Array(8)]),
  });

  const response = await background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /already exists/);
  assert.equal(root.files.has(tempFilename), true);
  assert.equal(root.removeCalls.length, 0);
  assert.equal(background.storage.fileSystemProbe, null);
});

test("cancels an active stream and removes the partial file", async () => {
  const root = createRootHandle();
  const fetchImpl = async (_url, options) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader() {
        return {
          async cancel() {},
          read() {
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
            });
          },
        };
      },
    },
  });
  const background = await createBackground({ root, fetchImpl });
  const running = background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
  });
  while (root.files.size === 0) await new Promise((resolve) => setImmediate(resolve));

  const activeStatus = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(activeStatus.ok, true);
  assert.equal(activeStatus.fileSystem.active, true);
  assert.equal(root.files.size, 1);
  assert.equal(background.storage.fileSystemProbe.phase, "writing");

  const cancellation = await background.send({ type: "CANCEL_FILESYSTEM_PROBE" });
  const response = await running;
  assert.equal(cancellation.ok, true);
  assert.equal(cancellation.cancellationRequested, true);
  assert.equal(response.ok, false);
  assert.match(response.error, /cancelled|stream aborted/i);
  assert.equal(root.files.size, 0);
});

test("concurrent status does not clear a probe while setup starts", async () => {
  const root = createRootHandle();
  const fetchImpl = async (_url, options) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    body: {
      getReader() {
        return {
          async cancel() {},
          read() {
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
            });
          },
        };
      },
    },
  });
  const background = await createBackground({ root, fetchImpl });

  const statusPromise = background.send({ type: "GET_FILESYSTEM_STATUS" });
  const running = background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
  });
  const status = await statusPromise;
  while (root.files.size === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.ok, true);
  assert.equal(background.storage.fileSystemProbe.phase, "writing");
  assert.equal(root.files.size, 1);

  await background.send({ type: "CANCEL_FILESYSTEM_PROBE" });
  await running;
});

test("cancellation escapes a stalled filesystem write and removes the partial file", async () => {
  const root = createRootHandle({ writePending: true });
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(8)]) });
  const running = background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
  });
  while (!root.writeStarted) await new Promise((resolve) => setImmediate(resolve));

  await background.send({ type: "CANCEL_FILESYSTEM_PROBE" });
  const response = await Promise.race([
    running,
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "test timeout" }), 250)),
  ]);
  assert.equal(response.ok, false);
  assert.notEqual(response.error, "test timeout");
  assert.match(response.error, /cancelled/i);
  assert.equal(root.files.size, 0);
  assert.equal(background.storage.fileSystemProbe, null);
});

test("delayed writable abort triggers deferred partial-file cleanup", async () => {
  const root = createRootHandle({ abortPending: true, writePending: true });
  const background = await createBackground({
    root,
    fetchImpl: async () => responseFromChunks([new Uint8Array(8)]),
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });
  const running = background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
  });
  while (!root.writeStarted) await new Promise((resolve) => setImmediate(resolve));

  await background.send({ type: "CANCEL_FILESYSTEM_PROBE" });
  const response = await running;
  assert.equal(response.ok, false);
  assert.match(response.error, /File stream cancellation timed out/);
  assert.equal(root.files.size, 1);
  assert.equal(background.storage.fileSystemProbe.phase, "writing");

  root.completeAbort();
  while (root.files.size) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(background.storage.fileSystemProbe, null);
});

test("old deferred cleanup cannot clear a replacement probe", async () => {
  const root = createRootHandle({ abortPending: true, writePendingCount: 1 });
  let fetchCount = 0;
  const fetchImpl = async (_url, options) => {
    fetchCount += 1;
    if (fetchCount === 1) return responseFromChunks([new Uint8Array(8)]);
    let readCount = 0;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader() {
          return {
            async cancel() {},
            read() {
              readCount += 1;
              if (readCount === 1) return Promise.resolve({ done: false, value: new Uint8Array(4) });
              return new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new Error("stream aborted")), { once: true });
              });
            },
          };
        },
      },
    };
  };
  const background = await createBackground({
    root,
    fetchImpl,
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });
  const first = background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/first.mp4",
  });
  while (!root.writeStarted) await new Promise((resolve) => setImmediate(resolve));
  await background.send({ type: "CANCEL_FILESYSTEM_PROBE" });
  await first;

  await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(background.storage.fileSystemProbe, null);
  const second = background.send({
    type: "RUN_FILESYSTEM_PROBE",
    creatorDirectory: "Channel",
    sourceURL: "https://production.assets.clips.twitchcdn.net/second.mp4",
  });
  while (background.storage.fileSystemProbe?.phase !== "writing") await new Promise((resolve) => setImmediate(resolve));
  const replacementTemp = background.storage.fileSystemProbe.tempFilename;

  root.completeAbort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(background.storage.fileSystemProbe.tempFilename, replacementTemp);
  assert.equal(root.files.has(replacementTemp), true);

  await background.send({ type: "CANCEL_FILESYSTEM_PROBE" });
  await second;
  root.completeAbort();
  while (root.files.size) await new Promise((resolve) => setImmediate(resolve));
});

test("cleans a stale partial file after worker restart", async () => {
  const tempFilename = ".tcd-filesystem-probe-11111111-1111-4111-8111-111111111111.partial";
  const root = createRootHandle({ existingFiles: [tempFilename] });
  const background = await createBackground({
    root,
    initialProbeState: {
      version: 1,
      phase: "writing",
      rootId: "root-1",
      creatorDirectory: "Channel",
      tempFilename,
      sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
      startedAt: "2026-07-28T10:12:35Z",
    },
  });

  const response = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(response.ok, true);
  assert.equal(response.fileSystem.cleanupPending, false);
  assert.equal(root.files.size, 0);
  assert.equal(background.storage.fileSystemProbe, null);
});

test("does not clean stale state from a different selected root", async () => {
  const tempFilename = ".tcd-filesystem-probe-22222222-2222-4222-8222-222222222222.partial";
  const root = createRootHandle({ existingFiles: [tempFilename] });
  const background = await createBackground({
    root,
    initialProbeState: {
      version: 1,
      phase: "writing",
      rootId: "previous-root",
      creatorDirectory: "Channel",
      tempFilename,
      sourceURL: "https://production.assets.clips.twitchcdn.net/clip.mp4",
      startedAt: "2026-07-28T10:12:35Z",
    },
  });

  const response = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(response.ok, true);
  assert.equal(response.fileSystem.cleanupPending, true);
  assert.equal(root.files.has(tempFilename), true);
  assert.equal(background.storage.fileSystemProbe.rootId, "previous-root");
});

async function waitForQueue(background, predicate, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await background.send({ type: "GET_QUEUE" });
    if (response.ok && predicate(response.queue)) return response.queue;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Queue did not reach expected state.");
}

test("opens the visible file-system page through the service worker", async () => {
  const background = await createBackground();
  const response = await background.send({ type: "OPEN_FILESYSTEM_PAGE" });
  assert.equal(response.ok, true);
  assert.equal(background.tabCalls.length, 1);
  assert.equal(background.tabCalls[0].url, "chrome-extension://test/src/file-system.html");
});

test("surfaces missing folder selection without using Chrome downloads", async () => {
  let fetchCalls = 0;
  const background = await createBackground({
    root: null,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });

  const response = await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  assert.equal(response.ok, false);
  assert.match(response.error, /No download root is stored/);
  assert.equal(fetchCalls, 0);
  assert.equal(background.downloadCalls.length, 0);
});

test("downloads portrait media when landscape is unavailable", async () => {
  const root = createRootHandle();
  const [clip] = clips(1);
  clip.qualities[0] = { ...clip.qualities[0], width: 1080, height: 1920, orientation: "portrait" };
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(8)]) });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: [clip], quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.completed === 1);
  assert.equal(queue.failed, 0);
  assert.equal(root.filesFor("Channel").has("20260728 101235 - Channel - Clip 0 - portrait [clip-0].mp4"), true);
});

test("inspects creator files directly and skips an existing clip slug", async () => {
  const filename = "2026-07-28 - Channel - Existing title [clip-0].mp4";
  const root = createRootHandle({ existingFiles: [filename] });
  let fetchCalls = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.skipped === 1);
  assert.equal(queue.active, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(background.downloadCalls.length, 0);
  assert.equal(root.files.has(filename), true);
});

test("does not skip the same slug in another creator directory", async () => {
  const root = createRootHandle({
    directoryNames: ["Channel", "Other Channel"],
    existingFiles: ["2026-07-28 - Channel - Existing title [clip-0].mp4"],
  });
  const [clip] = clips(1);
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(12)]) });

  await background.send({
    type: "DOWNLOAD_CLIPS",
    clips: [{ ...clip, broadcaster: "Other Channel" }],
    quality: "highest",
    orientation: "landscape",
  });
  const queue = await waitForQueue(background, (value) => value.completed === 1);
  assert.equal(queue.skipped, 0);
  assert.equal(root.filesFor("Other Channel").has("20260728 101235 - Other Channel - Clip 0 [clip-0].mp4"), true);
});

test("streams at most ten production downloads concurrently", async () => {
  const root = createRootHandle();
  const releases = [];
  let activeFetches = 0;
  let maxActiveFetches = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => new Promise((resolve) => {
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      releases.push(() => {
        activeFetches -= 1;
        resolve(responseFromChunks([new Uint8Array(10)]));
      });
    }),
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(12), quality: "highest", orientation: "landscape" });
  while (releases.length < 10) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActiveFetches, 10);
  releases.shift()();
  while (releases.length < 10) await new Promise((resolve) => setImmediate(resolve));
  releases.shift()();
  while (releases.length < 10) await new Promise((resolve) => setImmediate(resolve));
  while (releases.length) releases.shift()();

  const queue = await waitForQueue(background, (value) => value.completed === 12);
  assert.equal(queue.active, 0);
  assert.equal(queue.pending, 0);
  assert.equal(maxActiveFetches, 10);
  assert.equal(background.downloadCalls.length, 0);
});

test("reports active file-system download bytes and content-length progress", async () => {
  const root = createRootHandle();
  let finishRead;
  let readCount = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: {
        get(name) {
          return name.toLowerCase() === "content-length" ? "20" : null;
        },
      },
      body: {
        getReader() {
          return {
            async cancel() {
              finishRead?.();
            },
            read() {
              if (readCount++ === 0) return Promise.resolve({ done: false, value: new Uint8Array(8) });
              return new Promise((resolve) => {
                finishRead = () => resolve({ done: true, value: undefined });
              });
            },
          };
        },
      },
    }),
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.activeDownloads?.[0]?.bytesWritten === 8);
  assert.equal(queue.activeDownloads[0].slug, "clip-0");
  assert.equal(queue.activeDownloads[0].label, "20260728 101235 - Channel - Clip 0 [clip-0]");
  assert.equal(queue.activeDownloads[0].phase, "writing");
  assert.equal(queue.activeDownloads[0].totalBytes, 20);
  assert.ok(queue.activeDownloads[0].bytesPerSecond > 0);
  assert.ok(queue.activeDownloads[0].etaSeconds > 0);

  await background.send({ type: "CANCEL_QUEUE" });
  await waitForQueue(background, (value) => value.cancelled === 1);
});

test("cancels active file writes and removes operation-owned temporary files", async () => {
  const root = createRootHandle();
  const background = await createBackground({
    root,
    fetchImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader() {
          return {
            async cancel() {},
            read() {
              return new Promise((_resolve, reject) => {
                options.signal.addEventListener("abort", () => reject(new DOMException("Download cancelled.", "AbortError")), { once: true });
              });
            },
          };
        },
      },
    }),
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(2), quality: "highest", orientation: "landscape" });
  while (root.files.size < 2) await new Promise((resolve) => setImmediate(resolve));
  const response = await background.send({ type: "CANCEL_QUEUE" });
  assert.equal(response.ok, true);
  const queue = await waitForQueue(background, (value) => value.cancelled === 2);
  assert.equal(queue.active, 0);
  assert.equal(root.files.size, 0);
});

test("retains cleanup ownership until a timed-out writable abort finishes", async () => {
  const root = createRootHandle({ abortPending: true, writePending: true });
  const background = await createBackground({
    root,
    fetchImpl: async () => responseFromChunks([new Uint8Array(8)]),
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  while (!root.writeStarted) await new Promise((resolve) => setImmediate(resolve));
  await background.send({ type: "CANCEL_QUEUE" });
  const failedQueue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(failedQueue.failedMessages[0], /timed out/);
  let status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, true);
  assert.equal(root.files.size, 1);

  root.completeAbort();
  for (let attempt = 0; attempt < 100 && root.files.size; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, false);
  assert.equal(root.files.size, 0);
});

test("retains network cleanup ownership when settlement storage fails", async () => {
  const root = createRootHandle();
  let completeReaderCancel;
  const background = await createBackground({
    root,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        getReader() {
          return {
            cancel() {
              return new Promise((resolve) => {
                completeReaderCancel = resolve;
              });
            },
            read() {
              return new Promise(() => {});
            },
          };
        },
      },
    }),
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  while (root.files.size === 0) await new Promise((resolve) => setImmediate(resolve));
  background.failStorageSetIn(3);
  const cancellation = await background.send({ type: "CANCEL_QUEUE" });
  assert.equal(cancellation.ok, true);
  while (!completeReaderCancel) await new Promise((resolve) => setImmediate(resolve));
  let status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, true);
  assert.equal(root.files.size, 1);

  completeReaderCancel();
  const queue = await waitForQueue(background, (value) => value.cancelled === 1);
  assert.equal(queue.active, 0);
  status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, false);
  assert.equal(root.files.size, 0);
});

test("retains ownership while an HTTP failure response is still cancelling", async () => {
  const root = createRootHandle();
  let completeResponseCancel;
  const background = await createBackground({
    root,
    fetchImpl: async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      body: {
        cancel() {
          return new Promise((resolve) => {
            completeResponseCancel = resolve;
          });
        },
      },
    }),
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  while (!completeResponseCancel) await new Promise((resolve) => setImmediate(resolve));
  const failedQueue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(failedQueue.failedMessages[0], /HTTP 403/);
  let status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, true);
  assert.equal(root.files.size, 1);

  completeResponseCancel();
  for (let attempt = 0; attempt < 100 && root.files.size; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, false);
  assert.equal(root.files.size, 0);
});

test("cancels the response when creating the temporary writable fails", async () => {
  const root = createRootHandle({ createWritableError: "writable unavailable" });
  let responseCancelled = false;
  const background = await createBackground({
    root,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      body: {
        async cancel() {
          responseCancelled = true;
        },
        getReader() {
          throw new Error("reader should not be requested");
        },
      },
    }),
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(queue.failedMessages[0], /writable unavailable/);
  assert.equal(responseCancelled, true);
  assert.equal(root.files.size, 0);
});

test("surfaces production write failure and removes partial files", async () => {
  const root = createRootHandle({ writeError: "disk full" });
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(8)]) });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(queue.failedMessages[0], /disk full/);
  assert.equal(root.files.size, 0);
});

test("blocks replacement queues until deferred file cleanup succeeds", async () => {
  const root = createRootHandle({ removeError: "folder busy", writeError: "disk full" });
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(8)]) });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const failedQueue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(failedQueue.failedMessages[0], /folder busy/i);
  let status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, true);

  const blocked = await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /still needs cleanup/);

  root.setRemoveError(null);
  await background.send({ type: "GET_QUEUE" });
  status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, false);
  assert.equal(root.files.size, 0);
});

test("stores pending queue intent before network or filesystem side effects", async () => {
  const root = createRootHandle();
  let fetchCalls = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });
  background.failStorageSetIn(1);

  const response = await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  assert.equal(response.ok, false);
  assert.match(response.error, /storage unavailable/);
  assert.equal(fetchCalls, 0);
  assert.equal(root.files.size, 0);
});

test("persists the fetching phase before issuing the media request", async () => {
  const root = createRootHandle();
  let fetchCalls = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });
  background.failStorageSetIn(4);

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(queue.failedMessages[0], /storage unavailable/);
  assert.equal(fetchCalls, 0);
  assert.equal(root.files.size, 0);
});

test("fails closed when creator-directory enumeration exceeds its bound", async () => {
  const existingFiles = Array.from({ length: 1001 }, (_, index) => `unrelated-${index}.mp4`);
  const root = createRootHandle({ existingFiles });
  let fetchCalls = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(queue.failedMessages[0], /more than 1000 entries/);
  assert.equal(fetchCalls, 0);
  assert.equal(root.files.size, 1001);
});

test("does not truncate a target that appears during finalization", async () => {
  const targetFilename = "20260728 101235 - Channel - Clip 0 [clip-0].mp4";
  const root = createRootHandle({
    onFileHandle({ files, filename, options }) {
      if (options?.create && filename === targetFilename) files.set(filename, new Uint8Array([1, 2, 3]));
    },
  });
  const background = await createBackground({ root, fetchImpl: async () => responseFromChunks([new Uint8Array(8)]) });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(queue.failedMessages[0], /appeared before finalization/);
  assert.equal(root.files.get(targetFilename).byteLength, 3);
  assert.equal([...root.files.keys()].filter((name) => name.endsWith(".partial")).length, 0);
});

test("downloads clips from Twitch's CloudFront distribution", async () => {
  const root = createRootHandle();
  const [clip] = clips(1);
  clip.qualities[0].sourceURL = "https://d1ndex63qxojbr.cloudfront.net/nauth/clip/landscape/h264/1080/index.mp4";
  let fetchedURL;
  const background = await createBackground({
    root,
    fetchImpl: async (url) => {
      fetchedURL = url;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: [clip], quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.completed === 1);
  assert.equal(queue.failed, 0);
  assert.equal(fetchedURL, clip.qualities[0].sourceURL);
});

test("rejects untrusted CloudFront media URLs before fetch", async () => {
  const root = createRootHandle();
  const [clip] = clips(1);
  clip.qualities[0].sourceURL = "https://attacker.cloudfront.net/clip.mp4";
  let fetchCalls = 0;
  const background = await createBackground({
    root,
    fetchImpl: async () => {
      fetchCalls += 1;
      return responseFromChunks([new Uint8Array(8)]);
    },
  });

  await background.send({ type: "DOWNLOAD_CLIPS", clips: [clip], quality: "highest", orientation: "landscape" });
  const queue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(queue.failedMessages[0], /Twitch host/);
  assert.equal(fetchCalls, 0);
});

test("recovers a committed target after worker restart and removes its temp file", async () => {
  const targetFilename = "2026-07-28 - Channel - Clip 0 [clip-0].mp4";
  const tempFilename = ".tcd-download-11111111-1111-4111-8111-111111111111.partial";
  const root = createRootHandle({ existingFiles: [targetFilename, tempFilename] });
  const initialQueueState = {
    version: 1,
    createdAt: "2026-07-28T10:12:35Z",
    queueId: "queue-1",
    jobs: [{
      slug: "clip-0",
      sourceURL: "https://production.assets.clips.twitchcdn.net/0.mp4",
      filename: `Twitch Clips/Channel/${targetFilename}`,
      operationId: "queue-1:0",
      engine: "filesystem",
      rootId: "root-1",
      creatorDirectory: "Channel",
      targetFilename,
      tempFilename,
      phase: "committed",
      targetCreated: true,
      status: "active",
      cancelRequested: false,
      error: "",
    }],
  };
  const background = await createBackground({ initialQueueState, root });

  const queue = await waitForQueue(background, (value) => value.completed === 1);
  assert.equal(queue.failed, 0);
  assert.equal(root.files.has(targetFilename), true);
  assert.equal(root.files.has(tempFilename), false);
});

test("blocks false duplicate detection after ambiguous target creation on restart", async () => {
  const targetFilename = "2026-07-28 - Channel - Clip 0 [clip-0].mp4";
  const tempFilename = ".tcd-download-22222222-2222-4222-8222-222222222222.partial";
  const root = createRootHandle({ existingFiles: [targetFilename, tempFilename] });
  const initialQueueState = {
    version: 1,
    createdAt: "2026-07-28T10:12:35Z",
    queueId: "queue-2",
    jobs: [{
      slug: "clip-0",
      sourceURL: "https://production.assets.clips.twitchcdn.net/0.mp4",
      filename: `Twitch Clips/Channel/${targetFilename}`,
      operationId: "queue-2:0",
      engine: "filesystem",
      rootId: "root-1",
      creatorDirectory: "Channel",
      targetFilename,
      tempFilename,
      phase: "finalizing",
      targetCreated: false,
      status: "active",
      cancelRequested: false,
      error: "",
    }],
  };
  const background = await createBackground({ initialQueueState, root });

  const failedQueue = await waitForQueue(background, (value) => value.failed === 1);
  assert.match(failedQueue.failedMessages[0], /verify or remove/);
  let status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, true);
  const blocked = await background.send({ type: "DOWNLOAD_CLIPS", clips: clips(1), quality: "highest", orientation: "landscape" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /still needs cleanup/);

  root.files.delete(targetFilename);
  await background.send({ type: "GET_QUEUE" });
  status = await background.send({ type: "GET_FILESYSTEM_STATUS" });
  assert.equal(status.fileSystem.cleanupPending, false);
  assert.equal(root.files.has(tempFilename), false);
});
