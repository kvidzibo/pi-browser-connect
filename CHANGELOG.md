# Changelog

## 0.8.0

Add **Share in a separate window** to the browser popup. It moves the shared tab to its own window without a tab strip or toolbar, so links opened from other apps no longer land in—or raise—the window Pi is working in. Disconnect from the popup in any other window, or close the separate window. Reload the browser extension. Browser extension version: 0.7.0.

## 0.7.0

Show what Pi is doing: the element Pi clicks, types into, or sends a key to is highlighted in the shared tab for about 0.4 seconds. The highlight is drawn by the browser's debugging overlay, not added to the page, so pages cannot see it and it never appears in Pi's snapshots or screenshots. Each highlighted action takes about 0.4 seconds longer. Reload the browser extension and share the tab again. Browser extension version: 0.6.0.

## 0.6.0

Sharing now follows the tab instead of one origin: Pi can navigate the shared tab to any HTTP(S) site and follow cross-site links, under the same per-action or session approval. New and blank tabs can be shared. The shared tab works without focus—in an unfocused or covered window, on another workspace, or as a background tab—through Chromium focus emulation. Failed navigations are reported, and the green indicator survives navigation. Internal browser pages still end sharing. Browser extension version: 0.5.0.

## 0.5.1

Limit the shared indicator to the tab that was shared. Other tabs and browser windows keep the red icon and not-sharing tooltip; their popups no longer say that tab is shared. Chrome’s debugging bar still appears in every window. Browser extension version: 0.4.1.

## 0.5.0

Add `evaluate` for synchronous JavaScript and DOM/CSS changes in the shared main document. Allow one-call approval or session-wide approval shared with other browser mutations, with an explicit script-risk warning. Bound results, invalidate references, and document sensitive-data/network access and non-rollback limitations. Browser extension version: 0.4.0.

## 0.4.0

Add read-only CSS-selector inspection: sanitized opening HTML tags, classes, fixed computed styles and ancestor styles for tracing image blur and layout. Preserve shared-tab safeguards and snapshot references; arbitrary JavaScript remains unsupported. Browser extension version: 0.3.0.

## 0.3.0

Add **Approve all for this session** to the native action approval menu, alongside **Approve once** and **Deny**. Approval resets on disconnect, session/branch change, or reload; browser sharing and safety restrictions remain unchanged. Version affected components independently; this Pi-only change leaves the browser extension at 0.2.2.

## 0.2.2

Make the toolbar artwork larger and bolder, with a red dot when no tab is shared and a green dot while sharing. Reset the indicator after disconnection or worker restart; replace the old ON badge.

## 0.2.1

Enlarge the browser-window artwork by 35% within Chromium's fixed icon slot, reducing padding and improving toolbar legibility.

## 0.2.0

Guided `/browser-connect` setup registers the browser bridge from Pi and shows the extension folder. Install directly with `pi install npm:@kvidzibo/pi-browser-connect`; no global npm install or extension ID is needed. The browser popup starts the bridge and updates pairing automatically. Loading the unpacked extension and sharing a tab still require your approval.

## 0.1.2

Add the Pi browser-window icon to the browser toolbar and extension manager.

## 0.1.1

Document the published npm installation and prepare the first trusted-publisher release. Browser and Pi behavior are unchanged.

## 0.1.0

Initial Linux/Chromium release: explicit single-tab sharing, native messaging bridge, Pi browser tools with action approvals, isolated integration tests, and GitHub/npm release automation.
