# T3 Code fork

This fork follows upstream's V2 orchestrator. Its Pi provider is upstream's, without fork changes.

## Retained changes

- **Claude thinking quotes:** web and desktop do not offer quoting on Claude thinking items; the Claude adapter also removes saved thinking citations while preserving user comments, whichever client sent them. Other providers keep their quoting behavior.
- **Question drafts:** written answers to agent questions survive web reloads. Choosing an option moves a written answer into the thread draft.
- **Interval schedules keep their slot:** an interval task that fires late (the machine was asleep) or is run by hand stays on the grid its previous due time set, instead of restarting the interval from when it ran. A schedule edit or re-enable still starts a new grid from that moment.
- **Scheduled task models:** `update_scheduled_task` takes a `delegate_task`-style `target`, so agents can move a task to another provider, model or options; scheduled task summaries include the model.
- **Fast Mode switch:** the server can disable Fast Mode, including saved selections and delegated tasks.
- **Read aloud:** web and desktop synthesize assistant messages on their environment, with a player above the composer. Guest transcripts have no speech controls.
- **Subagent effort labels:** a provider-native subagent shows an effort only when one was chosen or reported, not the model's catalog default.
- **Theme editor:** the role spotlight pauses while a color picker is open, so a color is judged against the unobscured app.
- **Project group names:** a title every grouped project shares names the group, even when it equals the repository name.
- **Project defaults:** provider-selected repositories and owner/repository shorthand clone over SSH; explicit pasted URLs keep their transport. Settings can choose the base directory for new named projects.
- **Background work:** Linux holds a sleep and lid-switch inhibitor while agent work remains unfinished, excluding pull-request watches. The desktop tray remains available.
- **Installed web app names:** the server serves `manifest.webmanifest` named `T3 Code (<environment label>)`, so web apps installed from several machines stay apart on a phone.
- **Installation and desktop fixes:** provider updates recognize npm ownership before native-looking layouts; Linux desktop entries match window identities. The main window can shrink to 480px wide. Development can omit Electron, reuse the last server build for lean desktop startup, open DevTools explicitly, and exit when its desktop window closes. Desktop dev origins stay out of the server’s embedded web client.

## Migration

Upstream imports legacy conversation messages into V2. Continued imported threads receive a portable context handoff; old provider session bindings, checkpoints, and tool history are not imported. Native Pi session files remain separate from T3's database. Keep a database backup before deploying this migration; reverting the executable is not a database rollback.

## Deployment

`bsag` is the fork's base and default branch: start work from `origin/bsag`, never the stale local `main`. A push to `bsag` deploys. A deploy is done when its run succeeds and `activeVersion` in `~/local/t3-pi/runtime/service-state.json` on `vps` ends in the pushed commit's 9-character SHA; watch the run (`gh run watch`) and check that before calling it live. Put `[skip ci]` in a docs-only commit message to skip the deploy.

Pushing `bsag` runs `.github/workflows/deploy-fork-vps.yml`, which tests the retained changes, builds the server with its web client, and installs the npm tarball on `vps` over Tailscale. `tutor-prod` remains a compatibility SSH alias and the Azure resource name. Secrets are `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and `VPS_DEPLOY_KEY`; repository variables are `VPS_HOST` and `VPS_USER`.

The live installation is `~/local/t3-pi`; preserve its `userdata` and keep development state separate. Runtime versions use `-fork.<short-sha>`, with the core derived from the upstream release package. Installation retains previous complete runtimes and uses the stock service launcher through a Node shim at `runtime/versions/<version>/t3`. Host procedures live in `~/local/t3-pi/DEPLOYMENT.md`.

Fork server releases are not published. Non-desktop environments advertise `serverUpdateUnavailable`, so clients do not offer the stock updater. `SERVER_RELEASES_PUBLISHED` in `apps/server/src/cloud/selfUpdate.ts` controls this; enable it only when matching release artifacts exist. Linux desktop builds publish fork prereleases through `.github/workflows/desktop-fork-linux.yml`.

The npm-installed server loads `@ff-labs/fff-node` through an ESM import. Upstream's single-executable path needs a patched CommonJS export that the npm-installed package does not have; changing this import requires changing the installation layout too.

## Maintenance

Merge upstream into a review worktree and run focused tests plus typechecks for affected packages before updating `bsag`. In a conflict, take upstream's side unless it touches a retained change above.

Keep upstream's scheduled workflows disabled on the fork (`gh workflow disable -R brunosag/t3code <file>`; currently `release.yml`, `mobile-android-apk.yml`, `relay-preview-cleanup.yml`, and `stale-needs-more-info.yml`). Their stuck runs got the fork's Actions paused, which stopped deploys. After each upstream merge, disable any newly arrived workflow with a `schedule:` trigger. Keep `packages/provider-pi` identical to upstream. Do not restore the removed V1 adapter or permission layer.
