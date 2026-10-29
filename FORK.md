# T3 Code fork

This fork follows upstream's V2 orchestrator. Its Pi provider is upstream's, without fork changes.

## Working here

Where this file and `AGENTS.md` differ, this file wins. Fork rules go here, not in `AGENTS.md`: upstream edits that file almost daily, so fork lines there conflict on merge.

- **Surfaces.** The fork ships the server with its web client to `vps`, and a Linux desktop build. "Hit every surface" means those; macOS, Windows and the relay only when asked.
- **Mobile.** The mobile app is unused. Leave `apps/mobile` exactly as upstream has it, even when a fork change stops it compiling: do not edit, test or typecheck it.
- **Upstream process.** Pull requests, Evals, Documentation, and the bug-proof rule under Verifying (failing test first, before/after captures) do not apply. A retained change gets a line under [Retained changes](#retained-changes) and a test listed in `scripts/fork-check.sh`: that test is what tells an upstream merge broke it.
- **Checks.** Before pushing, run `scripts/fork-check.sh`, the deploy's own gate; the pre-commit hook formats. `vp run check:changed origin/bsag` is optional (its default base, `origin/main`, diffs the whole fork and runs past ten minutes).
- **Browser checks.** Upstream's ask-first browser rules do not apply. See a user-visible change on the deployed instance after its deploy (`~/local/t3-pi/DEPLOYMENT.md` on `vps` says how to reach it). A worktree dev server costs a ~4 GB install and a seeded database (the live one is past the 500 MiB auto-seed limit, so run `vp run migrate-dev-db`); start one only when the change cannot be seen deployed, or shipping it unseen could break the live instance.
- **Landing.** Finished work lands on `bsag` (see [Deployment](#deployment)), not a feature branch, unless the user asked to review it first.

Test fixtures on this machine:

- If tests fail at collection with `Cannot read properties of undefined (reading 'config')`, use the checkout's `node_modules/.bin/vp` instead of a global `vp`; mismatched Vitest versions cause this error.
- Bare-repository fetch fixtures that map into `refs/heads` use `--no-prune`; an inherited `fetch.prune=true` can delete the mapped branch during that fetch.
- Subprocess identity fixtures use a real executable (`process.execPath` for Node, Bash for WSL shell fixtures) and a readiness signal. NixOS multicall coreutils may exit when copied under another name or discard a custom `argv[0]`.
- NixOS fixtures cannot assume `/usr/bin/node` or `/bin/ps` exists; use `process.execPath` and PATH-resolved procps when emulating macOS.
- Private IPC tests reject a `/tmp` owned by another non-root user. Set `TMPDIR` to a short, owned mode-700 directory for those tests; keep the listener’s ownership checks.
- `vp run` prepends checkout binaries to PATH, shadowing command shims. Browser-free test runs need explicit Vitest `--exclude` arguments, including `**/*.browser.test.*` and `**/ServerBrowserPage.test.ts`.

## Retained changes

- **Claude thinking quotes:** web and desktop do not offer quoting on Claude thinking items; the Claude adapter also removes saved thinking citations while preserving user comments, whichever client sent them. Other providers keep their quoting behavior.
- **Question lead-ins:** Claude 5.1+ thinking right before an `AskUserQuestion` shows as assistant text, even when it is the turn's only thought before the question, so the user sees what the agent wrote before answering. Other tool calls keep upstream's rule.
- **Question drafts:** written answers to agent questions survive web reloads. Choosing an option moves a written answer into the thread draft.
- **Interval schedules keep their slot:** an interval task that fires late (the machine was asleep) or is run by hand stays on the grid its previous due time set, instead of restarting the interval from when it ran. A schedule edit or re-enable still starts a new grid from that moment.
- **One-time scheduled tasks:** a `once` schedule runs at a single `runAt` time, picked in the client's time zone, on web, mobile and `schedule_task`. A successful run deletes the task; a failed one stays with its error. Every schedule type runs a missed run late, once, instead of skipping it.
- **Scheduled task models:** updating a task through `schedule_task` with `scheduledTaskId` takes a `delegate_task`-style `target`, so agents can move a task to another provider, model or options; scheduled task summaries include the model.
- **Fast Mode switch:** the server can disable Fast Mode, including saved selections and delegated tasks.
- **Read aloud:** web and desktop synthesize assistant messages on their environment, with a player above the composer. A running turn's latest message can be read while a question or approval waits on the user. Guest transcripts have no speech controls.
- **Subagent effort labels:** a provider-native subagent shows an effort only when one was chosen or reported, not the model's catalog default.
- **Theme editor:** the role spotlight pauses while a color picker is open, so a color is judged against the unobscured app.
- **Project group names:** a title every grouped project shares names the group, even when it equals the repository name.
- **Project defaults:** provider-selected repositories and owner/repository shorthand clone over SSH; explicit pasted URLs keep their transport. Settings can choose the base directory for new named projects.
- **Background work:** Linux holds a sleep and lid-switch inhibitor while agent work remains unfinished, excluding pull-request watches. The desktop tray remains available.
- **Usage limits layout:** the Limits view can hide and reorder providers, and hide single limits (such as a model-scoped weekly limit) from a provider's ⋯ menu; the choices are saved per browser. Multi-account bars show each account's avatar, not its name.
- **Installed web app names:** the server serves `manifest.webmanifest` named `T3 Code (<environment label>)`, so web apps installed from several machines stay apart on a phone.
- **Stable branding:** the web client a server serves and the Linux desktop build use the black production icons and are titled plain “T3 Code”, without upstream’s “(Beta)” or “(Nightly)”. The desktop’s nightly version only picks its update channel; its Electron runtime name stays “T3 Code Nightly” so its keyring state does not move.
- **Agent memory on small hosts:** `T3CODE_AGENT_MEMORY_HIGH`, `_MAX` and `_SWAP_MAX` override the agents slice's RAM-derived limits, for a host (the VPS) whose own cgroup limit also holds the server. `check:changed` runs knip, typecheck and tests one at a time, one worker each, when less than 6 GB is free under MemAvailable and its cgroups' limits.
- **Installation and desktop fixes:** provider updates recognize npm ownership before native-looking layouts; Linux desktop entries match window identities. The main window can shrink to 480px wide. Development can omit Electron, reuse the last server build for lean desktop startup, open DevTools explicitly, and exit when its desktop window closes. Desktop dev origins stay out of the server’s embedded web client.

## Migration

Upstream imports legacy conversation messages into V2. Continued imported threads receive a portable context handoff; old provider session bindings, checkpoints, and tool history are not imported. Native Pi session files remain separate from T3's database. Keep a database backup before deploying this migration; reverting the executable is not a database rollback.

## Deployment

`bsag` is the fork's base and default branch: start work from `origin/bsag`, never the stale local `main`. A push to `bsag` deploys. A deploy is done when its run succeeds and `activeVersion` in `~/local/t3-pi/runtime/service-state.json` on `vps` ends in the pushed commit's 9-character SHA; watch the run (`gh run watch`) and check that before calling it live. Put `[skip ci]` in a docs-only commit message to skip the deploy.

Pushing `bsag` runs `.github/workflows/deploy-fork-vps.yml`, which tests the retained changes, builds the server with its web client and the black production icons, and installs the npm tarball on `vps` over Tailscale. `vps` is an OVHcloud VPS (since 2026-10-27), reached over Tailscale as `bsag`; `tutor-prod` remains a compatibility SSH alias. Secrets are `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and `VPS_DEPLOY_KEY`; repository variables are `VPS_HOST` and `VPS_USER`.

The live installation is `~/local/t3-pi`; preserve its `userdata` and keep development state separate. Runtime versions use `-fork.<short-sha>`, with the core derived from the upstream release package. Installation retains previous complete runtimes and uses the stock service launcher through a Node shim at `runtime/versions/<version>/t3`. Host procedures live in `~/local/t3-pi/DEPLOYMENT.md`.

Fork server releases are not published. Non-desktop environments advertise `serverUpdateUnavailable`, so clients do not offer the stock updater. `SERVER_RELEASES_PUBLISHED` in `apps/server/src/cloud/selfUpdate.ts` controls this; enable it only when matching release artifacts exist. Linux desktop builds publish fork prereleases through `.github/workflows/desktop-fork-linux.yml`.

The npm-installed server loads `@ff-labs/fff-node` through an ESM import. Upstream's single-executable path needs a patched CommonJS export that the npm-installed package does not have; changing this import requires changing the installation layout too.

## Maintenance

Merge upstream into a review worktree and run `scripts/fork-check.sh` before updating `bsag`. In a conflict, take upstream's side unless it touches a retained change above.

Only `deploy-fork-vps.yml` and `desktop-fork-linux.yml` run on the fork; every upstream workflow is disabled (`gh workflow disable -R brunosag/t3code <file>`), since their stuck runs once got the fork's Actions paused, which stopped deploys. After each upstream merge, disable any newly arrived workflow. Keep `packages/provider-pi` identical to upstream. Do not restore the removed V1 adapter or permission layer.

The desktop app stages only the server dependencies matched in `scripts/lib/cli-external-packages.ts`, never their peer dependencies. When an upstream merge bumps one of those packages (such as `@cursor/sdk`) and a dependency becomes a peer, declare it in `apps/server/package.json`, or the AppImage backend crash-loops on a missing module and the app never opens (zod, 2026-10-27).
