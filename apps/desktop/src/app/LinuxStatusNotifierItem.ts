// @effect-diagnostics globalTimers:off -- Bound session-bus registration at a native callback boundary.
import { Message, MessageType, Variant, sessionBus, type MessageBus } from "dbus-next";

const DBUS = "org.freedesktop.DBus";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const WATCHER = "org.kde.StatusNotifierWatcher";
const ITEM = "org.kde.StatusNotifierItem";
const MENU = "com.canonical.dbusmenu";
const ITEM_PATH = "/StatusNotifierItem";
const MENU_PATH = "/MenuBar";

export type StatusNotifierMenuEntry =
  | { readonly label: string; readonly click: () => void }
  | { readonly type: "separator" };

export interface StatusNotifierItemOptions {
  readonly id: string;
  readonly title: string;
  /** Directory holding `<iconName>.svg`, readable by the panel process. */
  readonly iconThemePath: string;
  /** A `-symbolic` name lets the panel recolor the icon with its own foreground. */
  readonly iconName: string;
  readonly menu: ReadonlyArray<StatusNotifierMenuEntry>;
  readonly activate: () => void;
}

/**
 * Publish a StatusNotifierItem with a themed icon name. Electron's tray only
 * hands the panel pixmaps, which cannot follow the panel's color or scale.
 * Rejects when no StatusNotifierWatcher accepts the item; resolves to `close`.
 */
export async function startStatusNotifierItem(
  options: StatusNotifierItemOptions,
  bus: MessageBus = sessionBus(),
): Promise<() => void> {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    bus.disconnect();
  };
  const failure = new Promise<never>((_, reject) => {
    bus.on("error", (error: Error) => {
      reject(error);
      close();
    });
  });
  void failure.catch(() => undefined);

  const objects: Record<string, { iface: string; properties: Record<string, Variant> }> = {
    [ITEM_PATH]: {
      iface: ITEM,
      properties: {
        Category: new Variant("s", "ApplicationStatus"),
        Id: new Variant("s", options.id),
        Title: new Variant("s", options.title),
        Status: new Variant("s", "Active"),
        IconName: new Variant("s", options.iconName),
        IconThemePath: new Variant("s", options.iconThemePath),
        ToolTip: new Variant("(sa(iiay)ss)", ["", [], options.title, ""]),
        ItemIsMenu: new Variant("b", false),
        Menu: new Variant("o", MENU_PATH),
      },
    },
    [MENU_PATH]: {
      iface: MENU,
      properties: {
        Version: new Variant("u", 3),
        TextDirection: new Variant("s", "ltr"),
        Status: new Variant("s", "normal"),
        IconThemePath: new Variant("as", []),
      },
    },
  };

  // dbusmenu ids: 0 is the root, entries follow in order from 1.
  const menuIds = [0, ...options.menu.map((_, index) => index + 1)];
  const menuProperties = (id: number): Record<string, Variant> => {
    const entry = options.menu[id - 1];
    if (id === 0) return { "children-display": new Variant("s", "submenu") };
    if (!entry) return {};
    if ("type" in entry) return { type: new Variant("s", "separator") };
    return { label: new Variant("s", entry.label), enabled: new Variant("b", true) };
  };
  const menuLayout = (id: number): [number, Record<string, Variant>, Variant[]] => [
    id,
    menuProperties(id),
    id === 0 ? menuIds.slice(1).map((child) => new Variant("(ia{sv}av)", menuLayout(child))) : [],
  ];
  const menuEvent = (id: number, eventId: string) => {
    const entry = options.menu[id - 1];
    if (!closed && eventId === "clicked" && entry && "click" in entry) entry.click();
    return menuIds.includes(id);
  };

  const reply = (message: Message, signature?: string, body?: unknown[]) => {
    bus.send(Message.newMethodReturn(message, signature, body));
    return true;
  };
  const fail = (message: Message, errorName: string, text: string) => {
    // Preserve dbus-next's numeric reply serial; its newError factory has incorrect types.
    const error = Message.newMethodReturn(message, "s", [text]);
    error.type = MessageType.ERROR;
    error.errorName = errorName;
    bus.send(error);
    return true;
  };

  bus.addMethodHandler((message: Message) => {
    const object = objects[message.path];
    if (!object) return false;
    const { signature, body } = message;
    if (message.interface === PROPERTIES) {
      if (message.member === "GetAll" && signature === "s") {
        return reply(message, "a{sv}", [body[0] === object.iface ? object.properties : {}]);
      }
      if (message.member === "Get" && signature === "ss") {
        const value = body[0] === object.iface ? object.properties[body[1]] : undefined;
        if (!value) {
          return fail(message, "org.freedesktop.DBus.Error.InvalidArgs", "No such property.");
        }
        return reply(message, "v", [value]);
      }
      return false;
    }
    if (message.interface !== object.iface) return false;
    if (object.iface === ITEM) {
      if (message.member === "Activate" && signature === "ii") {
        if (!closed) options.activate();
        return reply(message);
      }
      // Panels open the exported menu themselves; the rest are no-ops.
      if (["SecondaryActivate", "ContextMenu"].includes(message.member) && signature === "ii") {
        return reply(message);
      }
      if (message.member === "Scroll" && signature === "is") return reply(message);
      return false;
    }
    switch (`${message.member}(${signature})`) {
      case "GetLayout(iias)":
        return reply(message, "u(ia{sv}av)", [1, menuLayout(body[0])]);
      case "GetGroupProperties(aias)": {
        const ids: number[] = body[0].length ? body[0] : menuIds;
        return reply(message, "a(ia{sv})", [
          ids.filter((id) => menuIds.includes(id)).map((id) => [id, menuProperties(id)]),
        ]);
      }
      case "GetProperty(is)": {
        const value = menuProperties(body[0])[body[1]];
        if (!value) {
          return fail(message, "org.freedesktop.DBus.Error.InvalidArgs", "No such property.");
        }
        return reply(message, "v", [value]);
      }
      case "Event(isvu)":
        menuEvent(body[0], body[1]);
        return reply(message);
      case "EventGroup(a(isvu))": {
        const events: Array<[number, string]> = body[0];
        return reply(message, "ai", [
          events.filter(([id, eventId]) => !menuEvent(id, eventId)).map(([id]) => id),
        ]);
      }
      case "AboutToShow(i)":
        return reply(message, "b", [false]);
      case "AboutToShowGroup(ai)":
        return reply(message, "aiai", [[], []]);
      default:
        return false;
    }
  });

  const register = () =>
    bus.call(
      new Message({
        destination: WATCHER,
        path: "/StatusNotifierWatcher",
        interface: WATCHER,
        member: "RegisterStatusNotifierItem",
        signature: "s",
        // Watchers pair an object path with the caller's unique bus name.
        body: [ITEM_PATH],
      }),
    );
  // The watcher forgets items when it restarts, for example when the panel
  // extension is re-enabled; register again with the new owner.
  bus.on("message", (message: Message) => {
    if (
      !closed &&
      message.type === MessageType.SIGNAL &&
      message.sender === DBUS &&
      message.member === "NameOwnerChanged" &&
      message.body[0] === WATCHER &&
      message.body[2]
    ) {
      void register().catch(() => undefined);
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await bus.call(
          new Message({
            destination: DBUS,
            path: "/org/freedesktop/DBus",
            interface: DBUS,
            member: "AddMatch",
            signature: "s",
            body: [
              `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${WATCHER}'`,
            ],
          }),
        );
        await register();
      })(),
      failure,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("StatusNotifierItem registration timed out.")),
          5_000,
        );
      }),
    ]);
    return close;
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
