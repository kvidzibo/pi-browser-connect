# Architecture

```text
Pi tool → private Unix socket → native host → Native Messaging → browser worker → shared tab
```

- `index.ts`: Pi command, native confirmation dialogs, bounded tool output, lifecycle revocation.
- `native-host/`: dependency-free Node host, client, framed protocol, explicit installer.
- `browser-extension/`: Manifest V3 popup, in-memory grant, fixed CDP actions and isolated-world DOM snapshots.

There is one browser host per connected extension instance, one Pi socket owner, and one shared tab. Other profiles/instances must disconnect before connecting Pi. A second session cannot replace the owner. Native messages are versioned at handshake and bound to session/request IDs; there are no browser-action retries or raw JavaScript/CDP tools.

Opening the browser popup starts the native host on demand; it never grants tab access. The popup polls status while open, so pairing does not require a manual refresh. A failed transport is retried only by reopening the popup or clicking Retry bridge. No systemd service or TCP listener is installed. The extension's native port keeps its worker active; worker/host restart loses grants. Disconnect invalidates the grant synchronously before asynchronous debugger detachment.

Read-only `inspect` evaluates fixed code in the same isolated world, accepts only a bounded CSS selector, and returns sanitized opening tags, classes and allowlisted computed styles for up to ten matches and five ancestors each. It never accepts JavaScript or raw CDP commands, serializes no text or arbitrary HTML attributes, and leaves snapshot references intact. Grant/origin and document-loader checks apply before/after inspection.

Snapshots store node references in a CDP isolated world. Navigation, document replacement, DOM mutation, and actions invalidate references. Each request rechecks the grant, origin, and document where applicable. These checks reduce stale actions; they cannot make a live browser atomic against concurrent user/page changes. Do not manually edit the tab while Pi is acting.

## Local files

`/browser-connect` attempts connection first. If no host is running, Pi's native selector offers browser registration or waiting for an already-registered popup. Choosing a browser explicitly authorizes setup; cancellation writes nothing. Pi then waits up to two minutes for a host. Only host discovery is retried, never handshakes or browser actions. Disconnect, session changes, and reload cancel pending discovery and setup prompts.

Guided setup, `/browser-connect setup chromium|chrome`, and the standalone `setup` CLI reuse the same installer. The extension ID is derived from the bundled manifest's public key; the CLI also accepts an explicit ID for manual installations. Setup writes:

- `~/.local/share/pi-browser-connect/host`: package-managed launcher with absolute Node/package paths.
- `~/.config/chromium/NativeMessagingHosts/com.kvidzibo.pi_browser_connect.json`, or the equivalent `google-chrome` directory.

Native host origins are restricted to the exact extension ID. The manifest's public key keeps that ID stable across source/npm installations; no private signing key is included.

Sockets use `$XDG_RUNTIME_DIR/pi-browser-connect-<uid>`, falling back to `/tmp/pi-browser-connect-<uid>`. The directory must be owned by the user with mode 0700; sockets are 0600. `PI_BROWSER_CONNECT_DIR` overrides the directory for isolated tests and must match in Pi and Chromium. No browsing history or credentials are stored by the bridge.

## Troubleshooting

- **Host not found:** rerun setup for the right browser; load the unpacked extension from the package directory. A copied browser-extension folder alone does not install the native host.
- **No live browser host:** open the browser popup, then run `/browser-connect`. If Chromium reports an error, run `/browser-connect setup chromium` (or `setup chrome`) and reopen the popup or click Retry bridge.
- **Multiple hosts:** close other browser profiles using this extension. The client does not guess which profile you meant.
- **Share disabled:** reopen the toolbar popup on a fully loaded HTTP(S) tab. Opening popup.html directly does not grant `activeTab`.
- **Cannot attach / detached:** close DevTools or competing debugger extensions and share again.
- **Stale snapshot:** take another snapshot; do not reuse references. Highly dynamic pages may be unsuitable for this MVP.
- **Moved installation:** rerun setup; do not remove the package while its host is in use.

To remove, disconnect in Pi and the popup, remove the browser extension and Pi package entry, then remove only the two package-managed setup files listed above. Existing browser tabs and login data are not deleted.
