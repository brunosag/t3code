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
}));

vi.mock("electron", () => ({
  Tray: class {
    constructor(icon: unknown) {
      native.createTray(icon);
    }
    destroy = native.destroy;
    setToolTip = native.setToolTip;
    setContextMenu = native.setContextMenu;
    on(event: string, listener: () => void) {
      native.listeners.set(event, listener);
    }
  },
  nativeImage: { createFromPath: native.createFromPath },
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
  const icon = {
    isEmpty: () => false,
    setTemplateImage: native.setTemplateImage,
    resize: () => icon,
  };
  native.createFromPath.mockReturnValue(icon);
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
        resolveResourcePath: () => Effect.succeedSome("trayTemplate.png"),
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
  { platform: "linux", icon: "icon.png" },
  { platform: "win32", icon: "icon.ico" },
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
        assert.deepEqual(native.createFromPath.mock.calls, [[icon]]);
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
