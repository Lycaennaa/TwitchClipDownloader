# Troubleshooting

## Downloader panel does not appear

- Confirm the page is the Twitch Creator Dashboard’s **Clips Created** page, under `dashboard.twitch.tv/u/.../content/clips/created`.
- Confirm the extension is enabled at `chrome://extensions` and loaded from the directory containing `manifest.json`.
- Reload the dashboard after enabling or updating the extension.

## Panel is waiting for clip data or shows an error

Wait for the dashboard to finish loading, then reload the page. The extension reads the dashboard’s clip-data request and depends on Twitch’s private, changeable interface. If Twitch changes that interface, scanning may stop until the extension is updated.

Check that the page is showing clips you can access and that the active dashboard filters include results. **Scan all** keeps those filters and requests at most 100 clips. For larger result sets, choose a narrower date range and repeat.

## Folder access is missing or downloads fail

Open **Folder access** from the downloader panel, choose an output folder, and grant read/write access. The extension creates creator subfolders as needed. If access was revoked, select the folder again. If a previous download needs cleanup, reselect its original folder and let cleanup finish before switching folders.

Folder-based downloads require a browser that exposes the File System Access API to extension pages; the extension currently directs users to Chrome when that API is unavailable.

## A clip is skipped or fails to download

- A clip is skipped when a file for the same clip slug already exists in that creator’s folder.
- If the selected quality or orientation is unavailable, the extension chooses another available media variant. Try another quality/orientation if the result is not suitable.
- Twitch media URLs can expire or change. Reload the dashboard, scan again, and retry the failed clips.
- Verify the selected folder is writable and has enough free space.

## Reporting a problem

Include the browser version, the dashboard step that failed, and the visible error text. Do not share cookies, Twitch request bodies, signed media URLs, browser-profile files, or other account data.