# T3 Code fork

The user's fork of upstream T3 Code. Where this file and `AGENTS.md` differ, this file wins. Fork notes go here, not in `AGENTS.md`, which upstream edits almost daily.

## You may

- Land finished work on `bsag`, started from `origin/bsag` (never the stale local `main`), unless the user asked to review it first. Pushing `bsag` deploys (below).
- Skip upstream's process: Pull requests, Evals, Documentation, the bug-proof rule under Verifying (failing test first, before/after captures) and the ask-first browser rules don't apply.
- Check user-visible changes on the deployed instance after the deploy (`~/local/t3-pi/DEPLOYMENT.md` on `vps` says how to reach it). A worktree dev server costs a ~4 GB install and a seeded database (the live one is past the 500 MiB auto-seed limit: `vp run migrate-dev-db`); start one only when a change can't be seen deployed or shipping it unseen could break the live instance.

## Limits

- Before pushing, run `scripts/fork-check.sh`, the deploy's own gate (`vp run check:changed origin/bsag` is optional: its default base is upstream's `main`, so it diffs the whole fork for over ten minutes).
- Surfaces are the server with its web client on `vps` and the Linux desktop build; macOS, Windows and the relay only when asked.
- Leave `apps/mobile` exactly as upstream has it, even when a fork change stops it compiling: don't edit, test or typecheck it.
- Keep `packages/provider-pi` identical to upstream. Don't restore the removed V1 adapter or permission layer.
- The live installation is `~/local/t3-pi` on `vps`; preserve its `userdata` and keep development state separate. Back up its database before deploying a migration; reverting the executable is not a database rollback.
- `t3 service restart` on the host interrupts running agents; otherwise the server switches to a deployed version by itself once agents are idle.
- Enable `SERVER_RELEASES_PUBLISHED` (`apps/server/src/cloud/selfUpdate.ts`) only when matching release artifacts exist; fork server releases are not published.
- The npm-installed server loads `@ff-labs/fff-node` through an ESM import (upstream's single-executable path needs a patched CommonJS export the npm package lacks); changing that import means changing the installation layout too.

## Deployment

A push to `bsag` runs `.github/workflows/deploy-fork-vps.yml`: it runs the fork check, builds the server with its web client, and installs the npm tarball on `vps` over Tailscale with `t3 service install --defer-restart`, which selects the version (`activeVersion` in `~/local/t3-pi/runtime/service-state.json`) without restarting. Watch the run (`gh run watch`); the deploy is live when `serverVersion` from `/.well-known/t3/environment` on the server's port ends in the pushed commit's 9-character SHA. `[skip ci]` in a docs-only commit message skips the deploy. Linux desktop builds publish fork prereleases through `.github/workflows/desktop-fork-linux.yml`. Host procedures are in `~/local/t3-pi/DEPLOYMENT.md`.

## Upstream merges

- Merge upstream into a review worktree and run `scripts/fork-check.sh` before updating `bsag`. In a conflict, take upstream's side unless it touches a retained change below.
- Only the two fork workflows run; every upstream workflow is disabled (`gh workflow disable -R brunosag/t3code <file>`), since their stuck runs once got the fork's Actions paused, which stopped deploys. After each merge, disable any newly arrived one.
- The desktop app stages only the server dependencies matched in `scripts/lib/cli-external-packages.ts`, never their peers. When a merge bumps one of those and a dependency becomes a peer, declare it in `apps/server/package.json`, or the AppImage backend crash-loops on a missing module and the app never opens.
- A new retained change gets a line below and a test in `scripts/fork-check.sh`, so a merge that breaks it fails.

## Retained changes

- **Claude thinking quotes:** no quoting on Claude thinking items; the Claude adapter strips saved thinking citations but keeps user comments.
- **Question drafts:** written answers to agent questions survive reloads; choosing an option moves the answer into the thread draft.
- **Compaction:** a thread its own agent settled still gets idle compaction (from 100K tokens) and stays settled through it; a running `delegate_task` child doesn't hold off its parent's compaction.
- **Schedules:** a late or manual interval run keeps the previous grid; a used-up `once` schedule deletes its task after success; missed runs of every type run late once (upstream skips fixed-time runs missed by over 10 minutes); `schedule_task` updates take a `delegate_task`-style `target`, and the web editor sets options with the traits picker.
- **Fast Mode switch:** the server can disable Fast Mode, saved selections and delegated tasks included.
- **Read aloud:** local speech synthesis with a player above the composer that survives thread switches; a running turn's latest finished message can be read from its hover row (upstream reverted that row; tested in `MessagesTimeline.logic.test.ts`). No speech controls for guests.
- **Model picker on touch:** touch or pen doesn't focus the search, so the on-screen keyboard stays down.
- **Sharp sheets:** sheets and the sidebar's provider update pill don't keep `will-change: transform`, which leaves text blurry after the slide.
- **Theme editor:** the role spotlight pauses while a color picker is open.
- **Project groups and defaults:** a title every grouped project shares names the group; provider-selected repositories and owner/repo shorthand clone over SSH; Settings chooses the base directory for new projects.
- **Background work:** Linux holds a sleep and lid inhibitor while agent work is unfinished (not pull-request watches); the desktop tray stays, and its startup call is tested in `DesktopApp.test.ts` (an upstream merge once dropped it).
- **Limits hub:** a turn failed on CLIProxyAPI cooldown without a `reset after` time takes its reset from the Limits hub; hubs can be renamed; the Limits view hides and reorders providers, limits and account rows, pools accounts by plan size with burn, runway and charts, and the server records hub readings in `usage-limit-history.json` even with no client open. A failed hub read of a login keeps its last good reading for up to an hour (Anthropic answers close reads with 429), noted under the provider and left out of the history. Dragging a hub login's row in the Limits view sets CLIProxyAPI's routing priority (top first); the provider menu's "Hub accounts" switches logins on and off in the hub, and switched-off logins stay as dimmed rows outside the pooled totals. Hub Claude logins show and redeem banked resets by kind, Fable apart from weekly (upstream offers kinds only to local instances; tested in `usageLimits.test.ts`); Claude only offers them to a recent Claude Code, so hub reads present the newest version a Claude instance reported (tested in `cliproxyApi.test.ts`).
- **Installed web app names:** `manifest.webmanifest` is named `T3 Code (<environment label>)`.
- **Stable branding:** the served web client and Linux desktop build use the black production icons and plain "T3 Code"; the desktop's Electron runtime name stays "T3 Code Nightly" so its keyring state doesn't move.
- **Deploys wait for idle agents:** `t3 service install --defer-restart` switches within about 10 seconds of the last agent work ending (a 5-second settle covers a queued follow-up starting), or after 12 hours.
- **Agent memory on small hosts:** `T3CODE_AGENT_MEMORY_HIGH`, `_MAX` and `_SWAP_MAX` override the agents slice's limits; `check:changed` runs its steps one at a time under 6 GB free.
- **Orphaned desktop backends exit:** the backend gets the desktop's pid at bootstrap and exits if it dies (an AppImage update under `appimage-run` does this).
- **No swipe navigation:** horizontal wheel input never moves through threads; upstream's `HistorySwipeNavigation` is deleted, so a merge that edits or mounts it conflicts or fails the fork check's typecheck.
- **Hidden desktop start:** `--hidden` (the laptop's login autostart) loads the window without showing it; tested in `DesktopWindow.test.ts`.
- **Installation and desktop fixes:** provider updates recognize npm ownership before native-looking layouts; Linux desktop entries need the `--class` switch upstream dropped; development can omit Electron, reuse the last server build (`dev:desktop:lean`), open DevTools explicitly and exit when its window closes; desktop dev origins stay out of the server's embedded web client.

## Test fixtures on this machine

- `Cannot read properties of undefined (reading 'config')` at collection: use the checkout's `node_modules/.bin/vp`, not a global `vp` (mismatched Vitest).
- Bare-repository fetch fixtures that map into `refs/heads` use `--no-prune`; an inherited `fetch.prune=true` can delete the mapped branch.
- Subprocess identity fixtures use a real executable (`process.execPath`, Bash for WSL fixtures) and a readiness signal: NixOS multicall coreutils may exit when copied under another name or drop a custom `argv[0]`. Don't assume `/usr/bin/node` or `/bin/ps`.
- Private IPC tests reject a `/tmp` owned by another user: set `TMPDIR` to a short, owned mode-700 directory.
- `vp run` prepends checkout binaries to PATH, shadowing shims. Browser-free runs need `--exclude` for `**/*.browser.test.*` and `**/ServerBrowserPage.test.ts`.
