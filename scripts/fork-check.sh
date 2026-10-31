#!/usr/bin/env bash
# The fork's deploy gate (.github/workflows/deploy-fork-vps.yml); run it before pushing bsag.
# Each retained change in FORK.md keeps a test here, so an upstream merge that breaks one fails.
set -euo pipefail
cd "$(dirname "$0")/.."

vp test run \
  apps/server/src/provider/ProviderRegistry.test.ts \
  apps/server/src/scheduledTasks/Schedule.test.ts \
  apps/server/src/scheduledTasks/ScheduledTaskService.test.ts \
  apps/server/src/background/SleepInhibitor.test.ts \
  apps/server/src/background/SleepInhibitor.integration.test.ts \
  apps/server/src/background/IdleRestart.test.ts \
  apps/server/src/cli/service.test.ts \
  packages/shared/src/orchestrationV2PendingBackgroundWork.test.ts \
  apps/server/src/webManifest.test.ts \
  packages/provider-core/src/server/maintenanceResolver.test.ts \
  apps/server/src/provider/providerMaintenanceRunner.test.ts \
  apps/web/src/providerInstances.test.ts \
  apps/web/src/components/settings/ProviderSettingsForm.test.ts \
  apps/web/src/components/settings/scheduledTasksSettings.logic.test.ts \
  packages/contracts/src/server.test.ts \
  packages/shared/src/serverSettings.test.ts \
  packages/shared/src/assistantCitations.test.ts \
  apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts \
  apps/server/src/usage/cliproxyApi.test.ts \
  apps/web/src/components/GitActionsControl.logic.test.ts \
  apps/web/src/pendingUserInput.test.ts \
  apps/web/src/components/chat/MessagesTimeline.logic.test.ts \
  apps/web/src/components/chat/modelPickerSearch.test.ts \
  apps/web/src/versionSkew.test.ts \
  apps/web/src/components/usage/usagePagePreferences.test.ts \
  apps/web/src/components/usage/usageProviders.test.ts \
  packages/contracts/src/settings.test.ts \
  apps/desktop/src/app/DesktopEnvironment.test.ts \
  apps/desktop/src/window/DesktopWindow.test.ts \
  apps/server/src/process/agentScope.test.ts \
  apps/server/src/cli/config.test.ts \
  apps/desktop/src/backend/DesktopBackendConfiguration.test.ts \
  apps/server/src/orchestration-v2/IdleCompaction.test.ts \
  apps/server/src/orchestration-v2/runtimeLayer.test.ts \
  scripts/lib/memory-headroom.test.ts \
  scripts/dev-runner.test.ts

vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop \
  --filter @t3tools/shared --filter @t3tools/contracts --filter @t3tools/client-runtime \
  --filter @t3tools/provider-pi --filter @t3tools/provider-core --concurrency-limit 2 typecheck
