// @effect-diagnostics schemaSyncInEffect:off globalDate:off - RPC Promise boundary; decode failures are caught by tryPromise.
import {
  type AgentDefinition,
  type ModelCapabilities,
  PiConnectionSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makePiAdapter } from "../pi/PiAdapter.ts";
import {
  materializePiAgentsExtension,
  piAgentDefinitionsPath,
  withPiAgentsEnvironment,
  writePiAgentDefinitions,
} from "../pi/PiAgentsExtension.ts";
import { mapPiThinkingCapabilities } from "../pi/PiCapabilities.ts";
import { PiRpcClient } from "../pi/PiRpcClient.ts";
import { PiCommands, PiModels, PiState, PiThinkingLevels } from "../pi/PiProtocol.ts";
import { makePiTextGeneration } from "../pi/PiTextGeneration.ts";
import { materializePiMcpExtension } from "../pi/PiMcpExtension.ts";
import { materializePiUserInputExtension } from "../pi/PiUserInputExtension.ts";

const decodePiState = Schema.decodeUnknownSync(PiState);
const decodePiModels = Schema.decodeUnknownSync(PiModels);
const decodePiCommands = Schema.decodeUnknownSync(PiCommands);
const decodePiThinkingLevels = Schema.decodeUnknownSync(PiThinkingLevels);

/**
 * Pi builds predating thinking levels do not answer here at all. Probing then
 * stays off entirely instead of spending a failed round trip on every model.
 */
const readPiThinkingLevels = async (client: PiRpcClient) => {
  try {
    return decodePiThinkingLevels(await client.request("get_available_thinking_levels")).levels;
  } catch {
    return null;
  }
};

/**
 * A model T3 cannot select (missing API key, since-deleted model) simply reports
 * no traits rather than taking the whole catalog probe down with it.
 */
const probePiModelCapabilities = async (
  client: PiRpcClient,
  model: { readonly provider: string; readonly id: string },
): Promise<ModelCapabilities | null> => {
  try {
    await client.request("set_model", { provider: model.provider, modelId: model.id });
    const levels = decodePiThinkingLevels(await client.request("get_available_thinking_levels"));
    const state = decodePiState(await client.request("get_state"));
    return mapPiThinkingCapabilities(levels.levels, state.thinkingLevel);
  } catch {
    return null;
  }
};

const DRIVER = ProviderDriverKind.make("pi");
export type PiDriverEnv = ServerConfig | ServerSettingsService;
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

export const PiDriver: ProviderDriver<PiConnectionSettings, PiDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiConnectionSettings,
  defaultConfig: () => ({ binaryPath: "pi" }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const server = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const userInputExtensionPath = yield* Effect.tryPromise({
        try: () => materializePiUserInputExtension(server.stateDir),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: `Failed to prepare the Pi user-input extension: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          }),
      });
      const mcpExtensionPath = yield* Effect.tryPromise({
        try: () => materializePiMcpExtension(server.stateDir),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: `Failed to prepare the Pi T3-toolkit extension: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          }),
      });
      const agentsExtensionPath = yield* Effect.tryPromise({
        try: () => materializePiAgentsExtension(server.stateDir),
        catch: (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: `Failed to prepare the Pi agent-registration extension: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          }),
      });
      const writeAgents = (definitions: readonly AgentDefinition[]) =>
        Effect.tryPromise({
          try: () => writePiAgentDefinitions(server.stateDir, definitions),
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to write Pi agent definitions: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
        });
      const initialAgentDefinitions = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Failed to read Pi agent definitions: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
        ),
        Effect.map((settings) => settings.agentDefinitions),
      );
      yield* writeAgents(initialAgentDefinitions);
      // The extension re-reads the file at each session start, so rewriting it
      // is what makes an edit reach the next new thread. Failures inside the
      // watcher must not take the driver down.
      yield* Effect.forkScoped(
        serverSettings.streamChanges.pipe(
          Stream.runForEach((settings) => writeAgents(settings.agentDefinitions)),
          Effect.catch(() => Effect.void),
        ),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const changes = yield* PubSub.unbounded<ServerProvider>();
      const base = (): ServerProvider => ({
        instanceId,
        driver: DRIVER,
        displayName: displayName ?? "Pi",
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        enabled,
        installed: false,
        version: null,
        status: enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt: new Date().toISOString(),
        managesRuntimePermissions: true,
        showInteractionModeToggle: false,
        reportsContextWindow: true,
        requiresNewThreadForModelChange: false,
        supportsTextGeneration: true,
        setup: { canAuthenticate: false, canInstall: false },
        models: [],
        slashCommands: [],
        skills: [],
        message:
          "Pi is externally configured. T3 does not install, authenticate, update, or configure it.",
      });
      let current = base();
      const probe = (cwd: string) =>
        Effect.tryPromise({
          try: async (signal) => {
            if (!enabled) return base();
            const client = new PiRpcClient({
              binaryPath: config.binaryPath,
              cwd,
              environment: processEnv,
              onEvent: (event) => {
                // A catalog probe has no interactive user; never grant an extension dialog.
                if (
                  event.type === "extension_ui_request" &&
                  typeof event.id === "string" &&
                  ["select", "confirm", "input", "editor"].includes(String(event.method))
                ) {
                  client.send({ type: "extension_ui_response", id: event.id, cancelled: true });
                }
              },
              onExit: () => {},
            });
            const abort = () => {
              void client.close();
            };
            signal.addEventListener("abort", abort, { once: true });
            try {
              const models = decodePiModels(await client.request("get_available_models"));
              const commands = decodePiCommands(await client.request("get_commands"));
              // Pi reports thinking levels per model, so the catalog asks Pi about
              // each model instead of guessing from its name. Pi builds without
              // thinking levels answer nothing here; the probe then stays off
              // rather than spending a failed round trip on every model.
              const capabilities = new Map<string, ModelCapabilities | null>();
              if ((await readPiThinkingLevels(client)) !== null) {
                for (const model of models.models) {
                  capabilities.set(
                    `${model.provider}/${model.id}`,
                    await probePiModelCapabilities(client, model),
                  );
                }
              }
              const slashCommands = commands.commands
                .filter((command) => command.name.trim())
                .map((command) => ({
                  name: command.name,
                  ...(command.description?.trim() ? { description: command.description } : {}),
                }));
              // Pi's built-in /compact command is handled by the RPC protocol but is not
              // included in get_commands (which only reports extensions, prompts, and skills).
              if (!slashCommands.some((command) => command.name === "compact")) {
                slashCommands.push({
                  name: "compact",
                  description: "Manually compact the session context",
                });
              }
              return {
                ...base(),
                installed: true,
                status: "ready" as const,
                models: models.models.map((model) => ({
                  slug: `${model.provider}/${model.id}`,
                  name: model.name || model.id,
                  subProvider: model.provider,
                  isCustom: false,
                  capabilities: capabilities.get(`${model.provider}/${model.id}`) ?? null,
                })),
                slashCommands,
              };
            } finally {
              signal.removeEventListener("abort", abort);
              await client.close();
            }
          },
          catch: (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: `Pi RPC discovery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
            }),
        });
      const refresh = probe(server.cwd).pipe(
        Effect.catch((error) =>
          Effect.succeed({ ...base(), status: "error" as const, message: error.detail }),
        ),
        Effect.tap((value) =>
          Effect.sync(() => {
            current = value;
            PubSub.publishUnsafe(changes, value);
          }),
        ),
      );
      const adapter = yield* makePiAdapter({
        ...config,
        instanceId,
        cwd: server.cwd,
        attachmentsDir: server.attachmentsDir,
        environment: withPiAgentsEnvironment(processEnv, piAgentDefinitionsPath(server.stateDir)),
        userInputExtensionPath,
        mcpExtensionPath,
        agentsExtensionPath,
      });
      yield* refresh;
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        adapter,
        textGeneration: makePiTextGeneration(config, processEnv),
        snapshotForCwd: probe,
        refreshModels: () => refresh.pipe(Effect.asVoid),
        snapshot: {
          getSnapshot: Effect.sync(() => current),
          refresh,
          streamChanges: Stream.fromPubSub(changes),
          resolveMaintenance: () => Effect.succeed(maintenance),
          applyUsageLimits: () => Effect.void,
        },
      } satisfies ProviderInstance;
    }),
};
