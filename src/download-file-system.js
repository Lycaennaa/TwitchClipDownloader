(function initializeDownloadFileSystem(global) {
  "use strict";

  const MAX_CREATOR_ENTRIES = 1000;
  const TEMP_PREFIX = ".tcd-download-";
  const CLEANUP_TIMEOUT_MS = 5000;
  const PROGRESS_INTERVAL_MS = 500;
  const TWITCH_CLIP_CLOUDFRONT_HOST = "d1ndex63qxojbr.cloudfront.net";

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || "Unknown file-system error");
  }

  function notFound(error) {
    return error?.name === "NotFoundError";
  }

  function abortError() {
    return new DOMException("Download cancelled.", "AbortError");
  }

  function abortable(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  function withTimeout(promise, action) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${action} timed out.`)), CLEANUP_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function combinedDeferredCleanup(errors) {
    const promises = errors.map((error) => error.deferredCleanup).filter(Boolean);
    return promises.length ? Promise.allSettled(promises) : null;
  }

  function describeJob(job) {
    const parts = String(job?.filename || "").split("/");
    if (parts.length !== 3 || parts[0] !== "Twitch Clips") throw new Error("Download filename has an invalid creator-folder path.");
    const creatorDirectory = parts[1];
    const targetFilename = parts[2];
    const slug = String(job?.slug || "");
    if (!creatorDirectory || creatorDirectory === "." || creatorDirectory === ".." || creatorDirectory.length > 100 || /[\\/\u0000-\u001f]/.test(creatorDirectory)) {
      throw new Error("Download creator directory is invalid.");
    }
    if (!targetFilename.endsWith(".mp4") || targetFilename.length > 255 || /[\\/\u0000-\u001f]/.test(targetFilename)) {
      throw new Error("Download target filename is invalid.");
    }
    if (!slug || slug.length > 100 || /[\[\]\\/\u0000-\u001f]/.test(slug) || !targetFilename.includes(`[${slug}]`)) {
      throw new Error("Download clip slug is invalid.");
    }
    return { creatorDirectory, slugMarker: `[${slug}]`, targetFilename };
  }

  function mediaURL(value) {
    let parsed;
    try {
      parsed = new URL(String(value || ""));
    } catch {
      throw new Error("Clip media URL is invalid.");
    }
    const host = parsed.hostname.toLowerCase();
    const twitchHost = host === "twitch.tv" || host.endsWith(".twitch.tv") || host === "twitchcdn.net" || host.endsWith(".twitchcdn.net") || host === TWITCH_CLIP_CLOUDFRONT_HOST;
    if (parsed.protocol !== "https:" || !twitchHost) throw new Error("Clip media URL must use HTTPS on a Twitch host.");
    return parsed.href;
  }

  function newTempFilename() {
    return `${TEMP_PREFIX}${crypto.randomUUID()}.partial`;
  }

  function isTempFilename(value) {
    return typeof value === "string" && value.startsWith(TEMP_PREFIX) && value.endsWith(".partial") && !/[\\/\u0000-\u001f]/.test(value);
  }

  async function requirePermission(handle) {
    const permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error(`Stored folder permission is ${permission}. Re-select the folder in the extension options page.`);
  }

  async function getEntry(directory, name) {
    try {
      return await directory.getFileHandle(name, { create: false });
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async function removeEntry(directory, name) {
    try {
      await directory.removeEntry(name);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  }

  async function findExistingClip(directory, slugMarker) {
    let scanned = 0;
    for await (const [name, entry] of directory.entries()) {
      if (scanned >= MAX_CREATOR_ENTRIES) throw new Error(`Creator directory contains more than ${MAX_CREATOR_ENTRIES} entries; narrow it before downloading.`);
      scanned += 1;
      if (entry.kind === "file" && name.endsWith(".mp4") && name.includes(slugMarker)) return name;
    }
    return null;
  }

  async function cancelResponse(response, error) {
    if (typeof response?.body?.cancel !== "function") return;
    let cancelPromise = null;
    try {
      cancelPromise = Promise.resolve(response.body.cancel(error));
      await withTimeout(cancelPromise, "Network response cancellation");
    } catch (cleanupError) {
      if (cancelPromise && /timed out\.$/.test(errorMessage(cleanupError))) cleanupError.deferredCleanup = cancelPromise;
      throw cleanupError;
    }
  }

  function responseSize(response) {
    const value = Number(response.headers?.get?.("content-length"));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function progressReporter(persistPhase) {
    let lastReportAt = 0;
    return async (bytesWritten) => {
      const now = Date.now();
      if (lastReportAt && now - lastReportAt < PROGRESS_INTERVAL_MS) return;
      await persistPhase({ bytesWritten });
      lastReportAt = now;
    };
  }

  async function writeReader(reader, writable, signal, reportProgress) {
    let bytesWritten = 0;
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return bytesWritten;
      await abortable(writable.write(value), signal);
      bytesWritten += value.byteLength;
      if (reportProgress) await reportProgress(bytesWritten);
    }
  }

  async function streamResponseToTemp(response, tempHandle, signal, reportProgress) {
    let reader = null;
    let writable = null;
    try {
      if (!response.ok) throw new Error(`Twitch media fetch failed: HTTP ${response.status} ${response.statusText}`.trim());
      if (!response.body) throw new Error("Twitch media response has no readable body.");
      writable = await tempHandle.createWritable({ keepExistingData: false });
      reader = response.body.getReader();
      const bytesWritten = await writeReader(reader, writable, signal, reportProgress);
      await abortable(writable.close(), signal);
      return bytesWritten;
    } catch (error) {
      const cleanupErrors = [];
      if (reader) {
        let readerCancelPromise = null;
        try {
          readerCancelPromise = Promise.resolve(reader.cancel(error));
          await withTimeout(readerCancelPromise, "Network stream cancellation");
        } catch (cleanupError) {
          if (readerCancelPromise && /timed out\.$/.test(errorMessage(cleanupError))) cleanupError.deferredCleanup = readerCancelPromise;
          cleanupErrors.push(cleanupError);
        }
      } else {
        try {
          await cancelResponse(response, error);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (writable) {
        let abortPromise = null;
        try {
          abortPromise = Promise.resolve(writable.abort(error));
          await withTimeout(abortPromise, "File stream cancellation");
        } catch (cleanupError) {
          if (abortPromise && /timed out\.$/.test(errorMessage(cleanupError))) cleanupError.deferredCleanup = abortPromise;
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        const cleanupFailure = new Error(`${errorMessage(error)} Temporary-file stream cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`);
        cleanupFailure.cleanupPending = true;
        cleanupFailure.deferredCleanup = combinedDeferredCleanup(cleanupErrors);
        throw cleanupFailure;
      }
      throw error;
    }
  }

  async function copyTempToTarget(tempHandle, targetHandle, signal) {
    let reader = null;
    let writable = null;
    try {
      const file = await tempHandle.getFile();
      reader = file.stream().getReader();
      writable = await targetHandle.createWritable({ keepExistingData: false });
      const bytesWritten = await writeReader(reader, writable, signal);
      await abortable(writable.close(), signal);
      return bytesWritten;
    } catch (error) {
      const cleanupErrors = [];
      if (reader) {
        let readerCancelPromise = null;
        try {
          readerCancelPromise = Promise.resolve(reader.cancel(error));
          await withTimeout(readerCancelPromise, "Temporary-file read cancellation");
        } catch (cleanupError) {
          if (readerCancelPromise && /timed out\.$/.test(errorMessage(cleanupError))) cleanupError.deferredCleanup = readerCancelPromise;
          cleanupErrors.push(cleanupError);
        }
      }
      if (writable) {
        let abortPromise = null;
        try {
          abortPromise = Promise.resolve(writable.abort(error));
          await withTimeout(abortPromise, "Target-file stream cancellation");
        } catch (cleanupError) {
          if (abortPromise && /timed out\.$/.test(errorMessage(cleanupError))) cleanupError.deferredCleanup = abortPromise;
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length) {
        const cleanupFailure = new Error(`${errorMessage(error)} Target-file stream cleanup failed: ${cleanupErrors.map(errorMessage).join("; ")}`);
        cleanupFailure.cleanupPending = true;
        cleanupFailure.deferredCleanup = combinedDeferredCleanup(cleanupErrors);
        throw cleanupFailure;
      }
      throw error;
    }
  }

  async function run({ job, rootHandle, signal, persistPhase }) {
    const description = describeJob(job);
    await requirePermission(rootHandle);
    const directory = await rootHandle.getDirectoryHandle(description.creatorDirectory, { create: true });
    const existing = await findExistingClip(directory, description.slugMarker);
    if (existing) return { status: "skipped", existingFilename: existing };

    const sourceURL = mediaURL(job.sourceURL);
    await persistPhase({ phase: "fetching" });
    const response = await fetch(sourceURL, { cache: "no-store", credentials: "omit", redirect: "error", signal });

    const tempFilename = job.tempFilename;
    let tempHandle;
    try {
      if (signal.aborted) throw abortError();
      if (!isTempFilename(tempFilename)) throw new Error("Download temporary filename is invalid.");
      if (await getEntry(directory, tempFilename)) throw new Error("Download temporary filename already exists.");
      const totalBytes = responseSize(response);
      await persistPhase({ bytesWritten: 0, phase: "writing", progressStartedAt: Date.now(), totalBytes });
      tempHandle = await directory.getFileHandle(tempFilename, { create: true });
    } catch (error) {
      try {
        await cancelResponse(response, error);
      } catch (cleanupError) {
        const cleanupFailure = new Error(`${errorMessage(error)} Network response cleanup failed: ${errorMessage(cleanupError)}`);
        cleanupFailure.cleanupPending = true;
        cleanupFailure.deferredCleanup = cleanupError.deferredCleanup;
        throw cleanupFailure;
      }
      throw error;
    }
    let tempCreated = true;
    let targetCreated = false;
    let targetCommitted = false;
    try {
      const reportProgress = progressReporter(persistPhase);
      const bytesWritten = await streamResponseToTemp(response, tempHandle, signal, reportProgress);
      await persistPhase({ bytesWritten, phase: "finalizing", targetCreated: false });

      const duplicate = await findExistingClip(directory, description.slugMarker);
      if (duplicate) {
        await removeEntry(directory, tempFilename);
        tempCreated = false;
        return { status: "skipped", existingFilename: duplicate };
      }
      if (await getEntry(directory, description.targetFilename)) throw new Error("Target filename appeared before finalization.");

      const targetHandle = await directory.getFileHandle(description.targetFilename, { create: true });
      const targetSnapshot = await targetHandle.getFile();
      if (targetSnapshot.size !== 0) throw new Error("Target filename appeared before finalization.");
      targetCreated = true;
      await persistPhase({ phase: "finalizing", targetCreated: true });
      const finalizedBytes = await copyTempToTarget(tempHandle, targetHandle, signal);
      if (finalizedBytes !== bytesWritten) throw new Error("Finalized file size does not match the downloaded temporary file.");
      targetCommitted = true;
      await persistPhase({ phase: "committed", targetCreated: true });
      await removeEntry(directory, tempFilename);
      tempCreated = false;
      return { bytesWritten, status: "completed" };
    } catch (error) {
      if (targetCommitted) {
        error.cleanupPending = true;
        throw error;
      }
      const cleanupErrors = [];
      if (targetCreated) {
        try {
          await removeEntry(directory, description.targetFilename);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (tempCreated && !error.cleanupPending) {
        try {
          await removeEntry(directory, tempFilename);
          tempCreated = false;
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length || error.cleanupPending) {
        const cleanupFailure = new Error(`${errorMessage(error)} Download-file cleanup failed${cleanupErrors.length ? `: ${cleanupErrors.map(errorMessage).join("; ")}` : "."}`);
        cleanupFailure.cleanupPending = true;
        cleanupFailure.deferredCleanup = error.deferredCleanup;
        throw cleanupFailure;
      }
      throw error;
    }
  }

  async function recover({ job, rootHandle }) {
    const description = describeJob(job);
    await requirePermission(rootHandle);
    let directory;
    try {
      directory = await rootHandle.getDirectoryHandle(description.creatorDirectory, { create: false });
    } catch (error) {
      if (!notFound(error)) throw error;
      return { status: job.cancelRequested ? "cancelled" : "pending" };
    }

    const tempHandle = isTempFilename(job.tempFilename) ? await getEntry(directory, job.tempFilename) : null;
    const targetHandle = await getEntry(directory, description.targetFilename);
    if (job.phase === "committed") {
      if (!targetHandle) return { status: job.cancelRequested ? "cancelled" : "pending" };
      if (tempHandle) await removeEntry(directory, job.tempFilename);
      return { status: "completed" };
    }

    if (job.phase === "finalizing" && job.targetCreated) {
      if (tempHandle && targetHandle) {
        const [tempFile, targetFile] = await Promise.all([tempHandle.getFile(), targetHandle.getFile()]);
        if (tempFile.size === targetFile.size) {
          await removeEntry(directory, job.tempFilename);
          return { status: "completed" };
        }
      }
      if (targetHandle) await removeEntry(directory, description.targetFilename);
      if (tempHandle) await removeEntry(directory, job.tempFilename);
      return { status: job.cancelRequested ? "cancelled" : "pending" };
    }

    if (job.phase === "finalizing" && targetHandle) {
      return { cleanupPending: true, error: "Target filename appeared during interrupted finalization; verify or remove it before retrying.", status: "failed" };
    }
    if (tempHandle) await removeEntry(directory, job.tempFilename);
    return { status: job.cancelRequested ? "cancelled" : "pending" };
  }

  global.TwitchDownloadFileSystem = Object.freeze({ describeJob, isTempFilename, newTempFilename, recover, run });
})(globalThis);
