# Twitch Clip Bulk Downloader

Chrome extension for the Twitch Creator Dashboard’s **Clips Created** page (`dashboard.twitch.tv/u/.../content/clips/created`). It reads the clips shown by the dashboard and downloads their video files into a folder you choose.

## Requirements

- A current version of Google Chrome with Manifest V3 extension support and the File System Access API.
- A signed-in Twitch account with access to the Creator Dashboard’s Clips Created page.
- Read/write access to an output folder you select.

Other Chromium browsers may not expose the folder picker in extension pages without enabling file-system-access-api in chrome://flags. The extension reports an error if folder selection is unavailable.

## Install

1. Download and extract the project.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select the project directory containing `manifest.json`.
4. Open the Twitch **Clips Created** dashboard and reload the page.

## First-time setup

1. Open the downloader panel’s **Folder access** page.
2. Choose the folder where you want downloaded clips stored and grant read/write access.
3. Return to the dashboard and reload it if the panel is still waiting for clip data.

The extension creates a subfolder for each clip creator under the selected folder. The folder handle is stored locally by the extension so it can be reused. Re-select the folder if its permission is revoked.

## Download clips

1. Set the dashboard filters to the date range and clips you want.
2. Wait for the dashboard to load, then use **Scan all** if you want the full current filter result.
3. Choose video orientation and quality, then choose **Download all**.

The scan preserves the dashboard’s active filters and requests up to 100 clips. Twitch does not provide a reliable cursor for larger results, so narrow the date filter and repeat for additional ranges. When the requested orientation or quality is unavailable, the downloader uses an available media variant.

Downloads stream directly into the selected folder; they do not go through Chrome’s Downloads UI. Up to 10 files can transfer concurrently. Existing clips with the same Twitch clip slug in a creator folder are skipped.

The project has been tested against the live Twitch dashboard. Its data interface is not a public extension API and may change; if clip scanning stops working after a Twitch update, see [Troubleshooting](TROUBLESHOOTING.md).

## Permissions and privacy

The extension declares `storage`, `alarms`, and `downloads` permissions. These support the locally saved download queue and folder handle, background queue recovery, and compatibility with older Chrome-managed downloads. Host access is limited in the manifest to Twitch hosts, Twitch CDN hosts, and the listed CloudFront media host. The content scripts run only on the Clips Created dashboard page.

See [Privacy](PRIVACY.md) for details on what is processed, stored locally, and sent to Twitch and its media CDN.

## Development checks

Run the syntax checks and automated tests with:

```sh
npm run check
```