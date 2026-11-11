import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) => Effect.succeed(references.map(() => undefined)),
        invalidate: () => Effect.void,
      }),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("keeps a login's last good reading through failed reads for an hour", () =>
  Effect.gen(function* () {
    let refused = false;
    const sources = yield* UsageLimitSources.make.pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() =>
              HttpClientResponse.fromWeb(
                request,
                request.url.endsWith("/auth-files")
                  ? Response.json({
                      files: [
                        { id: "a.json", auth_index: "a", provider: "codex", email: "a@x.test" },
                      ],
                    })
                  : Response.json({
                      status_code: refused ? 429 : 200,
                      body: JSON.stringify({
                        plan_type: "pro",
                        rate_limit: {
                          primary_window: { used_percent: 40, limit_window_seconds: 18000 },
                        },
                      }),
                    }),
              ),
            ),
          ),
        ),
      ),
    );
    yield* sources.refresh;
    const [good] = yield* sources.current;
    const reading = good?.accounts[0]?.usageLimits;
    expect(reading?.windows.map((window) => window.usedPercent)).toEqual([40]);

    refused = true;
    yield* TestClock.adjust("30 minutes");
    yield* sources.refresh;
    const [carried] = yield* sources.current;
    expect(carried?.accounts[0]).toMatchObject({
      plan: good?.accounts[0]?.plan,
      usageLimits: reading,
    });

    yield* TestClock.adjust("31 minutes");
    yield* sources.refresh;
    const [expired] = yield* sources.current;
    expect(expired?.accounts[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
  }).pipe(
    Effect.provide([
      literalSecrets,
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

const literalSecrets = Layer.succeed(SecretResolver.SecretResolver, {
  read: (references) => Effect.succeed(references.map(() => undefined)),
  invalidate: () => Effect.void,
  label: (provider) => Effect.succeed(provider),
});

const hubUsageReads = { count: 0 };
const hubDisabled = new Set<string>();

it.effect("labels hub accounts with their saved name and image and republishes changes", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const [snapshot] = yield* sources.current;
    expect(
      snapshot?.accounts.map(({ id, email, name, image }) => ({ id, email, name, image })),
    ).toEqual([
      {
        id: "named.json",
        email: "named@example.com",
        name: "Work",
        image: "data:image/webp;base64,AAAA",
      },
      { id: "plain.json", email: "plain@example.com", name: undefined, image: undefined },
    ]);
    const reads = hubUsageReads.count;
    yield* sources.setAccountOrder({
      sourceId: UsageLimitSourceId.make("hub"),
      driver: ProviderDriverKind.make("codex"),
      accountIds: ["plain.json"],
    });
    const [reordered] = yield* sources.current;
    expect(reordered?.accounts.map(({ id, priority }) => ({ id, priority }))).toEqual([
      { id: "named.json", priority: 0 },
      { id: "plain.json", priority: 1 },
    ]);
    expect(hubUsageReads.count).toBe(reads);
    yield* sources.setAccountDisabled({
      sourceId: UsageLimitSourceId.make("hub"),
      accountId: "named.json",
      disabled: true,
    });
    const [switched] = yield* sources.current;
    expect(switched?.accounts.map(({ id, name, disabled }) => ({ id, name, disabled }))).toEqual([
      { id: "named.json", name: "Work", disabled: true },
      { id: "plain.json", name: undefined, disabled: undefined },
    ]);
  }).pipe(
    Effect.provide([
      literalSecrets,
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
            accounts: {
              "named.json": { name: "Work", image: "data:image/webp;base64,AAAA" },
              "missing.json": { name: "Gone" },
            },
          },
        },
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.url.endsWith("/api-call")) hubUsageReads.count += 1;
            if (request.url.endsWith("/auth-files/status") && request.body._tag === "Uint8Array") {
              const patch = JSON.parse(new TextDecoder().decode(request.body.body));
              if (patch.disabled) hubDisabled.add(patch.name);
              else hubDisabled.delete(patch.name);
            }
            return HttpClientResponse.fromWeb(
              request,
              /\/auth-files\/(fields|status)$/.test(request.url)
                ? Response.json({ status: "ok" })
                : request.url.endsWith("/auth-files")
                  ? Response.json({
                      files: ["named", "plain"].map((name) => ({
                        id: `${name}.json`,
                        auth_index: name,
                        provider: "codex",
                        email: `${name}@example.com`,
                        disabled: hubDisabled.has(`${name}.json`),
                        id_token: { chatgpt_account_id: name },
                      })),
                    })
                  : Response.json({ status_code: 200, body: "{}" }),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("reads the hub on its interval with no client open", () =>
  Effect.gen(function* () {
    const reads = yield* Queue.unbounded<void>();
    yield* UsageLimitSources.make.pipe(
      Effect.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Queue.offer(reads, undefined).pipe(
              Effect.as(HttpClientResponse.fromWeb(request, Response.json({ files: [] }))),
            ),
          ),
        ),
      ),
    );
    yield* Queue.take(reads);
    yield* TestClock.adjust("5 minutes");
    yield* Queue.take(reads);
  }).pipe(
    Effect.provide([
      literalSecrets,
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      }),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  ),
);

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            return HttpClientResponse.fromWeb(request, Response.json({ files: [] }));
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
    Effect.scoped,
  );
});
