import { describe, it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { runPiStartupUpdate } from "./PiStartupUpdate.ts";

const encoder = new TextEncoder();

// Pin a non-win32 platform so `resolveSpawnCommand` is a no-op and the raw
// { command, args } assertions hold deterministically on any host.
const NonWindowsPlatform = Layer.succeed(HostProcessPlatform, "linux");

interface SpawnedCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv | undefined;
}

interface StepResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

function mockSpawnerLayer(
  handler: (spawned: SpawnedCommand) => StepResult,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const spawned = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly options: { readonly env?: NodeJS.ProcessEnv | undefined };
      };
      const result = handler({
        command: spawned.command,
        args: spawned.args,
        env: spawned.options.env,
      });
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout ?? "")),
          stderr: Stream.make(encoder.encode(result.stderr ?? "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
}

const fakeSpawner = (handler: (spawned: SpawnedCommand) => StepResult) =>
  Effect.provide(Layer.mergeAll(NonWindowsPlatform, mockSpawnerLayer(handler)));

describe("Pi startup update", () => {
  it.effect("runs pi's updater as --all then --models and reports success", () => {
    const calls: SpawnedCommand[] = [];
    const env = { PATH: "/usr/bin" };
    return Effect.gen(function* () {
      const refreshed = yield* runPiStartupUpdate({ binaryPath: "/usr/local/bin/pi", env });
      assert.equal(refreshed, true);
      assert.deepEqual(
        calls.map((call) => [call.command, call.args]),
        [
          ["/usr/local/bin/pi", ["update", "--all", "--no-approve"]],
          ["/usr/local/bin/pi", ["update", "--models", "--no-approve"]],
        ],
      );
      // The instance environment rides along: the catalog refresh resolves
      // provider credentials from it.
      assert.ok(calls.every((call) => call.env === env));
    }).pipe(fakeSpawner((spawned) => (calls.push(spawned), { stdout: "" })));
  });

  it.effect("still refreshes catalogs when the install update fails", () => {
    const calls: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const refreshed = yield* runPiStartupUpdate({ binaryPath: "pi", env: process.env });
      assert.equal(refreshed, true, "the catalog step alone must count as success");
      assert.equal(calls.length, 2, "a failed first step must not skip the second");
    }).pipe(
      fakeSpawner((spawned) => {
        calls.push(spawned);
        return calls.length === 1
          ? { code: 1, stderr: "npm ERR! network unreachable" }
          : { stdout: "Model catalogs refreshed" };
      }),
    );
  });

  it.effect("reports failure when every step fails", () => {
    const calls: SpawnedCommand[] = [];
    return Effect.gen(function* () {
      const refreshed = yield* runPiStartupUpdate({ binaryPath: "pi", env: process.env });
      assert.equal(refreshed, false, "an all-failure run must not trigger a re-probe");
      assert.equal(calls.length, 2, "both steps are attempted before giving up");
    }).pipe(
      fakeSpawner((spawned) => {
        calls.push(spawned);
        return { code: 1, stderr: "offline" };
      }),
    );
  });
});
