// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const runNode = NodeUtil.promisify(NodeChildProcess.execFile);
const decodeFork = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ sessionId: Schema.String })),
);
const decodeRecord = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      uuid: Schema.String,
      attachment: Schema.optionalKey(
        Schema.Struct({
          type: Schema.String,
          surfacedDefinitions: Schema.optionalKey(
            Schema.Array(
              Schema.Struct({ name: Schema.String, sameAs: Schema.optionalKey(Schema.String) }),
            ),
          ),
          nameOnlyAnnouncements: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
);

it("native Claude forks preserve deferred tool references through repeated rewinds", async () => {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-claude-history-"));
  try {
    const cwd = NodePath.join(base, "workspace");
    const config = NodePath.join(base, "config");
    const project = NodePath.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await NodeFSP.mkdir(cwd, { recursive: true });
    await NodeFSP.mkdir(project, { recursive: true });
    const sessionId = "550e8400-e29b-41d4-a716-446655440000";
    const records = [
      { type: "user", uuid: "prompt", message: { role: "user", content: "first" } },
      {
        type: "attachment",
        uuid: "definitions",
        attachment: {
          type: "deferred_tools_delta",
          surfacedDefinitions: [
            {
              name: "mcp__test__lookup",
              definition: { name: "mcp__test__lookup", input_schema: { type: "object" } },
            },
          ],
        },
      },
      {
        type: "assistant",
        uuid: "reply",
        message: { role: "assistant", content: [{ type: "text", text: "first reply" }] },
      },
      {
        type: "attachment",
        uuid: "reconnected",
        attachment: {
          type: "deferred_tools_delta",
          surfacedDefinitions: [
            { name: "mcp__test__lookup", sameAs: "definitions" },
            { name: "mcp__test__external", sameAs: "external-definition" },
          ],
        },
      },
      {
        type: "attachment",
        uuid: "announced",
        attachment: { type: "deferred_tools_record", nameOnlyAnnouncements: ["reconnected"] },
      },
    ];
    await NodeFSP.writeFile(
      NodePath.join(project, `${sessionId}.jsonl`),
      records
        .map((record, index) =>
          JSON.stringify({
            ...record,
            parentUuid: records[index - 1]?.uuid ?? null,
            sessionId,
            cwd,
            isSidechain: false,
            timestamp: "2026-10-02T00:00:00.000Z",
          }),
        )
        .join("\n") + "\n",
    );

    let sourceSessionId = sessionId;
    for (let index = 0; index < 2; index++) {
      const { stdout } = await runNode(
        process.execPath,
        [
          new URL("./claude-history-worker.ts", import.meta.url).pathname,
          "forkSession",
          sourceSessionId,
          JSON.stringify({ dir: cwd }),
        ],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: config } },
      );
      sourceSessionId = decodeFork(stdout).sessionId;
      const lines = (
        await NodeFSP.readFile(NodePath.join(project, `${sourceSessionId}.jsonl`), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => decodeRecord(line));
      const definitions = lines.find((record) =>
        record.attachment?.surfacedDefinitions?.some(
          (entry) => entry.name === "mcp__test__lookup" && entry.sameAs === undefined,
        ),
      );
      const reconnected = lines.find((record) =>
        record.attachment?.surfacedDefinitions?.some(
          (entry) => entry.name === "mcp__test__lookup" && entry.sameAs !== undefined,
        ),
      );
      expect(definitions).toBeDefined();
      expect(reconnected?.attachment?.surfacedDefinitions).toEqual([
        { name: "mcp__test__lookup", sameAs: definitions?.uuid },
        { name: "mcp__test__external", sameAs: "external-definition" },
      ]);
      expect(
        lines.find((record) => record.attachment?.type === "deferred_tools_record")?.attachment
          ?.nameOnlyAnnouncements,
      ).toEqual([reconnected?.uuid]);
    }
    expect((await NodeFSP.readdir(project)).filter((file) => file.endsWith(".jsonl"))).toHaveLength(
      3,
    );
  } finally {
    await NodeFSP.rm(base, { recursive: true, force: true });
  }
});
