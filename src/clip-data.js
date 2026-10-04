(function initializeClipData(global) {
  "use strict";

  const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

  function qualityRank(quality) {
    const label = Number.parseInt(quality.quality, 10);
    if (Number.isFinite(label)) return label;
    return Math.min(quality.width || 0, quality.height || 0);
  }

  function authorizeSourceURL(sourceURL, playbackAccessToken) {
    if (typeof sourceURL !== "string") return "";
    let authorizedURL;
    try {
      authorizedURL = new URL(sourceURL);
    } catch {
      return "";
    }
    if (authorizedURL.protocol !== "http:" && authorizedURL.protocol !== "https:") return "";

    const signature = playbackAccessToken?.signature;
    const token = playbackAccessToken?.value;
    if (!authorizedURL.pathname.startsWith("/nauth/") || typeof signature !== "string" || !signature || typeof token !== "string" || !token) {
      return sourceURL;
    }

    authorizedURL.searchParams.set("sig", signature);
    authorizedURL.searchParams.set("token", token);
    return authorizedURL.href;
  }

  function normalizeQuality(value, orientation, playbackAccessToken) {
    const sourceURL = authorizeSourceURL(value?.sourceURL, playbackAccessToken);
    if (!sourceURL) return null;

    return {
      sourceURL,
      quality: String(value.quality || "source"),
      width: Number(value.width) || 0,
      height: Number(value.height) || 0,
      frameRate: Number(value.frameRate) || 0,
      orientation,
    };
  }

  function assetOrientation(asset) {
    if (String(asset?.id || "").toUpperCase().endsWith("/PORTRAIT")) return "portrait";
    if (String(asset?.id || "").toUpperCase().endsWith("/LANDSCAPE")) return "landscape";
    return Number(asset?.aspectRatio) < 1 ? "portrait" : "landscape";
  }

  function slugFromURL(value, broadcasterLogin) {
    if (typeof value !== "string") return "";
    let url;
    try {
      url = new URL(value);
    } catch {
      return "";
    }

    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:") return "";
    const parts = url.pathname.split("/");
    let slug = "";
    if (hostname === "clips.twitch.tv") {
      if (parts.length !== 2 || parts[0] !== "") return "";
      slug = parts[1]?.toLowerCase() === "embed" ? url.searchParams.get("clip") || "" : parts[1] || "";
    } else if (hostname === "twitch.tv" || hostname === "www.twitch.tv") {
      if (parts.length === 3 && parts[0] === "" && parts[1].toLowerCase() === "clip") {
        slug = parts[2];
      } else if (parts.length === 4 && parts[0] === "" && parts[2].toLowerCase() === "clip" && typeof broadcasterLogin === "string" && parts[1].toLowerCase() === broadcasterLogin.toLowerCase()) {
        slug = parts[3];
      }
    } else {
      return "";
    }

    try {
      slug = decodeURIComponent(slug);
    } catch {
      return "";
    }
    return /^[A-Za-z0-9_-]+$/.test(slug) ? slug : "";
  }

  function normalizeClipNode(node) {
    if (!node) return null;
    const slug = typeof node.slug === "string" && node.slug ? node.slug : slugFromURL(node.url, node.broadcaster?.login);
    if (!slug) return null;

    const qualities = [];
    const seenURLs = new Set();
    const addQuality = (value, orientation) => {
      const normalized = normalizeQuality(value, orientation, node.playbackAccessToken);
      if (!normalized || seenURLs.has(normalized.sourceURL)) return;
      seenURLs.add(normalized.sourceURL);
      qualities.push(normalized);
    };

    for (const asset of Array.isArray(node.assets) ? node.assets : []) {
      const orientation = assetOrientation(asset);
      for (const quality of Array.isArray(asset.videoQualities) ? asset.videoQualities : []) {
        addQuality(quality, orientation);
      }
    }

    for (const quality of Array.isArray(node.videoQualities) ? node.videoQualities : []) {
      addQuality(quality, "landscape");
    }

    const durationSeconds = Number(node.durationSeconds ?? node.duration);
    const guests = (Array.isArray(node.guestStarParticipants?.guests) ? node.guestStarParticipants.guests : [])
      .map((guest) => String(guest?.displayName || guest?.login || "").trim())
      .filter(Boolean);

    return {
      id: String(node.id || slug),
      slug,
      url: typeof node.url === "string" ? node.url : `https://clips.twitch.tv/${slug}`,
      title: typeof node.title === "string" && node.title.trim() ? node.title.trim() : "Untitled clip",
      createdAt: typeof node.createdAt === "string" ? node.createdAt : "",
      durationSeconds: Number.isFinite(durationSeconds) && durationSeconds >= 0 ? durationSeconds : null,
      viewCount: Number.isSafeInteger(node.viewCount) && node.viewCount >= 0 ? node.viewCount : null,
      game: String(node.game?.displayName || node.game?.name || "").trim(),
      guests,
      broadcaster: String(node.broadcaster?.displayName || node.broadcaster?.login || "Unknown channel"),
      broadcasterLogin: String(node.broadcaster?.login || node.broadcaster?.displayName || "Unknown channel"),
      qualities,
    };
  }

  function extractClipPage(payload) {
    const connection = payload?.data?.user?.clips;
    if (!connection || !Array.isArray(connection.edges)) {
      return { clips: [], hasNextPage: false };
    }

    const clips = [];
    const seenSlugs = new Set();
    for (const edge of connection.edges) {
      const clip = normalizeClipNode(edge?.node);
      if (!clip || seenSlugs.has(clip.slug)) continue;
      seenSlugs.add(clip.slug);
      clips.push(clip);
    }

    return {
      clips,
      hasNextPage: connection.pageInfo?.hasNextPage === true,
    };
  }

  function chooseQuality(clip, requestedQuality = "highest", requestedOrientation = "landscape") {
    const all = Array.isArray(clip?.qualities) ? clip.qualities : [];
    const matchingOrientation = all.filter((quality) => quality.orientation === requestedOrientation);
    const candidates = matchingOrientation.length ? matchingOrientation : all;
    if (!candidates.length) return null;

    const descending = [...candidates].sort((left, right) => {
      const rankDifference = qualityRank(right) - qualityRank(left);
      if (rankDifference) return rankDifference;
      return (right.frameRate || 0) - (left.frameRate || 0);
    });

    if (requestedQuality === "highest") return descending[0];

    const target = Number.parseInt(requestedQuality, 10);
    if (!Number.isFinite(target)) return descending[0];
    return descending.find((quality) => qualityRank(quality) <= target) || descending.at(-1);
  }

  function safeFilenamePart(value, fallback) {
    const cleaned = String(value || "")
      .normalize("NFKC")
      .replace(INVALID_FILENAME_CHARACTERS, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim();
    return cleaned || fallback;
  }

  function buildFilename(clip, orientation = "landscape") {
    const parsedDate = new Date(clip?.createdAt || "");
    let timestamp = "";
    if (!Number.isNaN(parsedDate.valueOf())) {
      const isoTimestamp = parsedDate.toISOString();
      timestamp = `${isoTimestamp.slice(0, 10).replaceAll("-", "")} ${isoTimestamp.slice(11, 19).replaceAll(":", "")}`;
    }

    const broadcaster = safeFilenamePart(clip?.broadcaster, "Unknown channel");
    const creator = safeFilenamePart(clip?.broadcasterLogin || clip?.broadcaster, "Unknown channel");
    const title = safeFilenamePart(clip?.title, "Untitled clip");
    const slug = safeFilenamePart(clip?.slug, "unknown-clip");
    const game = safeFilenamePart(clip?.game, "");
    const guests = safeFilenamePart(Array.isArray(clip?.guests) ? clip.guests.join(", ") : "", "");
    const parts = timestamp ? [timestamp, broadcaster, title] : [broadcaster, title];
    if (Number.isFinite(clip?.durationSeconds) && clip.durationSeconds >= 0) parts.push(`${clip.durationSeconds}s`);
    if (game) parts.push(`Game is ${game}`);
    if (guests) parts.push(`Guests are ${guests}`);
    if (Number.isSafeInteger(clip?.viewCount) && clip.viewCount >= 0) parts.push(`${clip.viewCount} ${clip.viewCount === 1 ? "view" : "views"}`);
    if (orientation === "portrait") parts.push("portrait");
    return `Twitch Clips/${creator}/${parts.join(" - ")} [${slug}].mp4`;
  }

  global.TwitchClipData = Object.freeze({
    buildFilename,
    chooseQuality,
    extractClipPage,
    normalizeClipNode,
  });
})(globalThis);
