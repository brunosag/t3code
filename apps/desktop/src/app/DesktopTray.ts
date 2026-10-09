import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";
import { watchSystemAppearance } from "./DesktopTrayTheme.ts";

class DesktopTrayCreateError extends Schema.TaggedError<DesktopTrayCreateError>()(
  "DesktopTrayCreateError",
  { platform: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not create the desktop tray on ${this.platform}.`;
  }
}

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly isActive: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/app/DesktopTray") {}

const { logWarning } = makeComponentLogger("desktop-tray");

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const app = yield* ElectronApp.ElectronApp;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const state = yield* DesktopState.DesktopState;
  const active = yield* Ref.make(false);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const open = () => {
    void runPromise(
      Effect.gen(function* () {
        if (yield* Ref.get(state.quitting)) return;
        yield* desktopWindow.activate;
      }).pipe(Effect.catchCause((cause) => logWarning("failed to open the window", { cause }))),
    );
  };

  const configure = Effect.gen(function* () {
    if (yield* Ref.get(active)) return;
    const iconPath = yield* assets.resolveResourcePath("trayTemplate.png");
    const whiteIconPath =
      environment.platform === "darwin"
        ? iconPath
        : yield* assets.resolveResourcePath("trayWhite.png");
    if (Option.isNone(iconPath) || Option.isNone(whiteIconPath)) {
      yield* logWarning("tray icon unavailable; keeping the normal window close behavior");
      return;
    }

    const { tray, lightIcon, darkIcon } = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const loadIcon = (path: string) => {
            const source = Electron.nativeImage.createFromPath(path);
            if (source.isEmpty()) throw new Error("The tray icon is empty.");
            // Preserve the wordmark's proportions and keep the D-Bus payload small.
            return environment.platform === "linux" ? source.resize({ width: 24 }) : source;
          };
          const lightIcon = loadIcon(iconPath.value);
          const darkIcon =
            environment.platform === "darwin" ? lightIcon : loadIcon(whiteIconPath.value);
          if (environment.platform === "darwin") lightIcon.setTemplateImage(true);
          const dark =
            environment.platform === "win32"
              ? Electron.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
              : Electron.nativeTheme.shouldUseDarkColors;
          const tray = new Electron.Tray(dark ? darkIcon : lightIcon);
          try {
            tray.setToolTip(environment.displayName);
            tray.setContextMenu(
              Electron.Menu.buildFromTemplate([
                { label: "Open T3 Code", click: open },
                { type: "separator" },
                { label: "Quit T3 Code", click: () => void runPromise(app.quit) },
              ]),
            );
            // macOS opens the context menu on click; other platforms emit an
            // activation that can reopen the main window directly.
            if (environment.platform !== "darwin") tray.on("click", open);
            return { tray, lightIcon, darkIcon };
          } catch (cause) {
            tray.destroy();
            throw cause;
          }
        },
        catch: (cause) => new DesktopTrayCreateError({ platform: environment.platform, cause }),
      }),
      ({ tray }) => Effect.sync(() => tray.destroy()).pipe(Effect.ensuring(Ref.set(active, false))),
    );
    yield* Ref.set(active, true);
    if (environment.platform !== "darwin") {
      yield* watchSystemAppearance(environment.platform, (dark) => {
        try {
          tray.setImage(dark ? darkIcon : lightIcon);
        } catch (cause) {
          void runPromise(logWarning("failed to update the tray icon", { cause }));
        }
      });
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("tray unavailable; keeping normal window close behavior", { cause }),
    ),
    Effect.withSpan("desktop.tray.configure"),
  );

  return DesktopTray.of({ configure, isActive: Ref.get(active) });
});

export const layer = Layer.effect(DesktopTray, make);
