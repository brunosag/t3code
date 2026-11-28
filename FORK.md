# T3 Code fork

The user's fork of upstream T3 Code. Where this file and `AGENTS.md` differ, this file wins. Fork notes go here, not in `AGENTS.md`, which upstream edits almost daily.

## You may

- Land finished work on `bsag`, started from `origin/bsag` (never the stale local `main`), unless the user asked to review it first. Pushing `bsag` deploys (below). Don't ask first: run the fork check, push, watch the deploy and check the result live, then report.
- Skip upstream's process: Pull requests, Evals, Documentation, the bug-proof rule under Verifying (failing test first, before/after captures) and the ask-first browser rules don't apply.
- Write fork-only UI in English, without upstream's translation wrappers; `t3code/no-untranslated-copy` is a warning in the fork (`vite.config.ts`), so it doesn't block commits.
- Check user-visible changes on the deployed instance after the deploy (`~/local/t3-pi/DEPLOYMENT.md` on `vps` says how to reach it). A worktree dev server costs a ~4 GB install and a seeded database (the live one is past the 500 MiB auto-seed limit: `vp run migrate-dev-db`); start one only when a change can't be seen deployed or shipping it unseen could break the live instance.

## Limits

- Before pushing, run `scripts/fork-check.sh`, the deploy's own gate (`vp run check:changed origin/bsag` is optional: its default base is upstream's `main`, so it diffs the whole fork for over ten minutes).
- Surfaces are the server with its web client on `vps`, the Linux desktop build and the Android app; macOS, Windows, iOS and the relay only when asked.
- The Android app (`apps/mobile`) is the fork's own build, `com.bsag.t3code`, installed next to upstream's Play Store app. It can't use upstream's T3 Connect sign-in, relay pushes or OTA updates, so it gets notifications from the fork's server directly (below). Keep iOS-only code as upstream has it.
- Keep `packages/provider-pi` identical to upstream. Don't restore the removed V1 adapter or permission layer.
- The live installation is `~/local/t3-pi` on `vps`; preserve its `userdata` and keep development state separate. Back up its database before deploying a migration; reverting the executable is not a database rollback.
- `t3 service restart` on the host interrupts running agents; otherwise the server switches to a deployed version by itself once agents are idle.
- Enable `SERVER_RELEASES_PUBLISHED` (`apps/server/src/cloud/selfUpdate.ts`) only when matching release artifacts exist; fork server releases are not published.
- The npm-installed server loads `@ff-labs/fff-node` through an ESM import (upstream's single-executable path needs a patched CommonJS export the npm package lacks); changing that import means changing the installation layout too. npm skips pnpm patches, so the deploy applies the fff-node and `@cursor/sdk` patches to the host's copies (the search index calls fff-node's patched async methods) and fails when npm installed a version a patch wasn't written for; `scripts/fork-check.sh` fails when a version bump leaves the workflow naming a missing patch. node-pty's patch is Windows-only, and npm resolves its caret range past the pnpm pin.

## Deployment

A push to `bsag` runs `.github/workflows/deploy-fork-vps.yml`: it runs the fork check, builds the server with its web client, and installs the npm tarball on `vps` over Tailscale with `t3 service install --defer-restart`, which selects the version (`activeVersion` in `~/local/t3-pi/runtime/service-state.json`) without restarting. Watch the run (`gh run watch`); the deploy is live when `serverVersion` from `/.well-known/t3/environment` on the server's port ends in the pushed commit's 9-character SHA. `[skip ci]` in a docs-only commit message skips the deploy. Linux desktop builds publish fork prereleases through `.github/workflows/desktop-fork-linux.yml`. Android builds publish signed `android-<date>.<run>` prereleases through `.github/workflows/mobile-fork-android.yml` when a push touches the app or its packages; its signing key, Firebase files and build environment live in `~/.config/t3-fork-android` on the laptop (source `env.sh` and `signing.env`, then `expo prebuild --clean --platform android` and `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` with `APP_VARIANT=production`), and the same key is in the repository's `FORK_ANDROID_*` secrets. Host procedures are in `~/local/t3-pi/DEPLOYMENT.md`.

## Upstream merges

- Merge upstream into a review worktree and run `scripts/fork-check.sh` before updating `bsag`. In a conflict, take upstream's side unless it touches a retained change below.
- Before pushing a merge, check it for new migrations (`apps/server/src/persistence/Migrations/`) and, if there are any, back up the live database first: pushing deploys, and the server migrates as soon as agents go idle.
- Only the fork workflows (`deploy-fork-vps`, `desktop-fork-linux`, `mobile-fork-android`) run; every upstream workflow is disabled (`gh workflow disable -R brunosag/t3code <file>`), since their stuck runs once got the fork's Actions paused, which stopped deploys. After each merge, disable any newly arrived one.
- The desktop app stages only the server dependencies matched in `scripts/lib/cli-external-packages.ts`, never their peers. When a merge bumps one of those and a dependency becomes a peer, declare it in `apps/server/package.json`, or the AppImage backend crash-loops on a missing module and the app never opens.
- A new retained change gets a line below and a test in `scripts/fork-check.sh`, so a merge that breaks it fails.

## Retained changes

Keep each entry brief (behavioral invariant + tests); details live in the code and tests.

- **Claude thinking quotes:** no quoting on Claude thinking items; strips saved thinking citations while keeping user comments.
- **Question drafts:** written answers to agent questions survive reloads; choosing an option moves the answer into the thread draft.
- **Compaction:** snoozed threads, and settled threads that their own agent settled or an enabled `continue` schedule will resume, still get idle compaction (from 100K tokens) and keep their settled/snoozed state.
- **Schedules:** late/manual interval runs keep the previous grid; missed runs of every type run late once, including workflow schedule triggers (`Workflows.test.ts`); `schedule_task` updates take a `delegate_task`-style `target`, and the web editor sets options with the traits picker.
- **Fast Mode switch:** server can disable Fast Mode globally, including saved selections and delegated tasks.
- **Read aloud:** local Phonon 31M TTS (threaded WASM in a child Node process; legacy Kokoro voice IDs map to the default voice; sentences chunked past the first up to ~1 min to avoid audible cuts), optional Settings → Chat rewrite model via the voice-cleanup call (failures surface their reason instead of falling back to rule-based text), and 512 MiB LRU host cache in `caches/speech` for rewrites and audio. Web has a persistent player above the composer, hover-row button on a running turn's latest finished message, rebindable `readAloud.*` shortcuts, Media Session controls, and 10 s seek; hidden for guests. Android adds message-row read aloud, draggable timeline (`ReadAloudTimeline.android.tsx`), Settings → Voice, background/lock-screen/headset playback via a silent looping Expo Audio foreground player, and per-sentence native player lifecycle to stay within Android's audio-track limit; shared player logic lives in `packages/client-runtime`. Tests: `speechText.test.ts`, `SpeechSynthesis.test.ts`, `readAloudScript.test.ts`, `SpeechCache.test.ts`, `settings.test.ts`, `MessagesTimeline.logic.test.ts`, `keybindings.test.ts`, `readAloudController.test.ts`, `backgroundPlayback.test.ts`, `expoPlaybackAudio.test.ts`.
- **Context window on Android:** composer shows context-window fill percentage over a hairline (or token count when window size is unknown); tapping opens the in-thread usage card with the auto-compaction tick above account limits, even for providers without limits (`contextWindow.test.ts`).
- **Model picker on touch:** per-pointer-event check (`focusesModelPickerSearch`) keeps the on-screen keyboard closed on touch/pen, replacing upstream's `(pointer: coarse)` check.
- **Sharp sheets:** sheets and the sidebar provider update pill don't retain `will-change: transform` after sliding (prevents blurry text).
- **Theme editor:** role spotlight pauses while a color picker is open.
- **Project groups and defaults:** shared title names the group; provider-selected repos and `owner/repo` clone over SSH; Settings picks the base directory for new projects.
- **Background work:** Linux holds one sleep/lid inhibitor while agent work is unfinished (not PR watches), standing down upstream's `KeepAwake`; desktop tray stays (`DesktopApp.test.ts`).
- **Limits hub:** CLIProxyAPI cooldown failures without `reset after` fall back to the Limits hub; hubs can be renamed, providers/limits/accounts hidden and reordered, single-account rows shown, accounts pooled by plan size with burn/runway/charts, and readings persisted in `usage-limit-history.json` without an open client. Claude hub readings take the newer of traffic headers (`auth-files`) and hourly OAuth metadata (invalidated on redeem; 401/403 surface immediately; failed reads retain last good value up to 1 h and show stale after 10 min without entering history; unused 0% sessions blocked by weekly quota inherit the weekly reset). Users can toggle hub logins on/off (excluded from pools and routing when off), drag-reorder CLIProxyAPI routing priority, or enable "Route by earliest reset", and view/redeem banked resets by kind (presenting the newest reported Claude Code version). Android mirrors pooled views, charts, banked resets, and Hub accounts via shared logic in `packages/client-runtime`. Tests: `usageLimitControls.test.ts`, `usageLimits.test.ts`, `UsageLimitSources.test.ts`, `claudeResetCredits.test.ts`, `cliproxyApi.test.ts`.
- **Antigravity limits:** keeps reading Antigravity quotas (local + hub) from Google's internal APIs despite upstream removing them; retains `@napi-rs/keyring` as a server dependency (`antigravityUsageLimits.test.ts`, `AntigravityProvider.test.ts`, `cliproxyApi.test.ts`).
- **Shared provider settings:** syncs shared provider/hub settings, login profiles, model favorites, hidden models, and order across connected machines (5 s settle, local machine wins conflicts) while keeping paths, keys, setup modes, env vars, ACP Registry agents, onboarding, and single-machine hubs local (`sharedProviderSettings.test.ts`).
- **Spelling dictionary:** desktop context menu has "Add to Dictionary" on app pages (not previews) with Settings → Chat management on Linux/Windows.
- **Thread CLI extensions (used by Shin):** `t3 thread model|models|show|stop`, `t3 thread start --existing-worktree <path>`, and `t3 thread usage` via read-only `t3_usage_limits` (`cli/thread.test.ts`, `usage/UsageLimitsSummary.test.ts`).
- **Installed web app names & branding:** `manifest.webmanifest` uses `T3 Code (<environment label>)`; web/Linux desktop use black production icons and plain "T3 Code", keeping Electron runtime name "T3 Code Nightly" so keyring state doesn't move.
- **Deploys wait for idle agents:** `t3 service install --defer-restart` switches ~10 s after agent work ends (5 s settle) or after 24 h; reads only selected version from service state (`IdleRestart.test.ts`).
- **Agent memory on small hosts:** `T3CODE_AGENT_MEMORY_HIGH`, `_MAX`, `_SWAP_MAX` override agent-slice limits; `check:changed` serializes steps under 6 GB free.
- **Orphaned desktop backends & AppImage updates:** backend exits if desktop PID dies; relaunch helper waits for updating PID to exit before launching the new AppImage via `T3CODE_DESKTOP_LAUNCHER_PATH` (`ElectronUpdater.test.ts`); `--hidden` starts without showing the window (`DesktopWindow.test.ts`).
- **Automatic updates:** desktop downloads offered releases and installs once idle (5 s after `agent-work-running` clears or 24 h, plus 30 s input idle/locked screen; hidden stays hidden); server auto-updates providers once no active thread uses them (`DesktopUpdates.test.ts`, `ElectronUpdater.test.ts`, `ProviderAutoUpdate.test.ts`).
- **No swipe navigation:** horizontal wheel never switches threads; `HistorySwipeNavigation` is deleted so upstream merges touching it fail fast.
- **Installation and desktop fixes:** provider updates check npm ownership first; Linux desktop entries keep `--class`; dev supports `dev:desktop:lean`, explicit DevTools, and keeping desktop dev origins out of the embedded web client.
- **Server-sent Android pushes:** fork Android app registers via `server.registerMobilePushDevice` (`mobile-push-devices.json`, `fcm-service-account.json`) and receives FCM pushes directly from `AgentAwarenessRelay` using bundled `infra/relay` payloads and copied `FcmClient`/`FcmDeliveries` in `apps/server/src/mobilePush`—merges touching relay FCM code must mirror there (`MobilePush.test.ts`, `AgentAwarenessRelay.test.ts`).

## Test fixtures on this machine

- `Cannot read properties of undefined (reading 'config')` at collection: use the checkout's `node_modules/.bin/vp`, not a global `vp` (mismatched Vitest).
- Bare-repository fetch fixtures that map into `refs/heads` use `--no-prune`; an inherited `fetch.prune=true` can delete the mapped branch.
- Subprocess identity fixtures use a real executable (`process.execPath`, Bash for WSL fixtures) and a readiness signal: NixOS multicall coreutils may exit when copied under another name or drop a custom `argv[0]`. Don't assume `/usr/bin/node` or `/bin/ps`.
- Private IPC tests reject a `/tmp` owned by another user: set `TMPDIR` to a short, owned mode-700 directory.
- `vp run` prepends checkout binaries to PATH, shadowing shims. Browser-free runs need `--exclude` for `**/*.browser.test.*` and `**/ServerBrowserPage.test.ts`.
