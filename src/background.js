"use strict";

importScripts("clip-data.js", "file-system.js", "download-file-system.js");

const STORAGE_KEY = "downloadQueue";
const ALARM_NAME = "tcd-download-pump";
const MAX_CONCURRENT_DOWNLOADS = 10;
const MAX_QUEUE_SIZE = 1000;
const FILESYSTEM_PROBE_STORAGE_KEY = "fileSystemProbe";
const FILESYSTEM_PROBE_TEMP_PREFIX = ".tcd-filesystem-probe-";
const MAX_ROOT_ENTRIES = 1000;
const MAX_REPORTED_DIRECTORIES = 100;
const FILESYSTEM_CLEANUP_TIMEOUT_MS = 5000;
const TWITCH_CLIP_CLOUDFRONT_HOST = "d1ndex63qxojbr.cloudfront.net";
let activeFileSystemProbe = null;
const activeFileSystemDownloads = new Map();
let fileSystemSetupLock = Promise.resolve();
let operationLock = Promise.resolve();

function emptyState() {
  return { version: 1, jobs: [], createdAt: null, queueId: null };
}

async function loadState() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const state = stored[STORAGE_KEY];
  if (!state || state.version !== 1 || !Array.isArray(state.jobs)) return emptyState();
  state.jobs = state.jobs.slice(0, MAX_QUEUE_SIZE);
  for (const job of state.jobs) {
    if (!job.queuedAt && typeof state.createdAt === "string") job.queuedAt = state.createdAt;
    if (!job.operationId && typeof state.queueId === "string") job.operationId = `${state.queueId}:${state.jobs.indexOf(job)}`;
    if (!job.engine) job.engine = Number.isInteger(job.downloadId) && job.status === "active" ? "chrome" : "filesystem";
  }
  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

function serialize(task) {
  const result = operationLock.then(task, task);
  operationLock = result.catch(() => {});
  return result;
}

function serializeFileSystemSetup(task) {
  const result = fileSystemSetupLock.then(task, task);
  fileSystemSetupLock = result.catch(() => {});
  return result;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Unknown download error");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCurrentLegacyDownload(job, item) {
  if (!Number.isInteger(item.id) || (item.state !== "in_progress" && item.state !== "complete")) return false;
  if (item.state === "complete" && item.exists === false) return false;
  return typeof job.downloadURL === "string" && job.downloadURL !== job.sourceURL && (item.url === job.downloadURL || item.finalUrl === job.downloadURL);
}

async function findLegacyDownload(job) {
  const separator = "[\\\\/]";
  const directory = job.filename.slice(0, job.filename.lastIndexOf("/")).split("/").map(escapeRegex).join(separator);
  const slug = escapeRegex(job.slug);
  const matches = await chrome.downloads.search({
    filenameRegex: `(?:^|${separator})${directory}${separator}[^\\\\/]*\\[${slug}\\][^\\\\/]*\\.mp4$`,
    limit: 1000,
    orderBy: ["-startTime"],
  });
  const currentQueueDownload = matches.find((item) => isCurrentLegacyDownload(job, item));
  if (currentQueueDownload) return { item: currentQueueDownload, currentQueue: true };
  const completedDownload = matches.find((item) => item.state === "complete" && item.exists !== false);
  return completedDownload ? { item: completedDownload, currentQueue: false } : null;
}

async function reconcileActiveJobs(state) {
  for (const job of state.jobs) {
    if (job.engine === "filesystem" && (job.status === "active" || job.cleanupPending)) {
      if (activeFileSystemDownloads.has(job.operationId)) continue;
      const recoveringActiveJob = job.status === "active";
      const previousError = job.error;
      try {
        const selection = await requireRootSelection();
        if (job.rootId && job.rootId !== selection.id) throw new Error("The selected download root changed while a file-system download was active.");
        const recovered = await TwitchDownloadFileSystem.recover({ job, rootHandle: selection.handle });
        job.status = recoveringActiveJob || recovered.status === "completed" ? recovered.status : "failed";
        job.error = recovered.error || (job.status === "failed" ? previousError : "");
        job.cancelRequested = false;
        job.cleanupPending = Boolean(recovered.cleanupPending);
        if (!job.cleanupPending) clearFileSystemOperation(job);
      } catch (error) {
        job.status = "failed";
        job.error = `File-system download recovery failed: ${errorMessage(error)}`;
        job.cleanupPending = true;
      }
      continue;
    }
    if (job.status !== "active") continue;
    if (!Number.isInteger(job.downloadId)) continue;
    const matches = await chrome.downloads.search({ id: job.downloadId });
    const item = matches[0];
    if (!item) {
      job.status = "failed";
      job.error = "Download disappeared from Chrome.";
    } else if (item.state === "complete") {
      job.status = "completed";
      job.cancelRequested = false;
      job.error = "";
    } else if (item.state === "interrupted") {
      job.status = job.cancelRequested ? "cancelled" : "failed";
      job.cancelRequested = false;
      job.error = job.status === "failed" ? item.error || "Chrome interrupted the download." : "";
    } else if (job.cancelRequested) {
      await cancelLegacyJob(job);
    }
  }
}

async function cancelLegacyJob(job) {
  if (!Number.isInteger(job.downloadId)) {
    job.status = "failed";
    job.cancelRequested = false;
    job.error = "Could not cancel download: missing Chrome download ID.";
    return;
  }
  try {
    await chrome.downloads.cancel(job.downloadId);
    job.status = "cancelled";
    job.cancelRequested = false;
    job.error = "";
  } catch (error) {
    job.error = `Could not cancel download: ${errorMessage(error)}`;
  }
}

function clearFileSystemOperation(job) {
  delete job.rootId;
  delete job.creatorDirectory;
  delete job.targetFilename;
  delete job.tempFilename;
  delete job.phase;
  delete job.targetCreated;
  delete job.bytesWritten;
  delete job.totalBytes;
  delete job.progressStartedAt;
}

async function persistFileSystemPhase(operationId, changes) {
  return serialize(async () => {
    const state = await loadState();
    const job = state.jobs.find((candidate) => candidate.operationId === operationId);
    if (!job || job.status !== "active" || job.engine !== "filesystem") throw new DOMException("Download is no longer active.", "AbortError");
    if (job.cancelRequested) throw new DOMException("Download cancelled.", "AbortError");
    Object.assign(job, changes);
    await saveState(state);
  });
}

async function settleFileSystemDownload(operationId, outcome) {
  return serialize(async () => {
    const state = await loadState();
    const job = state.jobs.find((candidate) => candidate.operationId === operationId);
    if (!outcome.error?.deferredCleanup) activeFileSystemDownloads.delete(operationId);
    if (!job || job.status !== "active" || job.engine !== "filesystem") return;

    if (outcome.result) {
      job.status = outcome.result.status;
      job.error = "";
      job.cancelRequested = false;
      job.cleanupPending = false;
      clearFileSystemOperation(job);
    } else {
      const cancelled = outcome.error?.name === "AbortError" || job.cancelRequested;
      job.status = cancelled && !outcome.error?.cleanupPending ? "cancelled" : "failed";
      job.error = job.status === "failed" ? errorMessage(outcome.error) : "";
      job.cancelRequested = false;
      job.cleanupPending = Boolean(outcome.error?.cleanupPending);
      if (!job.cleanupPending) clearFileSystemOperation(job);
    }
    await saveState(state);
    if (!state.jobs.some((candidate) => candidate.cleanupPending)) await startAvailableJobs(state);
    await saveState(state);
    await syncAlarm(state);
  });
}

function launchFileSystemDownload(job, rootHandle) {
  const operationId = job.operationId;
  const controller = new AbortController();
  const task = TwitchDownloadFileSystem.run({
    job: structuredClone(job),
    rootHandle,
    signal: controller.signal,
    persistPhase: (changes) => persistFileSystemPhase(operationId, changes),
  });
  activeFileSystemDownloads.set(operationId, { controller, task });
  const watchDeferredCleanup = (promise) => {
    const active = activeFileSystemDownloads.get(operationId);
    if (active) active.deferredCleanup = promise;
    void Promise.resolve(promise).then(
      () => {
        activeFileSystemDownloads.delete(operationId);
        void serialize(() => updateState());
      },
      () => {
        activeFileSystemDownloads.delete(operationId);
        void serialize(() => updateState());
      },
    );
  };
  void task.then(
    (result) => settleFileSystemDownload(operationId, { result }),
    async (error) => {
      if (error?.deferredCleanup) watchDeferredCleanup(error.deferredCleanup);
      await settleFileSystemDownload(operationId, { error });
    },
  ).catch(() => {
    if (!activeFileSystemDownloads.get(operationId)?.deferredCleanup) activeFileSystemDownloads.delete(operationId);
  });
}

async function startAvailableJobs(state) {
  let activeCount = state.jobs.filter((job) => job.status === "active").length;
  while (activeCount < MAX_CONCURRENT_DOWNLOADS) {
    const job = state.jobs.find((candidate) => candidate.status === "pending");
    if (!job) break;

    const selection = await requireRootSelection();
    await requireRootPermission(selection.handle);
    if (state.jobs.some((candidate) => candidate.cleanupPending)) {
      throw new Error("A previous file-system download still needs cleanup before another download can start.");
    }
    const description = TwitchDownloadFileSystem.describeJob(job);
    job.engine = "filesystem";
    job.rootId = selection.id;
    job.creatorDirectory = description.creatorDirectory;
    job.targetFilename = description.targetFilename;
    job.tempFilename = TwitchDownloadFileSystem.newTempFilename();
    job.phase = "preparing";
    job.targetCreated = false;
    job.bytesWritten = 0;
    job.totalBytes = null;
    job.progressStartedAt = null;
    job.status = "active";
    job.cancelRequested = false;
    job.cleanupPending = false;
    job.error = "";
    await saveState(state);
    launchFileSystemDownload(job, selection.handle);
    activeCount += 1;
  }
}

async function syncAlarm(state) {
  const running = state.jobs.some((job) => job.status === "pending" || job.status === "active");
  if (running) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(ALARM_NAME);
  }
}

function summarize(state) {
  const counts = { pending: 0, active: 0, completed: 0, skipped: 0, failed: 0, cancelled: 0 };
  for (const job of state.jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  const now = Date.now();
  return {
    total: state.jobs.length,
    ...counts,
    activeDownloads: state.jobs.filter((job) => job.status === "active").slice(0, MAX_CONCURRENT_DOWNLOADS).map((job) => {
      const phase = ["preparing", "fetching", "writing", "finalizing", "committed"].includes(job.phase) ? job.phase : "preparing";
      const bytesWritten = Number.isSafeInteger(job.bytesWritten) && job.bytesWritten >= 0 ? job.bytesWritten : 0;
      const totalBytes = Number.isSafeInteger(job.totalBytes) && job.totalBytes > 0 ? job.totalBytes : null;
      const startedAt = Number.isSafeInteger(job.progressStartedAt) && job.progressStartedAt > 0 ? job.progressStartedAt : null;
      const elapsedMs = startedAt ? Math.max(1000, now - startedAt) : null;
      const bytesPerSecond = phase === "writing" && bytesWritten > 0 && elapsedMs ? Math.max(1, Math.round(bytesWritten * 1000 / elapsedMs)) : null;
      const etaSeconds = bytesPerSecond && totalBytes ? Math.max(0, Math.ceil((totalBytes - bytesWritten) / bytesPerSecond)) : null;
      return {
        slug: String(job.slug || ""),
        label: typeof job.targetFilename === "string" ? job.targetFilename.replace(/\.mp4$/, "") : String(job.slug || ""),
        phase,
        bytesWritten,
        totalBytes,
        bytesPerSecond,
        etaSeconds,
      };
    }),
    failedMessages: state.jobs.filter((job) => job.error).slice(0, 3).map((job) => `${job.slug}: ${job.error}`),
  };
}

async function updateState(mutator) {
  const state = await loadState();
  await reconcileActiveJobs(state);
  if (mutator) await mutator(state);
  if (state.jobs.some((job) => job.status === "pending")) {
    await saveState(state);
    await syncAlarm(state);
  }
  let startError = null;
  try {
    await startAvailableJobs(state);
  } catch (error) {
    startError = error;
  }
  await saveState(state);
  await syncAlarm(state);
  if (startError) throw startError;
  return summarize(state);
}

function buildJobs(clips, quality, orientation, queuedAt, queueId) {
  const jobs = [];
  const seenSlugs = new Set();
  for (const clip of clips.slice(0, MAX_QUEUE_SIZE)) {
    if (!clip || typeof clip.slug !== "string" || seenSlugs.has(clip.slug)) continue;
    seenSlugs.add(clip.slug);
    const selected = TwitchClipData.chooseQuality(clip, quality, orientation);
    const operationId = `${queueId}:${jobs.length}`;
    jobs.push({
      slug: clip.slug,
      sourceURL: selected?.sourceURL || "",
      filename: TwitchClipData.buildFilename(clip, selected?.orientation || orientation),
      operationId,
      engine: "filesystem",
      queuedAt,
      status: selected ? "pending" : "failed",
      downloadId: null,
      error: selected ? "" : `No ${orientation} media URL is available.`,
    });
  }
  return jobs;
}

async function loadProbeState() {
  const stored = await chrome.storage.local.get(FILESYSTEM_PROBE_STORAGE_KEY);
  const state = stored[FILESYSTEM_PROBE_STORAGE_KEY];
  return state?.version === 1 ? state : null;
}

async function saveProbeState(state) {
  await chrome.storage.local.set({ [FILESYSTEM_PROBE_STORAGE_KEY]: state });
}

async function requireRootSelection() {
  const selection = await TwitchFileSystem.loadRootSelection();
  if (!selection?.handle) throw new Error("No download root is stored. Select a folder in the extension options page.");
  return selection;
}

async function requireRootPermission(handle) {
  const permission = await handle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") throw new Error(`Stored folder permission is ${permission}. Re-select the folder in the extension options page.`);
}

function creatorDirectoryName(value) {
  const name = String(value || "").normalize("NFKC").trim();
  if (!name || name === "." || name === ".." || name.length > 100 || /[\\/\u0000-\u001f]/.test(name)) {
    throw new Error("Choose a valid existing creator directory.");
  }
  return name;
}

function twitchMediaURL(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    throw new Error("Enter a valid Twitch media URL.");
  }
  const host = parsed.hostname.toLowerCase();
  const twitchHost = host === "twitch.tv" || host.endsWith(".twitch.tv") || host === "twitchcdn.net" || host.endsWith(".twitchcdn.net") || host === TWITCH_CLIP_CLOUDFRONT_HOST;
  if (parsed.protocol !== "https:" || !twitchHost) throw new Error("Media URL must use HTTPS on a Twitch host.");
  return parsed.href;
}

function isNotFoundError(error) {
  return error?.name === "NotFoundError";
}

function newProbeTempFilename() {
  return `${FILESYSTEM_PROBE_TEMP_PREFIX}${crypto.randomUUID()}.partial`;
}

function isProbeTempFilename(value) {
  return typeof value === "string" && value.startsWith(FILESYSTEM_PROBE_TEMP_PREFIX) && value.endsWith(".partial") && !/[\\/\u0000-\u001f]/.test(value);
}

async function removeProbeFile(directory, filename) {
  try {
    await directory.removeEntry(filename);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException("Operation cancelled.", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Operation cancelled.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function cleanupWithTimeout(promise, action) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${action} timed out.`)), FILESYSTEM_CLEANUP_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function cleanupStaleProbe() {
  const state = await loadProbeState();
  if (!state) return false;
  if (state.phase === "fetching") {
    await saveProbeState(null);
    return false;
  }
  if (!isProbeTempFilename(state.tempFilename)) return true;
  const selection = await TwitchFileSystem.loadRootSelection();
  if (!selection?.handle || state.rootId !== selection.id || await selection.handle.queryPermission({ mode: "readwrite" }) !== "granted") return true;
  try {
    const directory = await selection.handle.getDirectoryHandle(state.creatorDirectory, { create: false });
    await removeProbeFile(directory, state.tempFilename);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  await saveProbeState(null);
  return false;
}

async function cleanupMatchingProbe(expected) {
  const state = await loadProbeState();
  if (!state || state.rootId !== expected.rootId || state.creatorDirectory !== expected.creatorDirectory || state.tempFilename !== expected.tempFilename) return false;
  return cleanupStaleProbe();
}

async function fileSystemStatus() {
  const probeCleanupPending = await serializeFileSystemSetup(async () => {
    await fileSystemRecovery;
    return activeFileSystemProbe ? false : cleanupStaleProbe();
  });
  const queueState = await loadState();
  const cleanupPending = probeCleanupPending || queueState.jobs.some((job) => job.cleanupPending || Boolean(activeFileSystemDownloads.get(job.operationId)?.deferredCleanup) || (job.engine === "filesystem" && job.status === "active" && !activeFileSystemDownloads.has(job.operationId)));
  const active = Boolean(activeFileSystemProbe);
  const selection = await TwitchFileSystem.loadRootSelection();
  const handle = selection?.handle;
  if (!handle) return { configured: false, permission: "missing", name: "", directories: [], truncated: false, cleanupPending, active };

  const permission = await handle.queryPermission({ mode: "readwrite" });
  const directories = [];
  let scanned = 0;
  let truncated = false;
  if (permission === "granted") {
    for await (const [name, entry] of handle.entries()) {
      if (scanned >= MAX_ROOT_ENTRIES) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (entry.kind === "directory" && directories.length < MAX_REPORTED_DIRECTORIES) directories.push(name);
    }
  }
  directories.sort((left, right) => left.localeCompare(right));
  return { configured: true, permission, name: handle.name || "Selected folder", directories, truncated, cleanupPending, active };
}

async function runFileSystemProbe(sourceURL, creatorDirectory) {
  if (activeFileSystemProbe) throw new Error("A file-system stream test is already running.");
  const controller = new AbortController();
  activeFileSystemProbe = controller;
  let directory = null;
  let reader = null;
  let writable = null;
  let tempCreated = false;
  let deferredWritableAbort = null;
  let probeIdentity = null;
  try {
    const setup = await serializeFileSystemSetup(async () => {
      await fileSystemRecovery;
      if (await cleanupStaleProbe()) throw new Error("A stale temporary file needs folder permission before another test can run.");
      const selection = await requireRootSelection();
      const handle = selection.handle;
      await requireRootPermission(handle);
      const directoryName = creatorDirectoryName(creatorDirectory);
      const mediaURL = twitchMediaURL(sourceURL);
      const tempFilename = newProbeTempFilename();
      const creatorHandle = await handle.getDirectoryHandle(directoryName, { create: false });
      await saveProbeState({
        version: 1,
        phase: "fetching",
        rootId: selection.id,
        creatorDirectory: directoryName,
        tempFilename,
        sourceURL: mediaURL,
        startedAt: new Date().toISOString(),
      });
      return { creatorHandle, directoryName, mediaURL, rootId: selection.id, tempFilename };
    });
    directory = setup.creatorHandle;
    const { directoryName, mediaURL, rootId, tempFilename } = setup;
    probeIdentity = { creatorDirectory: directoryName, rootId, tempFilename };
    const response = await fetch(mediaURL, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(`Twitch media fetch failed: HTTP ${response.status} ${response.statusText}`.trim());
    if (!response.body) throw new Error("Twitch media response has no readable body.");

    try {
      await directory.getFileHandle(tempFilename, { create: false });
      throw new Error("Temporary probe filename already exists.");
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    await saveProbeState({
      version: 1,
      phase: "writing",
      rootId,
      creatorDirectory: directoryName,
      tempFilename,
      sourceURL: mediaURL,
      startedAt: new Date().toISOString(),
    });
    const fileHandle = await directory.getFileHandle(tempFilename, { create: true });
    tempCreated = true;
    writable = await fileHandle.createWritable({ keepExistingData: false });
    reader = response.body.getReader();
    let bytesWritten = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), controller.signal);
      if (done) break;
      await abortable(writable.write(value), controller.signal);
      bytesWritten += value.byteLength;
    }
    await abortable(writable.close(), controller.signal);
    writable = null;
    await removeProbeFile(directory, tempFilename);
    tempCreated = false;
    await saveProbeState(null);
    return { bytesWritten };
  } catch (error) {
    const cleanupErrors = [];
    if (reader) {
      try {
        await cleanupWithTimeout(reader.cancel(error), "Network stream cancellation");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    let writableStopped = true;
    if (writable) {
      const abortPromise = Promise.resolve(writable.abort(error));
      try {
        await cleanupWithTimeout(abortPromise, "File stream cancellation");
      } catch (cleanupError) {
        writableStopped = false;
        deferredWritableAbort = abortPromise;
        cleanupErrors.push(cleanupError);
      }
    }
    if (directory && tempCreated && writableStopped) {
      try {
        const state = await loadProbeState();
        if (isProbeTempFilename(state?.tempFilename)) await removeProbeFile(directory, state.tempFilename);
        await saveProbeState(null);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else if (!tempCreated) {
      try {
        await saveProbeState(null);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length) throw new Error(`${errorMessage(error)} Temporary-file cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`);
    throw error;
  } finally {
    activeFileSystemProbe = null;
    if (deferredWritableAbort) {
      void deferredWritableAbort.then(
        () => serializeFileSystemSetup(() => cleanupMatchingProbe(probeIdentity)).catch(() => {}),
        () => {},
      );
    }
  }
}

const fileSystemRecovery = cleanupStaleProbe();
void fileSystemRecovery.catch(() => {});

async function handleMessage(message) {
  if (message?.type === "OPEN_FILESYSTEM_PAGE") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/file-system.html") });
    return { ok: true };
  }

  if (message?.type === "GET_FILESYSTEM_STATUS") {
    return { ok: true, fileSystem: await fileSystemStatus() };
  }

  if (message?.type === "RUN_FILESYSTEM_PROBE") {
    return { ok: true, result: await runFileSystemProbe(message.sourceURL, message.creatorDirectory) };
  }

  if (message?.type === "CANCEL_FILESYSTEM_PROBE") {
    if (activeFileSystemProbe) activeFileSystemProbe.abort();
    return { ok: true, cancellationRequested: Boolean(activeFileSystemProbe) };
  }
  if (message?.type === "GET_QUEUE_STATUS") {
    return { ok: true, queue: await serialize(async () => summarize(await loadState())) };
  }

  if (message?.type === "GET_QUEUE") {
    return { ok: true, queue: await serialize(() => updateState()) };
  }

  if (message?.type === "DOWNLOAD_CLIPS") {
    if (!Array.isArray(message.clips) || !message.clips.length) throw new Error("No clips are ready to download.");
    const queue = await serialize(() => updateState((state) => {
      if (state.jobs.some((job) => job.status === "pending" || job.status === "active")) {
        throw new Error("A download queue is already running.");
      }
      if (state.jobs.some((job) => job.cleanupPending)) {
        throw new Error("A previous file-system download still needs cleanup before a new queue can start.");
      }
      state.createdAt = new Date().toISOString();
      state.queueId = crypto.randomUUID();
      state.jobs = buildJobs(message.clips, message.quality, message.orientation, state.createdAt, state.queueId);
    }));
    return { ok: true, queue };
  }

  if (message?.type === "CANCEL_QUEUE") {
    const queue = await serialize(async () => {
      const state = await loadState();
      await reconcileActiveJobs(state);
      for (const job of state.jobs) {
        if (job.status === "pending") job.status = "cancelled";
        if (job.status === "active") job.cancelRequested = true;
      }
      await saveState(state);
      for (const job of state.jobs) {
        if (job.status !== "active" || !job.cancelRequested) continue;
        if (job.engine === "filesystem") {
          activeFileSystemDownloads.get(job.operationId)?.controller.abort();
        } else {
          await cancelLegacyJob(job);
        }
      }
      await saveState(state);
      await syncAlarm(state);
      return summarize(state);
    });
    return { ok: true, queue };
  }

  throw new Error("Unknown extension request.");
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

chrome.downloads.onChanged.addListener(() => {
  void serialize(() => updateState());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void serialize(() => updateState());
});
