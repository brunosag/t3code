import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as KeyFormat from "effect/crypto/KeyFormat";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as FcmSender from "./FcmSender.ts";
import * as MobilePush from "./MobilePush.ts";

const NOW = "2026-11-16T12:00:00.000Z";
const THREAD_ID = ThreadId.make("push-thread");

const preferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const device = {
  deviceId: "phone",
  token: "token-1",
  packageName: "com.bsag.t3code",
  label: "Phone",
  preferences,
};

function state(phase: RelayAgentActivityState["phase"]): RelayAgentActivityState {
  return {
    environmentId: EnvironmentId.make("push-environment"),
    threadId: THREAD_ID,
    projectTitle: "Project",
    threadTitle: "Thread",
    modelTitle: "Model",
    phase,
    headline: phase,
    updatedAt: NOW,
    deepLink: `/threads/${THREAD_ID}`,
  };
}

type Sent = Parameters<FcmSender.FcmSender["Service"]["send"]>[0];

const setup = Effect.fnUntraced(function* (options: { readonly unregistered?: boolean } = {}) {
  yield* TestClock.setTime(Date.parse(NOW));
  const sent: Sent[] = [];
  const sender = FcmSender.FcmSender.of({
    send: (input) =>
      Effect.sync(() => {
        sent.push(input);
        return { unregistered: options.unregistered === true };
      }),
  });
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const start = Layer.build(MobilePush.layer).pipe(
    Effect.provideService(FcmSender.FcmSender, sender),
    Effect.map(Context.get(MobilePush.MobilePush)),
  );
  const writeCredentials = fileSystem.writeFileString(
    path.join(config.stateDir, "fcm-service-account.json"),
    JSON.stringify({ project_id: "p", client_email: "e@example.test", private_key: "k" }),
  );
  const readDevices = fileSystem
    .readFileString(path.join(config.stateDir, "mobile-push-devices.json"))
    .pipe(Effect.map((contents) => JSON.parse(contents) as Array<{ deviceId: string }>));
  return { sent, start, writeCredentials, readDevices };
});

const layerTest = ServerConfig.layerTest(process.cwd(), { prefix: "mobile-push-" }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerDigest)),
  Layer.provideMerge(Layer.succeed(HostProcess.Platform, "linux")),
);

it.effect("keeps registrations across a restart until unregistered", () =>
  Effect.gen(function* () {
    const { start, readDevices } = yield* setup();
    const push = yield* start;
    yield* push.register(device);
    yield* push.register({ ...device, deviceId: "tablet", label: "Tablet" });
    const restarted = yield* start;
    yield* restarted.unregister({ deviceId: "phone" });
    assert.deepEqual(
      (yield* readDevices).map((stored) => stored.deviceId),
      ["tablet"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("sends nothing until the server has Firebase credentials", () =>
  Effect.gen(function* () {
    const { sent, start, writeCredentials } = yield* setup();
    const push = yield* start;
    const result = yield* push.register(device);
    assert.isFalse(result.deliveryAvailable);
    yield* push.publish({ threadId: THREAD_ID, state: state("running") });
    yield* push.drain;
    assert.equal(sent.length, 0);

    yield* writeCredentials;
    assert.isTrue((yield* push.register(device)).deliveryAvailable);
    yield* push.drain;
    assert.equal(sent[0]?.data.activity_phase, "running");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays the card on registration and alerts a completed run", () =>
  Effect.gen(function* () {
    const { sent, start, writeCredentials } = yield* setup();
    yield* writeCredentials;
    const push = yield* start;
    yield* push.register(device);
    yield* push.drain;
    assert.deepInclude(sent[0], { token: "token-1", packageName: "com.bsag.t3code", alert: false });
    assert.deepInclude(sent[0]?.data, {
      t3_kind: "agent_activity",
      device_id: "phone",
      user_id: "t3-local",
      updated_at: String(Date.parse(NOW)),
      active: "false",
    });

    yield* push.publish({ threadId: THREAD_ID, state: state("running") });
    // A relay retry hands over the same state again.
    yield* push.publish({ threadId: THREAD_ID, state: state("running") });
    yield* push.drain;
    assert.equal(sent.length, 2);
    assert.isFalse(sent[1]?.alert);
    assert.deepInclude(sent[1]?.data, {
      active: "true",
      activity_phase: "running",
      activity_title: "1 active agent",
      activity_line_0: "Working\tThread\tProject",
    });
    assert.notProperty(sent[1]?.data, "alert_id");

    yield* push.publish({ threadId: THREAD_ID, state: state("completed") });
    yield* push.drain;
    assert.isTrue(sent[2]?.alert);
    assert.deepInclude(sent[2]?.data, {
      active: "false",
      activity_title: "Agent work completed",
      alert_title: "Thread",
      alert_body: "Done: Project",
      alert_path: `/threads/${THREAD_ID}`,
      alert_group: JSON.stringify(["push-environment", THREAD_ID]),
    });
    assert.match(sent[2]?.data.alert_id ?? "", /^[0-9a-f]{64}$/);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("forgets a device whose token Firebase no longer knows", () =>
  Effect.gen(function* () {
    const { sent, start, writeCredentials, readDevices } = yield* setup({ unregistered: true });
    yield* writeCredentials;
    const push = yield* start;
    yield* push.register(device);
    yield* push.drain;
    assert.equal(sent.length, 1);
    assert.deepEqual(yield* readDevices, []);
    yield* push.publish({ threadId: THREAD_ID, state: state("running") });
    yield* push.drain;
    assert.equal(sent.length, 1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("signs Firebase's token request and reports an unregistered token", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const signature = yield* Signature.Signature;
    const keys = yield* signature.generateKeyPair(Signature.rsaPkcs1v15Sha256);
    const requests: Array<{ url: string; authorization?: string; body: string }> = [];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push({
          url: request.url,
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          body:
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
        });
        if (request.url === "https://oauth2.googleapis.com/token") {
          return HttpClientResponse.fromWeb(request, Response.json({ access_token: "access" }));
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            {
              error: {
                status: "NOT_FOUND",
                details: [
                  {
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    errorCode: "UNREGISTERED",
                  },
                ],
              },
            },
            { status: 404 },
          ),
        );
      }),
    );
    const sender = yield* Layer.build(FcmSender.layer).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.map(Context.get(FcmSender.FcmSender)),
    );
    const result = yield* sender.send({
      serviceAccount: JSON.stringify({
        project_id: "fork-project",
        client_email: "push@example.test",
        private_key: yield* KeyFormat.encode(KeyFormat.pem(KeyFormat.pkcs8), keys.privateKey),
      }),
      token: "device-token",
      packageName: "com.bsag.t3code",
      alert: false,
      data: { t3_kind: "agent_activity" },
    });
    assert.isTrue(result.unregistered);

    const assertion = new URLSearchParams(requests[0]?.body).get("assertion") ?? "";
    const [header = "", claims = "", signed = ""] = assertion.split(".");
    assert.isTrue(
      yield* signature.verify(
        keys.publicKey,
        Result.getOrThrow(Base64Url.decode(signed)),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    );
    const issuedAt = Date.parse(NOW) / 1000;
    assert.deepEqual(JSON.parse(Result.getOrThrow(Base64Url.decodeString(claims))), {
      iss: "push@example.test",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: issuedAt + 3600,
    });
    assert.deepInclude(requests[1], {
      url: "https://fcm.googleapis.com/v1/projects/fork-project/messages:send",
      authorization: "Bearer access",
    });
    assert.deepEqual(JSON.parse(requests[1]?.body ?? ""), {
      message: {
        token: "device-token",
        data: { t3_kind: "agent_activity" },
        android: {
          priority: "HIGH",
          ttl: "300s",
          collapse_key: "t3-agent-activity",
          restricted_package_name: "com.bsag.t3code",
        },
      },
    });
  }).pipe(Effect.provide(NodeCrypto.layerSignature)),
);
