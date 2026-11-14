// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { autoUpdater } from "electron-updater";
import type * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  execFileSync: (command: string, args: ReadonlyArray<string>) => Buffer;
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater AppImage install",
  () => {
    it.live("relaunches through the launcher after the updater exits, without its fds", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
        const appImagePath = path.join(dir, "T3-Code.AppImage");
        const stagedPath = path.join(dir, "T3-Code-1.0.1.AppImage");
        const reportPath = path.join(dir, "relaunch-report");
        yield* Effect.sync(() => childProcess.execFileSync("mkfifo", [reportPath]));
        // Stands in for the quitting app. Only a relaunch that waits for it runs `sleep`, whose
        // stand-in on PATH ends it, so an AppImage started any earlier finds it still alive.
        const updatingApp = yield* Effect.acquireRelease(
          Effect.sync(() => childProcess.spawn("bash", ["-c", "read -r _"], { stdio: "pipe" })),
          (child) => Effect.sync(() => child.kill()),
        );
        const binDir = path.join(dir, "bin");
        yield* fileSystem.makeDirectory(binDir);
        yield* fileSystem.writeFileString(
          path.join(binDir, "sleep"),
          `#!/bin/sh\nkill ${updatingApp.pid} 2>/dev/null\n`,
        );
        yield* fileSystem.chmod(path.join(binDir, "sleep"), 0o755);
        yield* fileSystem.writeFileString(appImagePath, "old AppImage");
        yield* fileSystem.writeFileString(stagedPath, "#!/bin/sh\n");
        yield* fileSystem.chmod(stagedPath, 0o755);
        const launcherPath = path.join(dir, "t3-launcher");
        yield* fileSystem.writeFileString(
          launcherPath,
          `#!/bin/sh\n{ echo launched; ls /proc/self/fd; kill -0 ${updatingApp.pid} 2>/dev/null && echo updater-alive; } > '${reportPath}'\n`,
        );
        yield* fileSystem.chmod(launcherPath, 0o755);

        const hostEnvironment = yield* HostProcess.Environment;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            vi.stubEnv("APPIMAGE", appImagePath);
            vi.stubEnv("PATH", `${binDir}:${hostEnvironment.PATH}`);
          }),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: stagedPath,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });

        const realPid = Object.getOwnPropertyDescriptor(process, "pid");
        yield* Effect.acquireRelease(
          Effect.sync(() => Object.defineProperty(process, "pid", { value: updatingApp.pid })),
          () => Effect.sync(() => realPid && Object.defineProperty(process, "pid", realPid)),
        );

        // Electron's main process holds the AppImage runtime's keepalive pipe and some
        // Chromium files without O_CLOEXEC. Node cannot hold such a descriptor, so the
        // relaunch runs with fd 7 opened that way to stand in for them.
        const realSpawn = childProcess.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            childProcess.spawn = (command, args, options) =>
              realSpawn(
                "bash",
                ["-c", 'exec 7</dev/null; exec "$@"', "leaky-parent", command, ...args],
                options,
              );
            NodeModule.syncBuiltinESMExports();
          }),
          () =>
            Effect.sync(() => {
              childProcess.spawn = realSpawn;
              NodeModule.syncBuiltinESMExports();
            }),
        );

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({
          isSilent: true,
          isForceRunAfter: true,
          launcherPath,
        });
        const report = yield* Effect.forkScoped(fileSystem.readFileString(reportPath));

        const lines = (yield* Fiber.join(report)).trim().split("\n");
        assert.include(lines, "launched", "relaunch bypassed T3CODE_DESKTOP_LAUNCHER_PATH");
        assert.notInclude(
          lines,
          "updater-alive",
          "AppImage relaunched before the updating app exited",
        );
        assert.notInclude(
          lines,
          "7",
          `relaunched AppImage inherited the updating process's fd 7 (open fds: ${lines.join(" ")})`,
        );
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);
