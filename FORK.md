# Pi provider fork

This fork adds [Pi](https://github.com/badlogic/pi-mono) as an external agent provider while retaining T3's projects, threads, terminals, Git, worktrees, and remote clients. Pi is not bundled or installed by T3.

## Run it

Install and configure Pi on the **machine running the T3 server**, then verify that `pi` works there. T3 launches `pi --mode rpc` in the thread's project or worktree directory. Set a different executable path in Settings → Providers → Pi when necessary. Use an absolute path on remote machines whose service environment does not include Pi in `PATH`.

Pi configuration, authentication, extensions, skills, tools, and system prompts remain Pi's responsibility. T3 does not read or rewrite Pi configuration, add a system prompt, or restrict its tools. Existing provider-instance environment overrides are passed to the process; they are not interpreted as Pi configuration.

For an explicitly configured instance, the server's existing `providerInstances` setting accepts:

```json
{
  "providerInstances": {
    "pi": {
      "driver": "pi",
      "enabled": true,
      "config": { "binaryPath": "pi" }
    }
  }
}
```

“Pi default” uses the model Pi reported before T3's first override. Switching back from an explicit model restores that choice; T3 retains it in the opaque resume cursor across server restarts. Older cursors without that baseline adopt the model reported on their next resume. If Pi reports no initial model, a later attempt to restore default fails rather than running the explicit model under a misleading label. Explicit choices use `provider/modelId`, discovered through RPC. Pi's reasoning levels appear as the normal model trait picker, listing exactly the levels Pi reports for the selected model; a model that cannot reason shows no picker. T3 validates a level against Pi's own report before prompting, so a stale choice from another model fails the turn instead of being silently clamped. Leaving the picker untouched leaves Pi's configured level alone.

Pi advertises the generic `managesRuntimePermissions` snapshot capability. Clients show no runtime-mode control for such a provider rather than offering T3 permission modes that are not enforced; permission and tool behavior come from the external runtime. Older snapshots without this capability retain the normal T3 selector.

## Boundaries and intentional differences

- Each active T3 thread owns a server-side RPC subprocess, independent of browser connections. T3's normal session lifecycle still applies; closing the server stops its processes.
- Resume uses the session path returned by Pi and `--session`. T3 checks that the path exists rather than allowing Pi to silently create replacement history. Keep the session files on the same environment. T3 never edits them.
- **Conversation rewind and tree navigation are unavailable.** Pi RPC does not expose the SDK's in-place `navigateTree()` operation. This fork does not emulate it by editing session files or creating replacement branches. T3's Git/diff/worktree features remain separate.
- Streaming text, reasoning, tool activity, images, interrupt, steering, native compaction, and RPC extension input dialogs are translated into existing T3 events and controls. A turn completes on `agent_settled`, not `agent_end`, so retries and follow-up work are not prematurely marked finished.
- Pi's custom terminal UI components and terminal-rendering extensions cannot appear in T3. RPC dialogs use T3's existing input UI; this is not a renderer for Pi's custom terminal UI.
- T3 auxiliary text generation (such as titles and Git text) uses separate ordinary Pi sessions and T3's existing task prompts. These sessions use the configured runtime behavior too; interactive requests fail instead of granting consent. They are not tool-restricted or side-effect-free: configured extension startup hooks and tools can run, and Pi may persist their session history. Choose a different T3 auxiliary-generation provider if that behavior is unsuitable.
- Existing Pi conversations are not imported. T3 records the events of conversations it starts; Pi retains its own native history.

## Verification

The focused Pi and provider-regression suite passes 191 tests across 14 files, on both `pi-provider` and the upstream review branch described below. Server, web, mobile, contracts, and client-runtime typechecks pass on both branches. Local Chromium checks exercised provider discovery, enable/disable, model selection, the composer permission surfaces, and a real Pi turn in a T3-created worktree with a resulting Git diff. An active FIFO-gated tool call survived a full browser disconnect; after restarting the server, Pi resumed and recalled the prior result without tools.

Browser layout was checked at 375, 768, and 1280 pixels. Native Electron/React Native clients and relay/tunnel deployments have not been exercised. No deployment was performed.

## Compatibility and maintenance

Development targets the installed Pi **0.85.1** RPC protocol, including `agent_settled`. Older versions that lack that event are not supported. Protocol and fixture tests live beside `apps/server/src/provider/pi/`; live runtime discovery and client verification are separate checks, not a substitute for those tests.

The integration uses T3's open provider-driver SPI. Pi-specific server code lives in `provider/pi/` and `provider/Drivers/PiDriver.ts`; connection settings live in `packages/contracts/src/pi.ts`. Upstream conflict points are driver registration/bootstrap, the optional permission capability in the provider snapshot, client provider metadata/model defaults, and the small generic permission presentation hooks in the web/mobile composers. No Pi dependency is added to T3.

Upstream proposals considered include [#402](https://github.com/pingdotgg/t3code/issues/402), [#7211](https://github.com/pingdotgg/t3code/pull/7211), and [#10474](https://github.com/pingdotgg/t3code/pull/10474). This implementation deliberately keeps the external RPC boundary and defers tree navigation rather than replacing Pi startup with an SDK host.

As a maintainability check, upstream `08463e2c4` was merged into the separate local `pi-provider-upstream-review` branch. There were no textual conflicts, including in `ChatComposer.tsx` and `ThreadSettingsSheet.tsx`. Inspection confirmed that upstream's composer-loading and Material You changes coexist with the generic permission hooks. Upstream `main` (`b1e223e2b`) is merged into `pi-provider`; that merge was also conflict-free, and the focused suite plus the affected package typechecks pass on the result.

The fork branch is `pi-provider`; `upstream` points to `pingdotgg/t3code` and `origin` to `brunosag/t3code`. To update, fetch upstream, merge the desired upstream revision into a review branch, resolve the narrow integration points above, and rerun focused Pi tests plus server/web/mobile typechecks and local client verification before updating `pi-provider`.

## Deployment

Pushing `pi-provider` deploys it. `.github/workflows/deploy-pi-vps.yml` runs the focused fork tests and the affected package typechecks, builds and packs the `t3` server package with the web client bundled, then installs it on the `tutor-prod` VPS through the stock service launcher over Tailscale. It needs the `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET` secrets (a Tailscale OAuth client with the `auth_keys` scope and `tag:ci`), the `VPS_DEPLOY_KEY` secret (private half of a restricted key in the host's `authorized_keys`), and the `VPS_HOST`/`VPS_USER` variables.

The version directory the launcher selects is the CLI version inlined at build time, so the workflow sets `0.0.41-pi.<short-sha>` before building: one patch above the release package, the same core the fork's desktop builds carry. That keeps a fork client from reading the server as older than itself, which would make it offer an npm self-update the fork can never honor. The previous version stays installed and the launcher rolls back when a new version fails to start; host details, pairing commands, and the explicit rollback recipe are in `~/local/t3-pi/DEPLOYMENT.md` on that machine.
