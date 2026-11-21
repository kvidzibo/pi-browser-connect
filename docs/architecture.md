# Architecture

```text
Pi tool → private Unix socket → native host → Native Messaging → browser worker → shared tab
```

- `index.ts`: Pi command, native approval menus, bounded tool output, lifecycle revocation.
- `native-host/`: dependency-free Node host, client, framed protocol, explicit installer.
- `browser-extension/`: Manifest V3 popup, in-memory grant, fixed CDP actions and isolated-world DOM snapshots.

There is one browser host per connected extension instance, one Pi socket owner, and one shared tab. Other profiles/instances must disconnect before connecting Pi. A second session cannot replace the owner. Native messages are versioned at handshake and bound to session/request IDs; there are no browser-action retries or raw CDP tools. The `evaluate` action accepts explicitly approved JavaScript.

Opening the browser popup starts the native host on demand; it never grants tab access. The popup polls status while open, so pairing does not require a manual refresh. A failed transport is retried only by reopening the popup or clicking Retry bridge. No systemd service or TCP listener is installed. The extension's native port keeps its worker active; worker/host restart loses grants. Disconnect invalidates the grant synchronously before asynchronous debugger detachment.

Read-only `inspect` evaluates fixed code in the same isolated world, accepts only a bounded simple CSS selector (no attribute selectors, pseudo-classes, or escapes that could probe excluded fields), and returns sanitized opening tags, classes and allowlisted computed styles for up to ten matches and five ancestors each. It never accepts JavaScript or raw CDP commands, serializes no text or arbitrary HTML attributes, and leaves snapshot references intact. Grant and document-loader checks apply before/after inspection.

Snapshots store node references in a CDP isolated world. Navigation, document replacement, DOM mutation, and actions invalidate references. Each request rechecks the grant and document where applicable. Each isolated world receives a random token while its document is verified; injected code and scripts refuse to run without it, because numeric context IDs can repeat in another renderer process. These checks reduce stale actions; they cannot make a live browser atomic against concurrent user/page changes. Do not manually edit the tab while Pi is acting.

The grant is bound to the tab and session, not to an origin. `navigate` accepts any credential-free HTTP(S) URL; links, scripts, and the user may also move the tab across sites. The main frame must show an HTTP(S) or `about:blank` document: any other committed URL revokes the grant, and Chromium detaches debugging itself on internal pages. Failed loads keep the grant but reject page actions until the next navigation. Without the `tabs` permission, `activeTab` stops exposing the tab URL once it leaves the origin it was shared on, so the worker reads URLs and titles through CDP. New-tab and internal pages hide their URL and refuse debugging; sharing one first loads `about:blank` in it. Chromium resets tab-specific toolbar state on navigation, so the worker repaints the shared indicator after each main-frame navigation and load.

Sharing enables `Emulation.setFocusEmulationEnabled` for the tab. Chromium otherwise marks a covered, other-workspace, or background tab hidden: timers throttle to one second, `requestAnimationFrame` stops, and CDP key events are dropped. Actions use DOM calls and CDP key dispatch only; CDP mouse events are avoided because they activate the browser window.

Sharing also enables the CDP `DOM` and `Overlay` domains. Before `click`, `type`, and `press`, the worker resolves the referenced element in the snapshot world and highlights it with `Overlay.highlightNode`; after a successful action it waits 400 ms, then hides the highlight. A failed action hides it at once. The overlay is browser-drawn and follows the element as it scrolls: nothing is added to the DOM, so mutation tracking, references, snapshots, and page scripts are unaffected. Requests are serialized, so a screenshot never captures it. Highlighting is best-effort: if the overlay is unavailable or the element cannot be resolved, the action runs unhighlighted with its usual checks.

Action approval is held only in the Pi extension's memory. The native selector defaults to Deny and offers one-action or session approval. Disconnect, a new connection, session shutdown/tree navigation, and reload reset it. Approval is recorded only after cancellation and connection-identity checks; automatic approval still requires an interactive UI and valid references. Browser-side grants and policy checks remain independent.

`evaluate` shares the same one-action/session Pi approval as other mutations. Session approval granted from any mutation covers scripts too; the approval menu warns about their sensitive-data and signed-in-request authority. Interactive UI and connection checks still apply, and disconnect/session changes/reload reset approval. It executes at most 4,000 characters of synchronous JavaScript in a fresh isolated main-document world, separate from snapshot/action globals. JSON-text results are capped at 12,000 characters inside the browser; CDP bounds synchronous execution to five seconds. Promises are not awaited. Grant and document-loader checks surround execution; results from changed documents are discarded. References are consumed before dispatch, including on failure. Isolation separates JavaScript globals, not DOM data or network authority: approved scripts can read sensitive fields, send authenticated requests, or schedule effects that survive completion/revocation. No script sandbox or rollback is claimed.

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
