// @effect-diagnostics nodeBuiltinImport:off -- Private D-Bus integration fixture, never the user's session bus.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { Message, NameFlag, Variant, sessionBus, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";
import { startStatusNotifierItem } from "./LinuxStatusNotifierItem.ts";

const WATCHER = "org.kde.StatusNotifierWatcher";

it.runIf(NodeChildProcess.spawnSync("dbus-daemon", ["--version"]).status === 0)(
  "publishes a themed icon and menu, and registers again when the watcher restarts",
  async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-tray-dbus-"));
    let daemon: NodeChildProcess.ChildProcess | undefined;
    const buses: MessageBus[] = [];
    let close: (() => void) | undefined;
    try {
      // An explicit config keeps the fixture independent of the host's session.conf.
      const config = NodePath.join(dir, "bus.conf");
      await NodeFSP.writeFile(
        config,
        `<busconfig><type>session</type><listen>unix:path=${NodePath.join(dir, "bus")}</listen>` +
          `<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
      );
      daemon = NodeChildProcess.spawn(
        "dbus-daemon",
        [`--config-file=${config}`, "--nofork", "--nopidfile", "--print-address"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const lines = NodeReadline.createInterface({ input: daemon.stdout! });
      const [address] = await Promise.race([
        NodeEvents.EventEmitter.once(lines, "line"),
        NodeEvents.EventEmitter.once(daemon, "exit").then(() => {
          throw new Error("Private bus failed to start");
        }),
      ]);
      lines.close();
      const connect = () => {
        const bus = sessionBus({ busAddress: String(address) });
        bus.on("error", () => undefined);
        buses.push(bus);
        return bus;
      };
      const options = {
        id: "t3code",
        title: "T3 Code",
        iconThemePath: "/icons",
        iconName: "t3code-tray-symbolic",
        menu: [
          { label: "Open T3 Code", click: vi.fn() },
          { type: "separator" as const },
          { label: "Quit T3 Code", click: vi.fn() },
        ],
        activate: vi.fn(),
      };

      await expect(startStatusNotifierItem(options, connect())).rejects.toThrow();

      const registrations: Array<{ sender: string; service: string }> = [];
      let registered = Promise.withResolvers<void>();
      const startWatcher = async () => {
        const watcher = connect();
        watcher.addMethodHandler((message: Message) => {
          if (message.interface !== WATCHER || message.member !== "RegisterStatusNotifierItem")
            return false;
          registrations.push({ sender: message.sender, service: message.body[0] });
          watcher.send(Message.newMethodReturn(message));
          registered.resolve();
          return true;
        });
        await watcher.requestName(WATCHER, NameFlag.DO_NOT_QUEUE);
        return watcher;
      };
      const watcher = await startWatcher();
      close = await startStatusNotifierItem(options, connect());
      expect(registrations).toEqual([
        { sender: expect.any(String), service: "/StatusNotifierItem" },
      ]);
      const { sender } = registrations[0]!;

      const host = connect();
      const call = async (
        path: string,
        iface: string,
        member: string,
        signature = "",
        body: unknown[] = [],
      ) =>
        (await host.call(
          new Message({ destination: sender, path, interface: iface, member, signature, body }),
        ))!.body;

      const [item] = await call(
        "/StatusNotifierItem",
        "org.freedesktop.DBus.Properties",
        "GetAll",
        "s",
        ["org.kde.StatusNotifierItem"],
      );
      expect(item.IconName.value).toBe("t3code-tray-symbolic");
      expect(item.IconThemePath.value).toBe("/icons");
      const [menuPath] = await call(
        "/StatusNotifierItem",
        "org.freedesktop.DBus.Properties",
        "Get",
        "ss",
        ["org.kde.StatusNotifierItem", "Menu"],
      );

      const [, layout] = await call(menuPath.value, "com.canonical.dbusmenu", "GetLayout", "iias", [
        0,
        -1,
        [],
      ]);
      const children = (layout[2] as Variant<[number, Record<string, Variant>, Variant[]]>[]).map(
        ({ value: [id, properties] }) => [id, properties.label?.value ?? properties.type?.value],
      );
      expect(children).toEqual([
        [1, "Open T3 Code"],
        [2, "separator"],
        [3, "Quit T3 Code"],
      ]);

      await call(menuPath.value, "com.canonical.dbusmenu", "Event", "isvu", [
        3,
        "clicked",
        new Variant("i", 0),
        0,
      ]);
      expect(options.menu[2]!.click).toHaveBeenCalledOnce();
      expect(options.menu[0]!.click).not.toHaveBeenCalled();
      await call("/StatusNotifierItem", "org.kde.StatusNotifierItem", "Activate", "ii", [0, 0]);
      expect(options.activate).toHaveBeenCalledOnce();

      registered = Promise.withResolvers<void>();
      watcher.disconnect();
      await startWatcher();
      await registered.promise;
      expect(registrations.at(-1)).toEqual({ sender, service: "/StatusNotifierItem" });
    } finally {
      close?.();
      buses.forEach((bus) => bus.disconnect());
      if (daemon && daemon.exitCode === null) {
        const exited = NodeEvents.EventEmitter.once(daemon, "exit");
        daemon.kill();
        await exited;
      }
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
);
