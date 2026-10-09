import { assert, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";

const native = vi.hoisted(() => ({
  menu: [] as Electron.MenuItemConstructorOptions[],
  listeners: new Map<string, () => void>(),
  destroy: vi.fn(),
  setToolTip: vi.fn(),
  setContextMenu: vi.fn(),
  setTemplateImage: vi.fn(),
  createFromPath: vi.fn(),
  createTray: vi.fn(),
  setImage: vi.fn(),
  themeListeners: new Set<() => void>(),
  dark: false,
  systemDark: false,
  portalPreference: 2,
  portalChanged: undefined as
    | ((namespace: string, key: string, value: { value: number }) => void)
    | undefined,
  portalCall: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("dbus-next", async (original) => ({
  ...(await original<typeof import("dbus-next")>()),
  sessionBus: () => ({
    on: vi.fn(),
    disconnect: native.disconnect,
    call: native.portalCall,
    getProxyObject: async () => ({
      getInterface: () => ({
        on: (_event: string, listener: typeof native.portalChanged) => {
          native.portalChanged = listener;
        },
      }),
    }),
  }),
}));

vi.mock("electron", () => ({
  Tray: class {
    constructor(icon: unknown) {
      native.createTray(icon);
    }
    destroy = native.destroy;
    setToolTip = native.setToolTip;
    setContextMenu = native.setContextMenu;
    setImage = native.setImage;
    on(event: string, listener: () => void) {
      native.listeners.set(event, listener);
    }
  },
  nativeImage: { createFromPath: native.createFromPath },
  nativeTheme: {
    get shouldUseDarkColors() {
      return native.dark;
    },
    get shouldUseDarkColorsForSystemIntegratedUI() {
      return native.systemDark;
    },
    on: (_event: string, listener: () => void) => native.themeListeners.add(listener),
    removeListener: (_event: string, listener: () => void) =>
      native.themeListeners.delete(listener),
  },
  Menu: {
    buildFromTemplate: (menu: Electron.MenuItemConstructorOptions[]) => {
      native.menu = menu;
      return menu;
    },
  },
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopTray from "./DesktopTray.ts";

beforeEach(() => {
  vi.resetAllMocks();
  native.menu = [];
  native.listeners.clear();
  native.themeListeners.clear();
  native.dark = false;
  native.systemDark = false;
  native.portalPreference = 2;
  native.portalChanged = undefined;
  native.portalCall.mockImplementation(async () => ({
    body: [
      { "org.freedesktop.appearance": { "color-scheme": { value: native.portalPreference } } },
    ],
  }));
  native.createFromPath.mockImplementation((path: string) => {
    const icon = {
      path,
      isEmpty: () => false,
      setTemplateImage: native.setTemplateImage,
      resize: vi.fn(() => icon),
    };
    return icon;
  });
});

function layerTray(platform: NodeJS.Platform, activate = Effect.void, quit = Effect.void) {
  return DesktopTray.layer.pipe(
    Layer.provideMerge(DesktopState.layer),
    Layer.provide(
      Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        displayName: "T3 Code (Alpha)",
      } as DesktopEnvironment.DesktopEnvironment["Service"]),
    ),
    Layer.provide(
      Layer.succeed(DesktopAssets.DesktopAssets, {
        iconPaths: Effect.succeed({
          ico: Option.some("icon.ico"),
          png: Option.some("icon.png"),
          icns: Option.none(),
        }),
        resolveResourcePath: (fileName) => Effect.succeedSome(fileName),
      }),
    ),
    Layer.provide(
      Layer.succeed(ElectronApp.ElectronApp, {
        ...ElectronApp.make,
        quit,
      }),
    ),
    Layer.provide(
      Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        prepareCaptureReveal: Effect.void,
        runMainContentsCommand: () => Effect.void,
        dispatchMenuAction: () => Effect.void,
        dispatchSnapShotEvent: () => Effect.void,
        zoomMain: () => Effect.void,
        syncAppearance: Effect.void,
      }),
    ),
  );
}

function click(label: string) {
  const item = native.menu.find((item) => item.label === label);
  assert.isDefined(item?.click);
  item!.click!({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent);
}

it.effect.each([
  { platform: "linux", icon: "trayTemplate.png" },
  { platform: "win32", icon: "trayTemplate.png" },
  { platform: "darwin", icon: "trayTemplate.png" },
] as const)("can reopen and quit from the tray on $platform", ({ platform, icon }) => {
  let opened = 0;
  let quit = 0;
  return Effect.gen(function* () {
    const tray = yield* DesktopTray.DesktopTray;
    const state = yield* DesktopState.DesktopState;
    assert.isFalse(yield* tray.isActive);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* tray.configure;
        yield* tray.configure;
        assert.isTrue(yield* tray.isActive);
        assert.equal(native.createTray.mock.calls.length, 1);
        assert.deepEqual(
          native.createFromPath.mock.calls,
          platform === "darwin" ? [[icon]] : [[icon], ["trayWhite.png"]],
        );
        assert.deepEqual(native.setTemplateImage.mock.calls, platform === "darwin" ? [[true]] : []);

        click("Open T3 Code");
        assert.equal(opened, 1);
        if (platform !== "darwin") {
          native.listeners.get("click")!();
          assert.equal(opened, 2);
        }
        yield* Ref.set(state.quitting, true);
        click("Open T3 Code");
        assert.equal(opened, platform === "darwin" ? 1 : 2);
        click("Quit T3 Code");
        assert.equal(quit, 1);
        assert.equal(native.destroy.mock.calls.length, 0);
      }),
    );
    assert.isFalse(yield* tray.isActive);
    assert.equal(native.destroy.mock.calls.length, 1);
    assert.equal(native.themeListeners.size, 0);
    assert.equal(native.disconnect.mock.calls.length, platform === "linux" ? 1 : 0);
  }).pipe(
    Effect.provide(
      layerTray(
        platform,
        Effect.sync(() => {
          opened += 1;
        }),
        Effect.sync(() => {
          quit += 1;
        }),
      ),
    ),
  );
});

it.effect("keeps normal close behavior when the tray cannot be created", () => {
  native.createTray.mockImplementation(() => {
    throw new Error("No tray available");
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.isFalse(yield* tray.isActive);
    }),
  ).pipe(Effect.provide(layerTray("linux")));
});

it.effect("disposes a partially configured tray before falling back", () => {
  native.setContextMenu.mockImplementation(() => {
    throw new Error("Menu unavailable");
  });
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.isFalse(yield* tray.isActive);
      assert.equal(native.destroy.mock.calls.length, 1);
    }),
  ).pipe(Effect.provide(layerTray("linux")));
});

it.effect("does not enter background mode with an empty icon", () => {
  const icon = { isEmpty: () => true, resize: () => icon };
  native.createFromPath.mockReturnValue(icon);
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.isFalse(yield* tray.isActive);
      assert.equal(native.createTray.mock.calls.length, 0);
    }),
  ).pipe(Effect.provide(layerTray("linux")));
});

function currentIconPath() {
  const calls = native.setImage.mock.calls;
  const image =
    calls.length > 0 ? calls[calls.length - 1]![0] : native.createTray.mock.calls[0]![0];
  return image.path as string;
}

it.effect.each([false, true])("follows the Windows taskbar theme (dark=%s)", (dark) => {
  native.systemDark = dark;
  native.dark = !dark;
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.equal(currentIconPath(), dark ? "trayWhite.png" : "trayTemplate.png");
      native.systemDark = !dark;
      for (const update of native.themeListeners) update();
      assert.equal(currentIconPath(), dark ? "trayTemplate.png" : "trayWhite.png");
      assert.equal(native.createTray.mock.calls.length, 1);
      const updates = native.setImage.mock.calls.length;
      for (const update of native.themeListeners) update();
      assert.equal(native.setImage.mock.calls.length, updates);
    }),
  ).pipe(Effect.provide(layerTray("win32")));
});

it.effect.each([0, 1, 2, 99])("follows the Linux system color scheme %s", (preference) => {
  native.portalPreference = preference;
  native.dark = preference !== 1;
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.equal(currentIconPath(), preference === 1 ? "trayWhite.png" : "trayTemplate.png");
      for (const update of native.themeListeners) update();
      assert.equal(currentIconPath(), preference === 1 ? "trayWhite.png" : "trayTemplate.png");
      native.portalChanged!("org.freedesktop.appearance", "color-scheme", { value: 1 });
      assert.equal(currentIconPath(), "trayWhite.png");
      native.portalChanged!("org.freedesktop.appearance", "contrast", { value: 2 });
      assert.equal(currentIconPath(), "trayWhite.png");
      native.portalChanged!("org.freedesktop.appearance", "color-scheme", { value: 2 });
      assert.equal(currentIconPath(), "trayTemplate.png");
      assert.equal(native.createTray.mock.calls.length, 1);
      assert.deepEqual(native.createTray.mock.calls[0]![0].resize.mock.calls, [[{ width: 24 }]]);
    }),
  ).pipe(Effect.provide(layerTray("linux")));
});

it.effect("keeps the tray available when the Linux appearance portal is unavailable", () => {
  native.dark = true;
  native.portalCall.mockRejectedValue(new Error("Portal unavailable"));
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.isTrue(yield* tray.isActive);
      assert.equal(currentIconPath(), "trayWhite.png");
      native.dark = false;
      for (const update of native.themeListeners) update();
      assert.equal(currentIconPath(), "trayTemplate.png");
    }),
  ).pipe(Effect.provide(layerTray("linux")));
});

it.effect("ignores late portal signals after the tray is disposed", () =>
  Effect.gen(function* () {
    const tray = yield* DesktopTray.DesktopTray;
    yield* Effect.scoped(tray.configure);
    const updates = native.setImage.mock.calls.length;
    native.portalChanged!("org.freedesktop.appearance", "color-scheme", { value: 1 });
    assert.equal(native.setImage.mock.calls.length, updates);
  }).pipe(Effect.provide(layerTray("linux"))),
);
