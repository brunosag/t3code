// @effect-diagnostics nodeBuiltinImport:off - materializes and inspects a standalone Pi extension on disk.
import { describe, expect, it } from "@effect/vitest";
// vi.mock's module registry lives in vite-plus/test, not in @effect/vitest's
// re-export of the runner API.
import { vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  materializePiAgentsExtension,
  PI_AGENTS_ENV,
  piAgentDefinitionsPath,
  toPiAgentDefinitions,
  withPiAgentsEnvironment,
  writePiAgentDefinitions,
} from "./PiAgentsExtension.ts";

// The extension reports registration outcomes over fd 3. Swallow the real
// write (there is no channel in a test process) while recording every call, so
// the reports themselves can be asserted.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: vi.fn(() => {
      throw new Error("EBADF");
    }),
  };
});

const reports = () =>
  vi.mocked(NodeFS.writeSync).mock.calls.map((call) => JSON.parse(String(call[1])));

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
          extensions: false,
          skills: ["frontend-testing"],
          maxTurns: 20,
          promptMode: "append",
          tools: ["read", "grep", "ext:pi-web-access/web_search"],
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
        extensions: false,
        skills: ["frontend-testing"],
        maxTurns: 20,
        promptMode: "append",
        tools: ["read", "grep", "ext:pi-web-access/web_search"],
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
      const source = NodeFS.readFileSync(extensionPath, "utf8");
      expect(source).toContain("subagents:rpc:registerAgents");
      // T3's roster replaces Pi's own agent files rather than merging with them.
      expect(source).toContain("exclusive: true");
      // Every push is acknowledged over the reply envelope, and the absence of
      // that ack is reported instead of passing unnoticed.
      expect(source).toContain('":reply:"');
      expect(source).toContain("ACK_TIMEOUT_MS");
      expect(source).toContain('"subagent.registration"');
      // The settled-run bridge: T3 only sees a background run end when the
      // extension suppresses its completion notification.
      expect(source).toContain("subagents:completed");
      expect(source).toContain("subagents:failed");
      expect(source).toContain("subagent.activity");

      const env = withPiAgentsEnvironment({ PATH: "/bin" }, piAgentDefinitionsPath(stateDir));
      expect(env.T3_PI_AGENTS_PATH).toBe(piAgentDefinitionsPath(stateDir));
      expect(env.PATH).toBe("/bin");
    } finally {
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("pushes the roster exclusively and reports every registration outcome", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-agents-"));
    const previousDefinitionsPath = process.env[PI_AGENTS_ENV.definitionsPath];
    vi.useFakeTimers();
    try {
      await writePiAgentDefinitions(stateDir, [
        { name: "scout", systemPrompt: "You scout.", enabled: true },
        { name: "reviewer", systemPrompt: "You review.", enabled: true },
      ]);
      process.env[PI_AGENTS_ENV.definitionsPath] = piAgentDefinitionsPath(stateDir);
      const extensionPath = await materializePiAgentsExtension(stateDir);
      const extension = (await import(NodeURL.pathToFileURL(extensionPath).href)) as {
        default: (pi: unknown) => void;
      };

      const listeners = new Map<string, Set<(data: unknown) => void>>();
      const lifecycle = new Map<string, () => void>();
      const pushes: Array<{ channel: string; data: Record<string, unknown> }> = [];
      const emitTo = (channel: string, data: unknown) => {
        // Snapshot: a reply handler may subscribe another listener.
        for (const handler of Array.from(listeners.get(channel) ?? [])) handler(data);
      };
      extension.default({
        on: (event: string, handler: () => void) => lifecycle.set(event, handler),
        events: {
          on: (channel: string, handler: (data: unknown) => void) => {
            if (!listeners.has(channel)) listeners.set(channel, new Set());
            listeners.get(channel)!.add(handler);
            return () => listeners.get(channel)!.delete(handler);
          },
          emit: (channel: string, data: unknown) => {
            pushes.push({ channel, data: data as Record<string, unknown> });
          },
        },
      });

      lifecycle.get("session_start")!();
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.channel).toBe("subagents:rpc:registerAgents");
      const payload = pushes[0]!.data as {
        requestId: string;
        agents: unknown[];
        exclusive: boolean;
      };
      expect(payload.exclusive).toBe(true);
      expect(payload.agents).toMatchObject([{ name: "scout" }, { name: "reviewer" }]);

      // Pi's handler answers with the count it parsed and echoes the claim it
      // honored: one report, all clear.
      emitTo(`subagents:rpc:registerAgents:reply:${payload.requestId}`, {
        success: true,
        data: { count: 2, exclusive: true },
      });
      expect(reports()).toEqual([
        { type: "subagent.registration", requestId: payload.requestId, ok: true, count: 2 },
      ]);

      // A handler that accepts the payload but predates the exclusive claim
      // would merge Pi's agent files back in — reported, not swallowed.
      vi.mocked(NodeFS.writeSync).mockClear();
      emitTo("subagents:ready", {});
      const second = pushes[1]!.data as { requestId: string };
      emitTo(`subagents:rpc:registerAgents:reply:${second.requestId}`, {
        success: true,
        data: { count: 2 },
      });
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({
        ok: false,
        error: expect.stringContaining("without honoring"),
      });

      // A registration with no handler behind it (the event fires on both
      // session_start and subagents:ready) must surface as a warning, and only
      // once even if it happens again.
      vi.mocked(NodeFS.writeSync).mockClear();
      emitTo("subagents:ready", {});
      vi.advanceTimersByTime(5_001);
      expect(reports()).toHaveLength(1);
      expect(reports()[0]).toMatchObject({
        ok: false,
        error: expect.stringContaining("never acknowledged"),
      });

      vi.mocked(NodeFS.writeSync).mockClear();
      emitTo("subagents:ready", {});
      vi.advanceTimersByTime(5_001);
      expect(reports()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      if (previousDefinitionsPath === undefined) delete process.env[PI_AGENTS_ENV.definitionsPath];
      else process.env[PI_AGENTS_ENV.definitionsPath] = previousDefinitionsPath;
      NodeFS.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
