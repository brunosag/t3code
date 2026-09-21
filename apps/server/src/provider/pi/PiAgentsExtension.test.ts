// @effect-diagnostics nodeBuiltinImport:off - materializes and inspects a standalone Pi extension on disk.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  materializePiAgentsExtension,
  piAgentDefinitionsPath,
  toPiAgentDefinitions,
  withPiAgentsEnvironment,
  writePiAgentDefinitions,
} from "./PiAgentsExtension.ts";

describe("PiAgentsExtension", () => {
  it("drops disabled definitions and keeps the wire fields", () => {
    expect(
      toPiAgentDefinitions([
        {
          name: "scout",
          description: "Recon",
          systemPrompt: "You scout.",
          model: "haiku 4.5",
          thinking: "high",
          tools: ["read", "grep"],
          enabled: true,
        },
        { name: "off", systemPrompt: "You are off.", enabled: false },
      ]),
    ).toEqual([
      {
        name: "scout",
        description: "Recon",
        systemPrompt: "You scout.",
        model: "haiku 4.5",
        thinking: "high",
        tools: ["read", "grep"],
      },
    ]);
  });

  it("writes the definitions file the extension reads", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-agents-"));
    try {
      await writePiAgentDefinitions(stateDir, [
        { name: "scout", systemPrompt: "You scout.", enabled: true },
      ]);
      expect(JSON.parse(NodeFS.readFileSync(piAgentDefinitionsPath(stateDir), "utf8"))).toEqual([
        { name: "scout", systemPrompt: "You scout." },
      ]);
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("materializes an extension and points the environment at the definitions file", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-agents-"));
    try {
      const extensionPath = await materializePiAgentsExtension(stateDir);
      expect(NodeFS.readFileSync(extensionPath, "utf8")).toContain("subagents:rpc:registerAgents");

      const env = withPiAgentsEnvironment({ PATH: "/bin" }, piAgentDefinitionsPath(stateDir));
      expect(env.T3_PI_AGENTS_PATH).toBe(piAgentDefinitionsPath(stateDir));
      expect(env.PATH).toBe("/bin");
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
