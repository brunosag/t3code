import { Message, sessionBus, type Variant } from "dbus-next";
import * as Effect from "effect/Effect";
import * as Electron from "electron";

import { makeComponentLogger } from "./DesktopObservability.ts";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SETTINGS = "org.freedesktop.portal.Settings";
const APPEARANCE = "org.freedesktop.appearance";
const { logWarning } = makeComponentLogger("desktop-tray");

/** Follow the panel's appearance, independently of the renderer's theme override. */
export const watchSystemAppearance = Effect.fn("desktop.tray.watchSystemAppearance")(function* (
  platform: NodeJS.Platform,
  onChange: (dark: boolean) => void,
) {
  let linuxPreference: number | undefined;
  let previous: boolean | undefined;
  const update = () => {
    const dark =
      platform === "win32"
        ? Electron.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
        : linuxPreference === undefined
          ? Electron.nativeTheme.shouldUseDarkColors
          : linuxPreference === 1;
    if (dark === previous) return;
    onChange(dark);
    previous = dark;
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => Electron.nativeTheme.on("updated", update)),
    () => Effect.sync(() => Electron.nativeTheme.removeListener("updated", update)),
  );
  yield* Effect.sync(update);
  if (platform !== "linux") return;

  // Electron's Linux native theme also follows T3's themeSource override.
  // The portal reports the actual system preference and emits changes.
  yield* Effect.gen(function* () {
    let watching = true;
    const bus = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const bus = sessionBus();
        bus.on("error", () => {
          if (!watching) return;
          linuxPreference = undefined;
          update();
        });
        return bus;
      }),
      (bus) =>
        Effect.sync(() => {
          watching = false;
          bus.disconnect();
        }),
    );
    yield* Effect.tryPromise(async (signal) => {
      const proxy = await bus.getProxyObject(PORTAL, PORTAL_PATH);
      if (signal.aborted) return;
      const settings = proxy.getInterface(SETTINGS);
      const changed = (namespace: string, key: string, value: Variant<unknown>) => {
        if (!watching) return;
        if (namespace !== APPEARANCE || key !== "color-scheme") return;
        linuxPreference = typeof value.value === "number" ? value.value : 0;
        update();
      };
      settings.on("SettingChanged", changed);
      // ReadAll works with both versions of the Settings portal, without
      // the nested variants returned by the deprecated Read method.
      const reply = await bus.call(
        new Message({
          destination: PORTAL,
          path: PORTAL_PATH,
          interface: SETTINGS,
          member: "ReadAll",
          signature: "as",
          body: [[APPEARANCE]],
        }),
      );
      if (signal.aborted) return;
      const namespaces = reply?.body[0] as
        | Record<string, Record<string, Variant<unknown>>>
        | undefined;
      const preference = namespaces?.[APPEARANCE]?.["color-scheme"];
      if (preference && linuxPreference === undefined) {
        changed(APPEARANCE, "color-scheme", preference);
      }
    }).pipe(Effect.timeout("2 seconds"));
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("system appearance portal unavailable; using the native theme", { cause }),
    ),
  );
});
