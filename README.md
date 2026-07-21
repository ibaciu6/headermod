# HeaderMod

A Chrome and Firefox extension that modifies HTTP request and response headers per profile. A clean Manifest V3 rebuild of the header-modifier workflow, built on the `declarativeNetRequest` API.

**[Privacy Policy](https://ibaciu6.github.io/headermod/privacy-policy.html)**

> Store listing links (Chrome Web Store / Firefox Add-ons) will be added here once the listings are approved.

## Features

- Multiple named profiles of request/response header rules
- Per-rule enable/disable
- URL filters (regex) and resource-type filters
- Tab lock — apply a profile only to the active tab
- Pause / resume all rules without deleting them
- Cloud backup — timestamped profile snapshots via `chrome.storage.sync`
- Import / export profiles as JSON

## Folder structure

```
chrome/    MV3 source for the Chrome Web Store (declarativeNetRequest, service worker)
firefox/   MV3 source for Firefox Add-ons / AMO (declarativeNetRequest, background scripts + gecko settings)
docs/      GitHub Pages site (landing page, privacy policy)
```

The only file that differs between platforms is `manifest.json`:

- **Chrome** uses `background.service_worker`.
- **Firefox** uses `background.scripts` (Firefox has no extension service worker) and adds `browser_specific_settings.gecko` (extension id `headermod@ibaciu6`, `strict_min_version` 128.0 — the baseline for `declarativeNetRequest` session rules and `modifyHeaders`).

All other runtime files (`background.js`, popup, scripts, styles, images) are identical between the two.

## Build the store packages

```bash
cd chrome  && zip -r -X ../dist/headermod-1.0.0-chrome.zip  . -x '.*'
cd firefox && zip -r -X ../dist/headermod-1.0.0-firefox.zip . -x '.*'
```

## Load unpacked for testing

- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked → select `chrome/`.
- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on → select `firefox/manifest.json`.

## Privacy

HeaderMod transmits no data to the developer or any third party. Profiles and settings are stored locally (and synced across your own browser profile via `chrome.storage.sync` if browser sync is enabled). See the [Privacy Policy](https://ibaciu6.github.io/headermod/privacy-policy.html).

## License

MIT
