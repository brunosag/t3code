import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
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
  startStatusNotifier: vi.fn(),
  closeStatusNotifier: vi.fn(),
}));

vi.mock("./LinuxStatusNotifierItem.ts", () => ({
  startStatusNotifierItem: native.startStatusNotifier,
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
import type { StatusNotifierItemOptions } from "./LinuxStatusNotifierItem.ts";

beforeEach(() => {
  vi.resetAllMocks();
  native.menu = [];
  native.listeners.clear();
  native.themeListeners.clear();
  native.dark = false;
  native.systemDark = false;
  native.startStatusNotifier.mockRejectedValue(new Error("No StatusNotifierWatcher"));
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
        resolveResourcePath: (fileName) =>
          Effect.succeedSome(
            fileName.endsWith(".svg")
              ? new URL(`../../resources/${fileName}`, import.meta.url).pathname
              : fileName,
          ),
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
    Layer.provideMerge(NodeServices.layer),
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

it.effect("publishes a symbolic StatusNotifierItem on Linux", () => {
  let opened = 0;
  let quit = 0;
  native.startStatusNotifier.mockResolvedValue(native.closeStatusNotifier);
  return Effect.gen(function* () {
    const tray = yield* DesktopTray.DesktopTray;
    const fileSystem = yield* FileSystem.FileSystem;
    let iconThemePath = "";
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* tray.configure;
        yield* tray.configure;
        assert.isTrue(yield* tray.isActive);
        assert.equal(native.createTray.mock.calls.length, 0);
        assert.equal(native.startStatusNotifier.mock.calls.length, 1);
        const options: StatusNotifierItemOptions = native.startStatusNotifier.mock.calls[0]![0];
        iconThemePath = options.iconThemePath;
        assert.equal(options.iconName, "t3code-tray-symbolic");
        assert.include(
          yield* fileSystem.readFileString(`${iconThemePath}/t3code-tray-symbolic.svg`),
          "<svg",
        );
        options.activate();
        const [openEntry, separator, quitEntry] = options.menu;
        assert.deepEqual(separator, { type: "separator" });
        assert.isTrue(openEntry !== undefined && "click" in openEntry);
        assert.isTrue(quitEntry !== undefined && "click" in quitEntry);
        if (openEntry && "click" in openEntry) openEntry.click();
        if (quitEntry && "click" in quitEntry) quitEntry.click();
        yield* Effect.yieldNow;
        assert.equal(opened, 2);
        assert.equal(quit, 1);
        assert.equal(native.closeStatusNotifier.mock.calls.length, 0);
      }),
    );
    assert.isFalse(yield* tray.isActive);
    assert.equal(native.closeStatusNotifier.mock.calls.length, 1);
    assert.isFalse(yield* fileSystem.exists(iconThemePath));
  }).pipe(
    Effect.provide(
      layerTray(
        "linux",
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

it.effect("falls back to an Electron tray that follows the native theme on Linux", () => {
  native.dark = true;
  return Effect.scoped(
    Effect.gen(function* () {
      const tray = yield* DesktopTray.DesktopTray;
      yield* tray.configure;
      assert.isTrue(yield* tray.isActive);
      assert.equal(currentIconPath(), "trayWhite.png");
      native.dark = false;
      for (const update of native.themeListeners) update();
      assert.equal(currentIconPath(), "trayTemplate.png");
      assert.deepEqual(native.createTray.mock.calls[0]![0].resize.mock.calls, [[{ width: 24 }]]);
    }),
  ).pipe(Effect.provide(layerTray("linux")));
});
