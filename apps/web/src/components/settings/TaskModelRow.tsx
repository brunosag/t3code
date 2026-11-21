import type { ModelSelection, ServerProvider, ServerSettings } from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { T } from "gt-react";

import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useTextGenerationTargets } from "../../textGenerators";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow } from "./settingsLayout";
import { useSearchableSetting, type SettingsSearchItemId } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/**
 * An environment setting that gives one text task its own model: off leaves the task to its
 * default, on shows provider, model and traits pickers, starting from the text generation model.
 */
export function TaskModelRow({
  settingKey,
  searchId,
  title,
  description,
  switchLabel,
  notSavedTitle,
  resolve,
}: {
  readonly settingKey: "speechPostProcessingModelSelection" | "readAloudModelSelection";
  readonly searchId: SettingsSearchItemId;
  readonly title: string;
  readonly description: string;
  readonly switchLabel: string;
  readonly notSavedTitle: string;
  /** The model the task uses while its own is set. */
  readonly resolve: (
    settings: ServerSettings,
    providers: ReadonlyArray<ServerProvider>,
  ) => ModelSelection;
}) {
  const setting = useSearchableSetting();
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const targets = useTextGenerationTargets({
    environmentId: environment?.environmentId ?? null,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [settings[settingKey], settings.textGenerationModelSelection],
  });
  const textGenerationProviders = targets.providers;
  const instanceEntries = targets.entries;
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const dedicated = settings[settingKey] !== null;
  const selection = resolveAppModelSelectionState(
    { ...settings, textGenerationModelSelection: resolve(settings, textGenerationProviders) },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries, true);
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({ type: "error", title: notSavedTitle, description: reason });
      return;
    }
    updateSettings({ [settingKey]: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={[settingKey]}
      {...setting(searchId)}
      title={title}
      description={description}
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            <T>Connect an environment first.</T>
          </span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[32rem]/settings-row:justify-end">
            {dedicated && (!hasProvider || !instanceEntry) ? (
              <span className="text-sm text-muted-foreground">
                <T>No text generation providers available.</T>
              </span>
            ) : null}
            {dedicated && hasProvider && instanceEntry ? (
              <>
                <ProviderModelPicker
                  environmentId={environment?.environmentId ?? null}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  getModelDisabledReason={modelDisabledReason}
                  onInstanceModelChange={(instanceId, model) =>
                    setModel(pickModelSelection(selection, instanceId, model))
                  }
                />
                <TraitsPicker
                  provider={instanceEntry.driverKind}
                  models={instanceEntry.models}
                  model={selection.model}
                  modelOptions={selection.options ?? []}
                  allowPromptInjectedEffort={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setModel(createModelSelection(selection.instanceId, selection.model, options))
                  }
                />
              </>
            ) : null}
            <Switch
              checked={dedicated}
              disabled={!dedicated && !hasProvider}
              onCheckedChange={(checked) =>
                updateSettings({
                  [settingKey]: checked
                    ? createModelSelection(
                        settings.textGenerationModelSelection.instanceId,
                        settings.textGenerationModelSelection.model,
                        settings.textGenerationModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label={switchLabel}
            />
          </div>
        )
      }
    />
  );
}
