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

describe("PiUserInputExtension", () => {
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
