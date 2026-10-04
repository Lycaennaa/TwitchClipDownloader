# Privacy

This notice describes the Twitch Clip Bulk Downloader implementation in this repository. Twitch’s own privacy practices are governed by Twitch, not by this extension.

## What the extension processes

On the Twitch Creator Dashboard’s Clips Created page, a page-context hook observes the dashboard’s existing clip-data request. When you scan, it can replay that request using the dashboard’s current filters and signed-in Twitch session. The extension normalizes clip metadata such as the clip slug, title, creator, creation time, duration, game, guests, view count, and available video variants. It does not keep a copy of the complete GraphQL response.

Some Twitch media URLs require a playback signature and token in their query parameters. The extension uses those values to download the selected clip. They are not stored as a separate raw GraphQL token object, but an authorized media URL may contain them.

## Local storage and files

- The current download queue is kept in `chrome.storage.local` so queue state can survive service-worker restarts. Queue entries include clip identifiers, output filenames, status, and media source URLs; those URLs may include Twitch playback signature/token parameters. The queue remains in extension storage until a later queue replaces it or extension data is cleared. There is no separate **Clear queue** button.
- The selected output-folder handle is kept in the extension’s IndexedDB database. The extension uses the folder only after you select it and grant read/write permission.
- Completed MP4 files are written to that selected local folder, in per-creator subfolders. Filenames can include clip titles, creator names, dates, and other clip metadata. The extension does not delete completed files when you remove it.
- The optional stream diagnostic stores its submitted media URL, creator-directory name, and recovery state locally while it runs or cleanup is pending. It may write a temporary file in the selected folder; the extension attempts to remove that file during cleanup.

This data remains in your browser profile or selected folder; it is not sent to the project maintainer. Local browser-profile backups or access by other software on your device are outside the extension’s control.

## Network requests

- Clip data is read from Twitch’s dashboard GraphQL request. A scan may replay the dashboard request to Twitch using its existing page request context.
- Video files are fetched from HTTPS Twitch/Twitch CDN hosts or the single CloudFront host allowed by the extension. Media fetches omit browser cookies and reject redirects; authorized media URLs may carry the required query parameters.
- The extension source contains no publisher-operated backend, analytics, advertising, or telemetry service. It does not upload your queue or downloaded files to the project maintainer.

Twitch and its media delivery providers receive the requests needed to load clip data and download selected videos under their own service policies.

## Removing local data

Cancel any active queue and wait for cleanup before clearing extension data. To remove the saved queue and folder handle, remove the extension or clear its data using your browser’s extension controls. This does not remove MP4 files already written to your selected folder; delete those files yourself if desired. Media URLs in the saved queue may remain there until the queue is replaced or extension data is cleared.