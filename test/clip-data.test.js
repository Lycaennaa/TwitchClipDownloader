import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../src/clip-data.js", import.meta.url), "utf8");
const context = vm.createContext({ URL });
vm.runInContext(source, context);
const { buildFilename, chooseQuality, extractClipPage } = context.TwitchClipData;

const playbackSignature = "signature+/=";
const playbackToken = JSON.stringify({ authorization: { forbidden: false }, clip_slug: "ClipSlug" });

const landscape1080 = {
  quality: "1080",
  width: 1920,
  height: 1080,
  frameRate: 60,
  sourceURL: "https://media.example/nauth/clip/landscape/h264/1080/index.mp4",
};
const landscape720 = {
  quality: "720",
  width: 1280,
  height: 720,
  frameRate: 60,
  sourceURL: "https://media.example/nauth/clip/landscape/h264/720/index.mp4",
};
const portrait1080 = {
  quality: "1080",
  width: 1080,
  height: 1920,
  frameRate: 60,
  sourceURL: "https://media.example/nauth/clip/portrait/h264/1080/index.mp4",
};

function clipPayload() {
  return {
    data: {
      user: {
        clips: {
          pageInfo: { hasNextPage: true },
          edges: [
            {
              node: {
                id: "123",
                slug: "ClipSlug",
                url: "https://clips.twitch.tv/ClipSlug",
                title: "A clip: with / invalid * characters",
                createdAt: "2026-07-28T10:12:35Z",
                durationSeconds: 29,
                viewCount: 12345,
                broadcaster: { displayName: "ChannelName", login: "channelname" },
                game: { name: "Just Chatting" },
                guestStarParticipants: {
                  guests: [
                    { displayName: "Guest One", login: "guestone" },
                    { displayName: "", login: "guesttwo" },
                  ],
                },
                playbackAccessToken: { signature: playbackSignature, value: playbackToken },
                assets: [
                  { id: "asset/LANDSCAPE", aspectRatio: 16 / 9, videoQualities: [landscape720, landscape1080] },
                  { id: "asset/PORTRAIT", aspectRatio: 9 / 16, videoQualities: [portrait1080] },
                ],
              },
            },
          ],
        },
      },
    },
  };
}

test("extracts required clip metadata and authorizes media URLs", () => {
  const result = extractClipPage(clipPayload());
  assert.equal(result.hasNextPage, true);
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].slug, "ClipSlug");
  assert.equal(result.clips[0].viewCount, 12345);
  assert.equal(result.clips[0].durationSeconds, 29);
  assert.equal(result.clips[0].game, "Just Chatting");
  assert.equal(JSON.stringify(result.clips[0].guests), JSON.stringify(["Guest One", "guesttwo"]));
  assert.equal(result.clips[0].qualities.length, 3);
  assert.equal("playbackAccessToken" in result.clips[0], false);
  for (const quality of result.clips[0].qualities) {
    const sourceURL = new URL(quality.sourceURL);
    assert.equal(sourceURL.searchParams.get("sig"), playbackSignature);
    assert.equal(sourceURL.searchParams.get("token"), playbackToken);
  }
});

test("selects requested orientation and nearest available quality", () => {
  const [clip] = extractClipPage(clipPayload()).clips;
  assert.equal(new URL(chooseQuality(clip, "highest", "landscape").sourceURL).pathname, new URL(landscape1080.sourceURL).pathname);
  assert.equal(new URL(chooseQuality(clip, "720", "landscape").sourceURL).pathname, new URL(landscape720.sourceURL).pathname);
  assert.equal(new URL(chooseQuality(clip, "720", "portrait").sourceURL).pathname, new URL(portrait1080.sourceURL).pathname);
});

test("preserves public media URLs when Twitch omits an access token", () => {
  const payload = clipPayload();
  delete payload.data.user.clips.edges[0].node.playbackAccessToken;
  const [clip] = extractClipPage(payload).clips;
  assert.equal(chooseQuality(clip, "highest", "landscape").sourceURL, landscape1080.sourceURL);
});

test("does not add clip authorization to public media URLs", () => {
  const payload = clipPayload();
  const publicURL = "HTTPS://media.example/public.mp4?existing=1";
  payload.data.user.clips.edges[0].node.assets[0].videoQualities[1] = { ...landscape1080, sourceURL: publicURL };
  const [clip] = extractClipPage(payload).clips;
  assert.equal(chooseQuality(clip, "highest", "landscape").sourceURL, publicURL);
});

test("falls back to the available orientation", () => {
  const [clip] = extractClipPage(clipPayload()).clips;
  clip.qualities = clip.qualities.filter((quality) => quality.orientation === "portrait");
  assert.equal(new URL(chooseQuality(clip, "highest", "landscape").sourceURL).pathname, new URL(portrait1080.sourceURL).pathname);
});

test("recovers missing slugs from Twitch clip URLs", () => {
  for (const url of [
    "https://clips.twitch.tv/RecoveredSlug",
    "https://www.twitch.tv/channelname/clip/RecoveredSlug",
    "https://www.twitch.tv/clip/RecoveredSlug",
    "https://clips.twitch.tv/embed?clip=RecoveredSlug",
  ]) {
    const payload = clipPayload();
    const node = payload.data.user.clips.edges[0].node;
    delete node.slug;
    node.url = url;
    assert.equal(extractClipPage(payload).clips[0]?.slug, "RecoveredSlug");
  }
});

test("does not recover missing slugs from untrusted or malformed URLs", () => {
  for (const url of [
    "https://example.com/RecoveredSlug",
    "https://help.twitch.tv/channelname/clip/RecoveredSlug",
    "https://www.twitch.tv/otherchannel/clip/RecoveredSlug",
    "https://www.twitch.tv/settings?clip=RecoveredSlug",
    "https://clips.twitch.tv/RecoveredSlug/extra",
    "https://clips.twitch.tv//RecoveredSlug//",
    "https://clips.twitch.tv/%20RecoveredSlug%20",
    "https://www.twitch.tv/channelname//clip/RecoveredSlug",
  ]) {
    const payload = clipPayload();
    const node = payload.data.user.clips.edges[0].node;
    delete node.slug;
    node.url = url;
    assert.equal(extractClipPage(payload).clips.length, 0);
  }
});

test("returns empty results for incomplete GraphQL responses", () => {
  assert.equal(JSON.stringify(extractClipPage({ errors: [{ message: "failed" }] })), JSON.stringify({ clips: [], hasNextPage: false }));
  assert.equal(chooseQuality({ qualities: [] }), null);
});

test("builds a relative Chrome-safe filename", () => {
  const [clip] = extractClipPage(clipPayload()).clips;
  const filename = buildFilename(clip, "portrait");
  assert.equal(filename, "Twitch Clips/channelname/20260728 101235 - ChannelName - A clip- with - invalid - characters - 29s - Game is Just Chatting - Guests are Guest One, guesttwo - 12345 views - portrait [ClipSlug].mp4");
  assert.equal(/[<>:"\\|?*]/.test(filename.replace("Twitch Clips/channelname/", "")), false);
});

test("omits optional filename metadata when GraphQL does not expose it", () => {
  const payload = clipPayload();
  const node = payload.data.user.clips.edges[0].node;
  delete node.createdAt;
  delete node.durationSeconds;
  delete node.game;
  delete node.guestStarParticipants;
  delete node.viewCount;
  const [clip] = extractClipPage(payload).clips;
  assert.equal(buildFilename(clip), "Twitch Clips/channelname/ChannelName - A clip- with - invalid - characters [ClipSlug].mp4");
});

test("omits the view count when GraphQL does not expose it", () => {
  const payload = clipPayload();
  delete payload.data.user.clips.edges[0].node.viewCount;
  const [clip] = extractClipPage(payload).clips;
  assert.equal(buildFilename(clip), "Twitch Clips/channelname/20260728 101235 - ChannelName - A clip- with - invalid - characters - 29s - Game is Just Chatting - Guests are Guest One, guesttwo [ClipSlug].mp4");
});

test("omits an invalid GraphQL view count", () => {
  const payload = clipPayload();
  payload.data.user.clips.edges[0].node.viewCount = -1;
  const [clip] = extractClipPage(payload).clips;
  assert.equal(clip.viewCount, null);
  assert.equal(buildFilename(clip), "Twitch Clips/channelname/20260728 101235 - ChannelName - A clip- with - invalid - characters - 29s - Game is Just Chatting - Guests are Guest One, guesttwo [ClipSlug].mp4");
});

test("does not truncate filename metadata", () => {
  const payload = clipPayload();
  const node = payload.data.user.clips.edges[0].node;
  node.title = "T".repeat(150);
  node.guestStarParticipants.guests = Array.from({ length: 25 }, (_, index) => ({ displayName: `Guest ${index}` }));
  const [clip] = extractClipPage(payload).clips;
  const filename = buildFilename(clip);
  assert.equal(clip.guests.length, 25);
  assert.equal(filename.includes(node.title), true);
  assert.equal(filename.includes(clip.guests.join(", ")), true);
});
