# Pi Browser Connect

Connect [Pi](https://pi.dev) to **one explicitly shared tab in your everyday browser**, with your existing login. No cookie copying, cloud relay, or remote-debugging port.

[npm](https://www.npmjs.com/package/@kvidzibo/pi-browser-connect) · [Pi package catalog](https://pi.dev/packages)

## Requirements

Linux, Node **22.19+**, Pi **1.5.2+**, and desktop Chrome/Chromium **125+**. Not Firefox, Windows, macOS, incognito, or sandbox-packaged browsers (Snap/Flatpak).

## Install

```bash
npm install --global @kvidzibo/pi-browser-connect
pi install "$(npm root -g)/@kvidzibo/pi-browser-connect"
pi-browser-connect path
```

1. Open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** the `browser-extension` directory printed above.
2. Register the native host for your browser:

   ```bash
   pi-browser-connect setup chromium lmiednaanfkhmeldhmbgimndmmilcibe
   # Use "chrome" instead of "chromium" for Google Chrome.
   ```

3. In Pi, run `/reload`.
4. Click **Pi Browser Connect** in your browser toolbar (or **Ctrl+Shift+Y**) and **Start local bridge**.
5. In Pi, run `/browser-connect connect`.
6. On the tab you want to share, reopen the browser popup, **Refresh**, compare the pairing code, and click **Share this tab with Pi**.

Only the browser popup can grant access. Installation never enables sharing automatically.

This package is not a Chrome Web Store listing. After an update, reload the browser extension and Pi; rerun setup if Node or the package moves.

### Install from source

Keep the checkout at a stable path: the native launcher points to it.

```bash
git clone https://github.com/kvidzibo/pi-browser-connect.git
cd pi-browser-connect
npm ci --ignore-scripts
pi install "$PWD"
node native-host/install.mjs path
```

Follow the browser setup and sharing steps above, using `node native-host/install.mjs setup` instead of `pi-browser-connect setup`.

## Use

Ask Pi, for example:

> Use browser_connect to inspect the tab I shared. Summarize it without changing anything.

The `browser_connect` tool supports `tabs`, `snapshot`, `click`, `type`, `press`, `scroll`, `navigate`, and `screenshot`. Typing **replaces** an input's text. Clicks, typing, keypresses, and navigation require Pi's native confirmation dialog. Noninteractive mutations fail closed.

- `/browser-connect status` — bridge connection status and pairing code.
- `/browser-connect disconnect` — revoke access.
- Browser popup **Disconnect** — revoke immediately, including pending actions.

Closing the shared tab, leaving its origin, detaching debugging, closing Pi, switching sessions/branches, or `/reload` revokes sharing. There is no automatic reconnection. A cancelled or timed-out action may already have run; never blindly retry it.

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

Integration uses a temporary HOME/profile, synthetic local pages, the real native host, and Pi's loader—never your normal browser or a model request. Set `BROWSER_CONNECT_CHROMIUM=/usr/bin/chromium` to use a system browser. Screenshots can be saved under `/tmp/` with `BROWSER_CONNECT_SCREENSHOTS=/tmp/browser-connect-captures`.

[Architecture and troubleshooting](docs/architecture.md) · [Publishing](docs/publishing.md) · [MIT](LICENSE)
