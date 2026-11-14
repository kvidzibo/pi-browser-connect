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
5. Compare the pairing code with Pi and click **Share this tab with Pi**.

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

The `browser_connect` tool supports `tabs`, `snapshot`, `click`, `type`, `press`, `scroll`, `navigate`, and `screenshot`. Typing **replaces** an input's text. Clicks, typing, keypresses, and navigation require Pi's native confirmation dialog. Noninteractive mutations fail closed.

- `/browser-connect` (or `/browser-connect connect`) — connect, with guided setup when no bridge is running.
- `/browser-connect setup chromium` (or `setup chrome`) — register/repair the bridge and show the extension folder without connecting.
- `/browser-connect status` — bridge connection status and pairing code.
- `/browser-connect disconnect` — revoke access.
- Browser popup **Disconnect** — revoke immediately, including pending actions.

The toolbar icon shows a **red dot** when no tab is shared and a **green dot** while a tab is shared. A ready bridge or pending pairing alone stays red.

Closing the shared tab, leaving its origin, detaching debugging, closing Pi, switching sessions/branches, or `/reload` revokes sharing. There is no automatic Pi reconnection or tab sharing. Opening the popup starts only the local transport. A cancelled or timed-out action may already have run; never blindly retry it.

## Privacy and limitations

**This controls your real, signed-in browser. It is not a sandbox.** Shared page content and unredacted screenshots can reach your model provider and remain in Pi transcripts. Avoid sensitive pages.

The browser extension has a powerful `debugger` permission, but its code restricts requests to the shared tab and origin. The pairing code identifies the session; it is not a password. Private Unix socket permissions protect against other OS users, **not malicious code running as you**. Pi approval is enforced by the Pi tool, not a security boundary against other same-user programs.

Snapshots cover the main document only, not iframe or shadow-root controls, and omit input values. Password, file, OTP, and payment-autocomplete fields are excluded from reference-based actions; this is not complete secret detection. Screenshots remain unredacted. Clicks and text replacement use DOM events; applications requiring trusted pointer/input events may not accept them. Keyboard events use Chromium input dispatch.

Same-origin navigation is supported. Cross-origin links are rejected when detectable; script-driven navigation revokes access after the navigation event. This is **not a network firewall**: the page can load resources, submit requests, or open unshared tabs. Internal browser pages and `file:` URLs are unsupported.

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
