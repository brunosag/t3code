# T3 Code fork

This fork follows upstream's V2 orchestrator and Pi provider. Pi is an external CLI: install and authenticate it on the machine running the T3 server, then configure its executable in Settings → Providers. Upstream owns Pi model discovery, permissions, sessions, compaction, MCP integration, and auxiliary text generation.

## Retained changes

- **Pi questions:** the T3-owned `t3_ask_user` extension supports batched questions, option descriptions, multiple selections, and written answers. It uses dedicated inherited pipes alongside Pi's RPC transport. Written question drafts survive web reloads and mobile app restarts; clear the written answer before choosing options.
- **Pi agent roster:** Settings → Agents stores named definitions for compatible `pi-subagents` extensions, including prompts, models, thinking, tools, skills, extension access, and turn limits. Definitions apply when a Pi session next starts. A configured roster is exclusive; disabled entries are omitted. Registration failures appear as extension errors. Background completion events update the shared agent timeline.
- **Git preferences:** automatic, manual, or disabled pull-request actions, plus confirmation before pushing to the default branch, are shared across clients and project overrides.
- **Claude history:** the SDK 0.3.276 patch rewrites internal deferred tool references when forking a session. The real SDK fork regression test covers repeated forks and external references. Healthy Claude skill changes invalidate cached workspace inventories so clients rescan them.
- **Installation and desktop fixes:** provider updates recognize npm ownership before native-looking layouts; Linux desktop entries match window identities. Development can omit Electron, open DevTools explicitly, and exit when its desktop window closes. Chat line width remains adjustable.

## Migration

Upstream imports legacy conversation messages into V2. Continued imported threads receive a portable context handoff; old provider session bindings, checkpoints, and tool history are not imported. Native Pi session files remain separate from T3's database. Keep a database backup before deploying this migration; reverting the executable is not a database rollback.

## Deployment

Pushing `bsag` runs `.github/workflows/deploy-pi-vps.yml`, which tests the retained changes, builds the server with its web client, and installs the npm tarball on `vps` over Tailscale. `tutor-prod` remains a compatibility SSH alias and the Azure resource name. Secrets are `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`, and `VPS_DEPLOY_KEY`; repository variables are `VPS_HOST` and `VPS_USER`.

The live installation is `~/local/t3-pi`; preserve its `userdata` and keep development state separate. Runtime versions use `-pi.<short-sha>`, with the core derived from the upstream release package. Installation retains previous complete runtimes and uses the stock service launcher through a Node shim at `runtime/versions/<version>/t3`. Host procedures live in `~/local/t3-pi/DEPLOYMENT.md`.

Fork server releases are not published. Non-desktop environments advertise `serverUpdateUnavailable`, so clients do not offer the stock updater. `SERVER_RELEASES_PUBLISHED` in `apps/server/src/cloud/selfUpdate.ts` controls this; enable it only when matching release artifacts exist. Linux desktop builds publish fork prereleases through `.github/workflows/desktop-pi-linux.yml`.

The npm-installed server loads `@ff-labs/fff-node` through an ESM import. Upstream's single-executable path needs a patched CommonJS export that the npm-installed package does not have; changing this import requires changing the installation layout too.

## Maintenance

Merge upstream into a review worktree and run focused tests plus typechecks for affected packages before updating `bsag`. Pi transport and adapter tests live in `apps/server/src/orchestration-v2/Adapters`; retained extension tests live in `apps/server/src/provider/pi`. Do not restore the removed V1 adapter or permission layer.
