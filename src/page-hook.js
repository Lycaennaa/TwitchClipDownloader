(function installTwitchClipHook() {
  "use strict";

  if (window.__twitchClipDownloaderHookInstalled) return;
  window.__twitchClipDownloaderHookInstalled = true;

  const PAGE_SOURCE = "tcd-page";
  const CONTENT_SOURCE = "tcd-content";
  const CLIPS_OPERATION = "ContentClipsManager_User";
  const MAX_CLIPS = 100;
  const originalFetch = window.fetch;
  let requestTemplate = null;
  let scanInProgress = false;
  let responseVersion = 0;

  function post(type, detail = {}) {
    window.postMessage({ source: PAGE_SOURCE, type, ...detail }, "*");
  }

  function operationList(body) {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  function targetOperationIndex(operations) {
    return operations.findIndex((operation) => operation?.operationName === CLIPS_OPERATION);
  }

  function inspectRequest(input, init) {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input?.url || "";
    if (!url.includes("gql.twitch.tv/gql")) return null;

    if (typeof init?.body === "string") {
      return {
        bodyPromise: Promise.resolve(init.body),
        replay: { kind: "init", input, init: { ...init } },
      };
    }

    if (input instanceof Request) {
      try {
        const bodyClone = input.clone();
        const replayClone = input.clone();
        return {
          bodyPromise: bodyClone.text(),
          replay: { kind: "request", request: replayClone },
        };
      } catch {
        return null;
      }
    }

    return null;
  }

  async function publishResponse(response, operations, limit, version, isScan = false) {
    try {
      const payload = await response.clone().json();
      const responses = Array.isArray(payload) ? payload : [payload];
      const operationIndex = targetOperationIndex(operations);
      const result = responses[operationIndex];
      if (result?.errors?.length) {
        throw new Error(result.errors.map((entry) => entry.message).join("; "));
      }
      const extracted = TwitchClipData.extractClipPage(result);
      post("CLIPS", { ...extracted, limit, version, isScan });
    } catch (error) {
      post("ERROR", { message: `Could not read Twitch clip data: ${error.message}`, version });
    }
  }

  window.fetch = async function twitchClipFetchHook(input, init) {
    const inspected = inspectRequest(input, init);
    const responsePromise = originalFetch.apply(this, arguments);
    if (!inspected) return responsePromise;

    try {
      const body = await inspected.bodyPromise;
      const operations = operationList(body);
      const operationIndex = targetOperationIndex(operations);
      if (operationIndex < 0) return responsePromise;

      const version = ++responseVersion;
      requestTemplate = { ...inspected.replay, operations };
      const limit = Number(operations[operationIndex]?.variables?.limit) || 0;
      post("LOADING", { version });
      const response = await responsePromise;
      void publishResponse(response, operations, limit, version);
      return response;
    } catch {
      return responsePromise;
    }
  };

  async function scanAllClips() {
    if (scanInProgress) return;
    if (!requestTemplate) {
      post("ERROR", { message: "Reload this dashboard page once, then scan again." });
      return;
    }

    scanInProgress = true;
    const template = requestTemplate;
    const version = ++responseVersion;
    post("SCANNING", { version });
    try {
      const operations = structuredClone(template.operations);
      const operationIndex = targetOperationIndex(operations);
      operations[operationIndex].variables.limit = MAX_CLIPS;
      const body = JSON.stringify(Array.isArray(template.operations) ? operations : operations[0]);
      let response;

      if (template.kind === "init") {
        response = await originalFetch(template.input, { ...template.init, body });
      } else {
        response = await originalFetch(new Request(template.request.clone(), { body }));
      }

      if (!response.ok) throw new Error(`Twitch returned HTTP ${response.status}`);
      await publishResponse(response, operations, MAX_CLIPS, version, true);
    } catch (error) {
      post("ERROR", { message: `Scan failed: ${error.message}`, version });
    } finally {
      scanInProgress = false;
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== CONTENT_SOURCE) return;
    if (event.data.type === "SCAN") void scanAllClips();
  });
})();
