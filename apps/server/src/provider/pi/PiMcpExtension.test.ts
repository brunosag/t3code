// @effect-diagnostics nodeBuiltinImport:off - fixture MCP HTTP server and materialized extension file for Pi.
/**
 * PiMcpExtension tests — the materialized extension is the only MCP client Pi
 * has, so these cover the wire contract (initialize, session id, negotiated
 * protocol version), capability filtering, and result mapping. The last test
 * drives the real T3 preview toolkit over a real MCP HTTP server.
 */
import { describe, expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as DeviceService from "../../device/DeviceService.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../mcp/PreviewAutomationBroker.ts";
import {
  materializePiMcpExtension,
  PI_MCP_ENV,
  renderPiMcpExtensionSource,
} from "./PiMcpExtension.ts";

interface FakeToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: { readonly type?: unknown };
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<Record<string, unknown>>;
    readonly details: unknown;
  }>;
}

interface FakePi {
  readonly tools: Map<string, FakeToolDefinition>;
  readonly active: Array<string>;
  readonly handlers: Map<string, FakeHandler>;
  readonly pi: {
    readonly registerTool: (definition: FakeToolDefinition) => void;
    readonly on: (event: string, handler: FakeHandler) => void;
    readonly getActiveTools: () => Array<string>;
    readonly setActiveTools: (names: ReadonlyArray<string>) => void;
  };
}

type FakeHandler = (event?: unknown, ctx?: unknown) => unknown;

function makeFakePi(activeTools: ReadonlyArray<string> = []): FakePi {
  const tools = new Map<string, FakeToolDefinition>();
  const active = [...activeTools];
  const handlers = new Map<string, FakeHandler>();
  return {
    tools,
    active,
    handlers,
    pi: {
      registerTool: (definition) => {
        tools.set(definition.name, definition);
        active.push(definition.name);
      },
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      getActiveTools: () => [...active],
      setActiveTools: (names) => {
        active.splice(0, active.length, ...names);
      },
    },
  };
}

/**
 * The extension ships as source text for stock Pi, so it has no importable
 * seam. It imports nothing, so evaluating it exercises the real factory.
 */
function loadExtension(): (pi: unknown) => Promise<void> {
  const source = renderPiMcpExtensionSource().replace(
    "export default async function t3McpToolkit(pi) {",
    "async function t3McpToolkit(pi) {",
  );
  return new Function(`${source}; return t3McpToolkit;`)() as (pi: unknown) => Promise<void>;
}

interface RecordedRequest {
  readonly method: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly params: unknown;
}

/** Minimal Streamable HTTP MCP server: initialize, initialized, tools/list, tools/call. */
function makeFakeMcpServer(options: {
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly callResult?: Record<string, unknown>;
  readonly initStatus?: number;
  readonly callStatus?: number;
}) {
  const requests: Array<RecordedRequest> = [];
  let tools = [...(options.tools ?? [])];
  let callResult = options.callResult ?? { content: [{ type: "text", text: "done" }] };
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(body) as {
        readonly id?: string | number;
        readonly method: string;
        readonly params?: unknown;
      };
      requests.push({ method: message.method, headers: request.headers, params: message.params });
      const reply = (payload: Record<string, unknown>, extraHeaders?: Record<string, string>) => {
        const text = JSON.stringify(payload);
        response.writeHead(200, {
          "content-type": "application/json",
          ...extraHeaders,
        });
        response.end(text);
      };
      if (message.method === "initialize") {
        if (options.initStatus !== undefined) {
          response.writeHead(options.initStatus).end();
          return;
        }
        reply(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "t3-test", version: "1" },
            },
          },
          { "mcp-session-id": "session-1", "mcp-protocol-version": "2025-06-18" },
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        reply({ jsonrpc: "2.0", id: message.id, result: { tools } });
        return;
      }
      if (message.method === "tools/call") {
        if (options.callStatus !== undefined) {
          response.writeHead(options.callStatus).end();
          return;
        }
        reply({ jsonrpc: "2.0", id: message.id, result: callResult });
        return;
      }
      reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unknown method" } });
    });
  });

  return {
    requests,
    setTools: (next: ReadonlyArray<Record<string, unknown>>) => {
      tools = [...next];
    },
    setCallResult: (next: Record<string, unknown>) => {
      callResult = next;
    },
    listen: async () => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("fake MCP server has no TCP address");
      }
      return `http://127.0.0.1:${address.port}/mcp`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const previewTool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} description. And more.`,
  inputSchema: {
    type: "object",
    properties: { tabId: { type: "string" } },
    additionalProperties: false,
  },
  annotations: { title: name },
  ...extra,
});

/** Runs `body` with exactly the MCP env given, restoring the previous values afterwards. */
async function withEnv<T>(
  values: Readonly<Record<string, string | undefined>>,
  body: () => Promise<T>,
): Promise<T> {
  const previous = Object.keys(values).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** The exact MCP env T3 hands a Pi process for a thread with a preview credential. */
function mcpEnv(endpoint: string | undefined, capabilities: string | undefined, token = "token-1") {
  return {
    [PI_MCP_ENV.endpoint]: endpoint,
    [PI_MCP_ENV.bearerToken]: token,
    [PI_MCP_ENV.capabilities]: capabilities,
  };
}

async function registeredToolNames(capabilities: string): Promise<Array<string>> {
  const fake = makeFakeMcpServer({
    tools: [
      previewTool("preview_status"),
      previewTool("preview_snapshot"),
      previewTool("device_list"),
      previewTool("list_thread_pull_requests"),
      previewTool("mystery_tool"),
    ],
  });
  const endpoint = await fake.listen();
  try {
    const harness = makeFakePi();
    await withEnv(mcpEnv(endpoint, capabilities), () => loadExtension()(harness.pi));
    return [...harness.tools.keys()];
  } finally {
    await fake.close();
  }
}

describe("PiMcpExtension materialization", () => {
  const directories: Array<string> = [];

  const makeStateDir = () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-mcp-"));
    directories.push(directory);
    return directory;
  };

  it("writes a private content-addressed extension with the env names substituted", async () => {
    const stateDir = makeStateDir();
    const extensionPath = await materializePiMcpExtension(stateDir);

    expect(NodePath.basename(extensionPath)).toMatch(/^t3-mcp-[0-9a-f]{16}\.mjs$/);
    expect(NodeFS.statSync(extensionPath).mode & 0o777).toBe(0o600);
    const source = await NodeFSP.readFile(extensionPath, "utf8");
    expect(source).toBe(renderPiMcpExtensionSource());
    expect(source).not.toContain("__T3_MCP");
    expect(source).toContain(PI_MCP_ENV.endpoint);
    expect(source).toContain(PI_MCP_ENV.bearerToken);
    expect(source).toContain(PI_MCP_ENV.capabilities);
    // The extension must never write to stdout: that is Pi's RPC channel.
    expect(source).not.toMatch(/console\.log|process\.stdout/);
  });

  it("reuses the same file for the same source", async () => {
    const stateDir = makeStateDir();
    const first = await materializePiMcpExtension(stateDir);
    const second = await materializePiMcpExtension(stateDir);
    expect(second).toBe(first);
    expect(await NodeFSP.readdir(NodePath.join(stateDir, "pi"))).toHaveLength(1);
  });
});

describe("PiMcpExtension tool registration", () => {
  it("deactivates the browser tools it replaces once a preview tool is registered", async () => {
    const fake = makeFakeMcpServer({ tools: [previewTool("preview_status")] });
    const endpoint = await fake.listen();
    try {
      const harness = makeFakePi([
        "read",
        "bash",
        "frontend_open",
        "frontend_act",
        "frontend_screenshot",
        "frontend_console",
        "frontend_eval",
        "dev_start",
      ]);
      await withEnv(mcpEnv(endpoint, "preview"), () => loadExtension()(harness.pi));
      harness.handlers.get("session_start")?.();

      expect(harness.active).toEqual(["read", "bash", "dev_start", "preview_status"]);
    } finally {
      await fake.close();
    }
  });

  it("keeps the user's browser tools when no preview tool registered", async () => {
    const fake = makeFakeMcpServer({ tools: [previewTool("preview_status")] });
    const endpoint = await fake.listen();
    try {
      const deviceOnly = makeFakePi(["frontend_open", "frontend_act"]);
      await withEnv(mcpEnv(endpoint, "device"), () => loadExtension()(deviceOnly.pi));
      expect(deviceOnly.handlers.has("session_start")).toBe(false);
      expect(deviceOnly.active).toEqual(["frontend_open", "frontend_act"]);
    } finally {
      await fake.close();
    }

    const broken = makeFakeMcpServer({ initStatus: 500 });
    const brokenEndpoint = await broken.listen();
    const stderr = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      const failed = makeFakePi(["frontend_open"]);
      await withEnv(mcpEnv(brokenEndpoint, "preview"), () => loadExtension()(failed.pi));
      expect(failed.handlers.has("session_start")).toBe(false);
      expect(failed.active).toEqual(["frontend_open"]);
    } finally {
      process.stderr.write = stderr;
      await broken.close();
    }
  });

  it("registers only granted capabilities and never unknown toolkit names", async () => {
    expect(await registeredToolNames("preview")).toEqual(["preview_status", "preview_snapshot"]);
    expect(await registeredToolNames("device,pull-requests")).toEqual([
      "device_list",
      "list_thread_pull_requests",
    ]);
    expect(await registeredToolNames("preview,pull-requests")).toEqual([
      "preview_status",
      "preview_snapshot",
      "list_thread_pull_requests",
    ]);
  });

  it("registers nothing without a credential and reports a failed handshake on stderr", async () => {
    const harness = makeFakePi();
    await withEnv(
      { [PI_MCP_ENV.endpoint]: undefined, [PI_MCP_ENV.bearerToken]: undefined },
      async () => {
        await loadExtension()(harness.pi);
      },
    );
    expect([...harness.tools.keys()]).toEqual([]);

    const broken = makeFakeMcpServer({ initStatus: 500 });
    const endpoint = await broken.listen();
    const stderr: Array<string> = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const failing = makeFakePi();
      await withEnv(mcpEnv(endpoint, "preview"), () => loadExtension()(failing.pi));
      expect([...failing.tools.keys()]).toEqual([]);
    } finally {
      process.stderr.write = originalWrite;
      await broken.close();
    }
    expect(stderr.join("")).toContain("could not load T3 tools");
  });

  it("carries the server description, schema, and entry-point guideline onto the Pi tool", async () => {
    const fake = makeFakeMcpServer({ tools: [previewTool("preview_status")] });
    const endpoint = await fake.listen();
    try {
      const harness = makeFakePi();
      await withEnv(mcpEnv(endpoint, "preview"), () => loadExtension()(harness.pi));
      const definition = harness.tools.get("preview_status");
      expect(definition?.description).toBe("preview_status description. And more.");
      expect(definition?.label).toBe("preview_status");
      expect(definition?.parameters).toMatchObject({ type: "object" });
      expect(definition?.promptSnippet).toBe("preview_status description.");
      expect(definition?.promptGuidelines?.[0]).toContain("call preview_status first");
      expect(harness.tools.get("preview_snapshot")).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

describe("PiMcpExtension wire contract", () => {
  it("initializes once, then carries the session id and negotiated protocol version", async () => {
    const fake = makeFakeMcpServer({ tools: [previewTool("preview_status")] });
    const endpoint = await fake.listen();
    try {
      const harness = makeFakePi();
      await withEnv(mcpEnv(endpoint, "preview"), () => loadExtension()(harness.pi));

      expect(fake.requests.map((request) => request.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      for (const request of fake.requests) {
        expect(request.headers.authorization).toBe("Bearer token-1");
        expect(String(request.headers.accept)).toContain("application/json");
        expect(String(request.headers.accept)).toContain("text/event-stream");
      }
      const [initialize, initialized, listed] = fake.requests;
      expect(initialize?.headers["mcp-session-id"]).toBeUndefined();
      expect(initialize?.params).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(initialized?.headers["mcp-session-id"]).toBe("session-1");
      expect(listed?.headers["mcp-session-id"]).toBe("session-1");
      expect(listed?.headers["mcp-protocol-version"]).toBe("2025-06-18");
    } finally {
      await fake.close();
    }
  });

  it("maps text and image results and forwards the tool arguments", async () => {
    const fake = makeFakeMcpServer({
      tools: [previewTool("preview_snapshot")],
      callResult: {
        content: [
          { type: "text", text: "url" },
          { type: "image", data: "cG5n", mimeType: "image/png" },
        ],
      },
    });
    const endpoint = await fake.listen();
    try {
      const harness = makeFakePi();
      await withEnv(mcpEnv(endpoint, "preview"), () => loadExtension()(harness.pi));
      const definition = harness.tools.get("preview_snapshot");
      const result = await definition?.execute("call-1", { includeImage: true });
      expect(result?.content).toEqual([
        { type: "text", text: "url" },
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ]);
      const call = fake.requests.find((request) => request.method === "tools/call");
      expect(call?.params).toEqual({
        name: "preview_snapshot",
        arguments: { includeImage: true },
      });
    } finally {
      await fake.close();
    }
  });

  it("throws on a tool error, an expired credential, and a transport failure", async () => {
    const failing = makeFakeMcpServer({
      tools: [previewTool("preview_click")],
      callResult: { isError: true, content: [{ type: "text", text: "no preview tab" }] },
    });
    const endpoint = await failing.listen();
    try {
      const harness = makeFakePi();
      await withEnv(mcpEnv(endpoint, "preview"), () => loadExtension()(harness.pi));
      const definition = harness.tools.get("preview_click");
      await expect(definition?.execute("call-1", {})).rejects.toThrow("no preview tab");
    } finally {
      await failing.close();
    }

    const expired = makeFakeMcpServer({
      tools: [previewTool("preview_click")],
      callStatus: 401,
    });
    const expiredEndpoint = await expired.listen();
    try {
      const harness = makeFakePi();
      await withEnv(mcpEnv(expiredEndpoint, "preview"), () => loadExtension()(harness.pi));
      const definition = harness.tools.get("preview_click");
      await expect(definition?.execute("call-1", {})).rejects.toThrow(/credential/);
    } finally {
      await expired.close();
    }

    // A live server registrations the tool; the endpoint dies before the call,
    // which is what a restarted or unreachable T3 looks like mid-session.
    const dead = makeFakeMcpServer({ tools: [previewTool("preview_click")] });
    const deadEndpoint = await dead.listen();
    const harness = makeFakePi();
    await withEnv(mcpEnv(deadEndpoint, "preview"), () => loadExtension()(harness.pi));
    const definition = harness.tools.get("preview_click");
    await dead.close();
    await expect(definition?.execute("call-1", {})).rejects.toThrow(/fetch failed|ECONNREFUSED/);
  });
});

const environmentId = EnvironmentId.make("environment-pi-mcp-test");
const threadId = ThreadId.make("thread-pi-mcp-test");

const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});
/** The registry only uses the address to render a credential's endpoint; the test server's real port is not known yet. */
const fakeMcpAddress = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

const RegistryLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make({ livenessWindowMs: 60_000 }),
).pipe(
  Layer.provide(Layer.succeed(HttpServer.HttpServer)(fakeMcpAddress)),
  Layer.provide(Layer.succeed(ServerEnvironment.ServerEnvironment)(fakeEnvironment)),
  Layer.provide(NodeServices.layer),
);

/**
 * Everything the real server provides around the MCP endpoint: the thread
 * credential registry behind its auth middleware, plus the broker, config, and
 * platform services the preview toolkit handlers need. Device and pull-request
 * handlers are only registered, never called, so their services are mocks.
 */
const McpHostLayer = Layer.mergeAll(
  RegistryLayer,
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: () => Effect.succeed(Option.none()),
  }),
  Layer.mock(OrchestrationEngineService)({}),
).pipe(
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-mcp-extension-" })),
  Layer.provideMerge(NodeServices.layer),
);

const snapshotResult = {
  url: "http://example.test/",
  title: "Example",
  loading: false,
  visibleText: "Example",
  interactiveElements: [],
  accessibilityTree: {},
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: {
    mimeType: "image/png",
    data: Buffer.from("png").toString("base64"),
    width: 10,
    height: 5,
  },
};

it.effect("drives the real preview toolkit with a real thread credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(McpHttpServer.layer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpServer = yield* HttpServer.HttpServer;
      if (httpServer.address._tag !== "TcpAddress") {
        return yield* Effect.die(new Error("test MCP server has no TCP address"));
      }
      const endpoint = `http://127.0.0.1:${httpServer.address.port}/mcp`;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const issued = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("pi-test"),
        capabilities: new Set(["preview"]),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const inputs: Array<unknown> = [];
      const events = yield* broker.connect({ clientId: "pi-mcp-test-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        inputs.push(event.request.input);
        return broker.respond({
          clientId: "pi-mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: snapshotResult,
        });
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);

      const harness = makeFakePi();
      yield* Effect.promise(() =>
        withEnv(mcpEnv(endpoint, "preview", token), () => loadExtension()(harness.pi)),
      );

      const names = [...harness.tools.keys()];
      expect(names).toContain("preview_status");
      expect(names).toContain("preview_snapshot");
      // The server advertises device and pull-request tools to every credential,
      // so the registered set also proves the capability filter held.
      expect(names.every((name) => name.startsWith("preview_"))).toBe(true);
      expect(names).not.toContain("device_list");
      expect(names).not.toContain("link_pull_request");

      const definition = harness.tools.get("preview_snapshot");
      expect(definition?.parameters).toMatchObject({ type: "object" });
      const result = yield* Effect.promise(() =>
        definition!.execute("call-1", { includeImage: true }),
      );
      expect(inputs).toHaveLength(1);
      expect(result.content).toContainEqual({
        type: "image",
        data: Buffer.from("png").toString("base64"),
        mimeType: "image/png",
      });
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => String(part.text))
        .join("\n");
      expect(text).toContain("Example");
    }),
  ).pipe(Effect.provide(Layer.merge(McpHostLayer, NodeHttpServer.layerTest))),
);
