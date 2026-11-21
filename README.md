# Pi Browser Connect

Connect [Pi](https://pi.dev) to **one explicitly shared tab in your everyday browser**, with your existing login. No cookie copying, cloud relay, or remote-debugging port.

[npm](https://www.npmjs.com/package/@kvidzibo/pi-browser-connect) · [Pi package catalog](https://pi.dev/packages)

## Requirements

Linux, Node **22.19+**, Pi **1.5.2+**, and desktop Chrome/Chromium **125+**. Not Firefox, Windows, macOS, incognito, or sandbox-packaged browsers (Snap/Flatpak).

## Install

```bash
pi install npm:@kvidzibo/pi-browser-connect
```

1. In Pi, run `/reload`, then `/browser-connect`.
2. Choose **Chromium** or **Google Chrome**. Pi registers the local bridge and prints the browser-extension folder—no terminal setup command or extension ID needed.
3. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** that folder.
4. On the tab you want to share, click **Pi Browser Connect** in your browser toolbar (or **Ctrl+Shift+Y**). The bridge starts and the popup updates automatically.
5. Compare the pairing code with Pi and click **Share this tab with Pi**. A new or blank tab works too: sharing loads a blank page that Pi can navigate.

Pi waits up to two minutes for the popup. If setup takes longer, run `/browser-connect` again and choose **Already registered**. Once installed, open the popup, run `/browser-connect`, and share; no setup is needed again.

Only the browser popup can grant access. Installation never enables sharing automatically.

This package is not a Chrome Web Store listing: Chromium requires you to load the unpacked extension yourself. After an update, reload the browser extension and Pi. If Node or the package moves, run `/browser-connect setup chromium` (or `setup chrome`), then reload the extension from the current folder Pi prints.

### Install from source

Keep the checkout at a stable path: the native launcher points to it.

```bash
git clone https://github.com/kvidzibo/pi-browser-connect.git
cd pi-browser-connect
npm ci --ignore-scripts
pi install "$PWD"
```

Follow the guided setup above. The standalone CLI remains available for manual setup: `node native-host/install.mjs setup chromium` (or `chrome`); `node native-host/install.mjs path` prints the browser-extension folder.

## Use

Ask Pi, for example:

> Use browser_connect to inspect the tab I shared. Summarize it without changing anything.

The `browser_connect` tool supports `tabs`, `snapshot`, `inspect`, `click`, `type`, `press`, `scroll`, `navigate`, `screenshot`, and `evaluate`. Typing **replaces** an input's text. Clicks, typing, keypresses, navigation, and scripts open Pi's native approval menu: **Deny**, **Approve once**, or **Approve all for this session**. Session approval skips further action prompts until disconnect, session/branch change, or `/reload`; it is never saved. It does not grant tab access or bypass shared-tab or reference checks. Scripts can access sensitive DOM data; the element-level exclusions for inspection and reference-based actions do not sandbox scripts. Noninteractive mutations still fail closed.

For image blur or layout debugging, use `{"action":"inspect","selector":"img"}`. Inspection returns each match's CSS classes, sanitized opening HTML tag, fixed computed styles (including `filter` and `backdrop-filter`), and up to five ancestors. It is read-only, needs no action confirmation, and preserves existing snapshot references.

Selectors support tags, IDs, classes, lists, and basic combinators only; attribute selectors, pseudo-classes, and escapes are rejected to prevent probing excluded fields. Results cover at most ten matches in the main document; narrow the selector if truncated. HTML includes only bounded `id`, `class`, and `role` attributes—not full HTML, text, descendants, URLs, values, or event handlers. Forms and their descendants, form controls, editable regions, scripts, styles, and embedded documents are excluded. Computed styles use a fixed property list, capped at 200 characters each, with any URL-bearing style value omitted. Classes and IDs can still contain sensitive page data; this is not complete secret detection. These inspection restrictions do not apply to explicitly approved scripts.

### JavaScript and CSS changes

Use `evaluate` only when you explicitly want scripting. Choose **Approve once** for one script or **Approve all for this session** to allow scripts and other mutations without further prompts until disconnect, session/branch change, or `/reload`. Session approval granted by another mutation also covers scripts. Noninteractive calls still fail closed. The approval menu shows a bounded preview; inspect the full tool call before approving longer scripts.

For example, to remove a CSS blur overlay:

```json
{"action":"evaluate","expression":"(() => { document.querySelectorAll('.backdrop-blur-xl').forEach(el => el.style.backdropFilter = 'none'); return 'CSS blur removed'; })()"}
```

Scripts run synchronously in a fresh isolated JavaScript world in the shared main document: DOM APIs work, but the page's JavaScript variables are unavailable. Expressions are limited to 4,000 characters; use an IIFE for statements and return a JSON-serializable value. Results contain JSON text capped at 12,000 characters plus a truncation flag. Promises are not awaited; synchronous execution has a five-second CDP timeout. Take a fresh snapshot afterward, including after errors.

**Scripts are not sandboxed from the page's sensitive data or signed-in requests.** They bypass the element-level exclusions used by inspection and reference-based actions. Never request or return credentials, tokens, payment details, or other secrets. They can change the DOM, send requests, or schedule later work. Denial prevents dispatch, but failure, timeout, cancellation, or disconnect cannot undo changes or guarantee scheduled work stops. Do not automatically retry. Removing CSS cannot recover an image blurred on the server; local CSS changes normally disappear on reload.

### Navigation and background work

Sharing follows the tab, not a site. Pi can `navigate` the shared tab to any HTTP(S) URL and follow HTTP(S) links across sites; your own navigation in that tab keeps it shared too. Each `navigate` call asks for approval and shows the destination site, unless you chose **Approve all for this session**. Redirects, links, and page scripts can move the tab to another site without a separate prompt. Share a dedicated tab or window rather than one you are using.

The shared tab does not need focus. Put it in its own window and keep working elsewhere: Pi can navigate, read, click, type, press keys, and take screenshots while the window is unfocused, covered, on another workspace, or while the tab is in the background. The extension enables Chromium's focus emulation for the shared tab, so the page sees itself as visible and focused and its timers are not throttled. Pi's actions do not raise the window or take keyboard focus.

Tabs or windows opened by a page are not shared. A page dialog (`alert`, `confirm`, print) blocks the tab until you dismiss it. A minimized window is untested.

### Commands

- `/browser-connect` (or `/browser-connect connect`) — connect, with guided setup when no bridge is running.
- `/browser-connect setup chromium` (or `setup chrome`) — register/repair the bridge and show the extension folder without connecting.
- `/browser-connect status` — bridge connection status and pairing code.
- `/browser-connect disconnect` — revoke access.
- Browser popup **Disconnect** — revoke immediately, including pending actions.

The toolbar icon shows a **red dot** on every tab until you share one. Only the shared tab shows a **green dot** and the “Tab shared” tooltip; other tabs and windows stay red. A ready bridge or pending pairing alone stays red. Chrome also shows “started debugging this browser” on every window while a tab is shared. That bar belongs to the browser and cannot be limited to one tab or window.

Closing the shared tab, opening an internal browser page in it, detaching debugging, closing Pi, switching sessions/branches, or `/reload` revokes sharing. There is no automatic Pi reconnection or tab sharing. Opening the popup starts only the local transport. A cancelled or timed-out action may already have run; never blindly retry it.

## Privacy and limitations

**This controls your real, signed-in browser. It is not a sandbox.** Shared page content and unredacted screenshots can reach your model provider and remain in Pi transcripts. Avoid sensitive pages.

The browser extension has a powerful `debugger` permission, but its code restricts requests to the shared tab. The pairing code identifies the session; it is not a password. Private Unix socket permissions protect against other OS users, **not malicious code running as you**. Pi approval is enforced by the Pi tool, not a security boundary against other same-user programs.

Snapshots cover the main document only, not iframe or shadow-root controls, and omit input values. Password, file, OTP, and payment-autocomplete fields are excluded from reference-based actions; this is not complete secret detection. Screenshots remain unredacted. Clicks and text replacement use DOM events; applications requiring trusted pointer/input events may not accept them. Keyboard events use Chromium input dispatch.

**A shared tab is not limited to one site.** Pi, an approved script, or the page itself can take it to any website where you are signed in; with session approval, no further prompt appears. This is **not a network firewall**: the page can load resources, submit requests, or open unshared tabs. Internal browser pages and `file:` URLs are unsupported; opening one ends sharing. A new-tab or internal page can be shared only by replacing it with a blank page.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
npx playwright-core install --with-deps chromium
# Also install xvfb, dbus-x11, and xdotool with your system package manager.
xvfb-run -a dbus-run-session -- npm run test:integration
npm pack --dry-run
```

To regenerate the toolbar icons from `browser-extension/icons/icon.svg`, install `rsvg-convert` (Debian: `librsvg2-bin`) and run `node scripts/generate-icons.mjs`.

Integration uses a temporary HOME/profile, synthetic local pages, the real native host, and Pi's loader—never your normal browser or a model request. Set `BROWSER_CONNECT_CHROMIUM=/usr/bin/chromium` to use a system browser. Screenshots can be saved under `/tmp/` with `BROWSER_CONNECT_SCREENSHOTS=/tmp/browser-connect-captures`; toolbar captures also require ImageMagick's `import` command.

[Architecture and troubleshooting](docs/architecture.md) · [Publishing](docs/publishing.md) · [MIT](LICENSE)
