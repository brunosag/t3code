import { createFileRoute } from "@tanstack/react-router";

import { AgentsSettings } from "../components/settings/AgentsSettings";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";

/**
 * Agents are environment state, so the page edits one environment at a time:
 * the chosen one, or the representative of the selection, like Providers.
 */
function SettingsAgentsRoute() {
  const { environment, scope } = useSettingsScope();
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to configure its agents.`
          : "Connect an environment to configure its agents."}
      </p>
    );
  }
  return <AgentsSettings key={environment.environmentId} />;
}

export const Route = createFileRoute("/settings/agents")({
  component: SettingsAgentsRoute,
});
