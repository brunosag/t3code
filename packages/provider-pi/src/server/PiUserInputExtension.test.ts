// @effect-diagnostics nodeBuiltinImport:off - filesystem fixture for the materialized Pi extension.
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  materializePiUserInputExtension,
  PI_USER_INPUT_EXTENSION_SOURCE,
} from "./PiUserInputExtension.ts";

const directories: string[] = [];

function makeStateDir(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-extension-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

/**
 * The extension is shipped as source text for stock Pi, so it has no importable
 * seam. Stub its imports and evaluate it to exercise the real handler bodies.
 */
function loadExtension(): (pi: unknown) => void {
  const source = PI_USER_INPUT_EXTENSION_SOURCE.replace(/^import .*$/gm, "").replace(
    "export default function t3UserInput(pi) {",
    "function t3UserInput(pi) {",
  );
  const stubs = `
    const Type = new Proxy(function () {}, { get: () => Type, apply: () => ({}) });
    const createReadStream = () => ({ setEncoding() {}, on() {}, destroy() {} });
    const writeSync = () => 0;
    class Socket {}
  `;
  return new Function(`${stubs}${source}; return t3UserInput;`)() as (pi: unknown) => void;
}

function makeFakePi(activeTools: string[]) {
  const handlers = new Map<string, () => void>();
  const active = [...activeTools];
  return {
    handlers,
    active,
    pi: {
      on: (name: string, handler: () => void) => handlers.set(name, handler),
      registerTool: () => {},
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => {
        active.splice(0, active.length, ...names);
      },
    },
  };
}

describe("PiUserInputExtension", () => {
  it("deactivates competing question tools and keeps every other tool active", () => {
    const fake = makeFakePi(["read", "bash", "ask_user", "t3_ask_user"]);
    loadExtension()(fake.pi);

    fake.handlers.get("session_start")?.();

    expect(fake.active).toEqual(["read", "bash", "t3_ask_user"]);
  });

  it("leaves the active tools untouched when no competing question tool is loaded", () => {
    const fake = makeFakePi(["read", "t3_ask_user"]);
    loadExtension()(fake.pi);

    fake.handlers.get("session_start")?.();

    expect(fake.active).toEqual(["read", "t3_ask_user"]);
  });

  it("materializes stable extension source for stock Pi", async () => {
    const stateDir = makeStateDir();
    const paths = await Promise.all(
      Array.from({ length: 8 }, () => materializePiUserInputExtension(stateDir)),
    );
    const first = paths[0]!;

    expect(new Set(paths)).toEqual(new Set([first]));
    expect(await NodeFSP.readFile(first, "utf8")).toBe(PI_USER_INPUT_EXTENSION_SOURCE);
    expect(NodePath.basename(first)).toMatch(/^t3-user-input-[a-f0-9]{16}\.mjs$/);
  });

  it("keeps other extension files while materializing its content-addressed version", async () => {
    const stateDir = makeStateDir();
    const directory = NodePath.join(stateDir, "pi");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, "t3-user-input-old.mjs"), "old");
    await NodeFSP.writeFile(NodePath.join(directory, "user-extension.mjs"), "user");

    const current = await materializePiUserInputExtension(stateDir);
    expect(new Set(await NodeFSP.readdir(directory))).toEqual(
      new Set([NodePath.basename(current), "t3-user-input-old.mjs", "user-extension.mjs"]),
    );
  });
});
