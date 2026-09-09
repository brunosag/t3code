// @effect-diagnostics schemaSyncInEffect:off globalDate:off - RPC Promise boundary; decode failures are caught by tryPromise.
import { PiConnectionSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { makePiAdapter } from "../pi/PiAdapter.ts";
import { PiRpcClient } from "../pi/PiRpcClient.ts";
import { PiCommands, PiModels, PiState } from "../pi/PiProtocol.ts";
import { makePiTextGeneration } from "../pi/PiTextGeneration.ts";

const decodePiState = Schema.decodeUnknownSync(PiState);
const decodePiModels = Schema.decodeUnknownSync(PiModels);
const decodePiCommands = Schema.decodeUnknownSync(PiCommands);
const DRIVER = ProviderDriverKind.make("pi");
export type PiDriverEnv = ServerConfig;
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
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
        showInteractionModeToggle: false,
        requiresNewThreadForModelChange: false,
        supportsConversationRollback: false,
        supportsTextGeneration: true,
        setup: { canAuthenticate: false, canInstall: false },
        models: [
          {
            slug: "default",
            name: "Pi default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
        ],
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
              decodePiState(await client.request("get_state"));
              const models = decodePiModels(await client.request("get_available_models"));
              const commands = decodePiCommands(await client.request("get_commands"));
              return {
                ...base(),
                installed: true,
                status: "ready" as const,
                models: [
                  ...base().models,
                  ...models.models.map((model) => ({
                    slug: `${model.provider}/${model.id}`,
                    name: model.name || model.id,
                    subProvider: model.provider,
                    isCustom: false,
                    capabilities: null,
                  })),
                ],
                slashCommands: commands.commands
                  .filter((command) => command.name.trim())
                  .map((command) => ({
                    name: command.name,
                    ...(command.description?.trim() ? { description: command.description } : {}),
                  })),
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
        environment: processEnv,
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
