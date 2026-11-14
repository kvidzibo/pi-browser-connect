# Publishing

This follows the existing kvidzibo Pi packages: versioned npm publication from `main`, GitHub OIDC trusted publishing, no long-lived npm token.

## Bootstrap status

Version `0.1.0` is published on npm. Trusted-publisher verification is pending: `0.1.1` is the first planned GitHub Actions publication with provenance.

## One-time bootstrap

The package must first exist on npm. From the reviewed release checkout:

```bash
npm ci --ignore-scripts
npm run typecheck
npm test
xvfb-run -a dbus-run-session -- npm run test:integration
npm login
npm publish --access public
```

Complete npm's interactive authentication/2FA yourself. Never put credentials in the repository, workflow, or agent prompt.

On npm, open this package's **Settings → Trusted Publisher** and configure:

- Provider: GitHub Actions
- Owner: `kvidzibo`
- Repository: `pi-browser-connect`
- Workflow: `publish.yml`
- Environment: none

Do not mark bootstrap complete until a workflow has actually published a subsequent version with provenance. Local authentication and registry-side trusted-publisher settings cannot be established by merely adding YAML.

## Subsequent releases

1. Version only affected components; update `CHANGELOG.md`:
   - Bump `package.json` and its matching `package-lock.json` metadata for npm package changes, following semver.
   - Bump `browser-extension/manifest.json` only when browser-extension code, assets, permissions, or behavior changes. Pi-only or native-host-only changes leave its version unchanged.
   - Browser-extension changes also require an npm package bump because the package includes the extension. The two component versions need not match.
2. Validate and review the PR; merge it manually.
3. The publish workflow runs the reusable test workflow, publishes a missing npm version with provenance, and creates a GitHub release with an unpacked browser-extension ZIP.

Only an npm `E404` permits a new publication; auth/network errors fail the workflow. Existing npm versions are never overwritten. Use stable semver for the npm package and Chrome-compatible numeric versions for the browser manifest.

GitHub release tags and ZIP filenames use the npm package version; the bundled browser manifest retains its independent version.

The ZIP is for **Load unpacked** after extraction, not automatic Chrome Web Store distribution. Browser-store publishing would need a separate developer account and explicit approval.

After the first workflow publication, verify the publish job succeeded and the npm version has `dist.attestations` before marking bootstrap complete.
