// fork: sends the fork Android app's pushes as infra/relay's FcmClient does. That client can't be
// imported: its WebCrypto service doesn't typecheck under the server's lib, and it needs the
// relay's whole configuration. Keep the request in step with it.
import * as Context from "effect/Context";
import * as KeyFormat from "effect/crypto/KeyFormat";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const HTTP_STAGE_TIMEOUT = "10 seconds";

const decodeServiceAccount = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      project_id: Schema.NonEmptyString,
      client_email: Schema.NonEmptyString,
      private_key: Schema.NonEmptyString,
    }),
  ),
);
const decodeAccessToken = Schema.decodeUnknownEffect(
  Schema.Struct({ access_token: Schema.NonEmptyString }),
);
const decodeFcmError = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({
      details: Schema.optional(
        Schema.Array(
          Schema.Struct({
            "@type": Schema.optional(Schema.String),
            errorCode: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  }),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const isServiceAccount = (contents: string) => Option.isSome(decodeServiceAccount(contents));

export class FcmSendError extends Schema.TaggedError<FcmSendError>()("FcmSendError", {
  operation: Schema.Literals(["configuration", "authorize", "send"]),
  status: Schema.NullOr(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `FCM ${this.operation} failed${this.status === null ? "" : ` (${this.status})`}.`;
  }
}

export class FcmSender extends Context.Service<
  FcmSender,
  {
    readonly send: (input: {
      /** The Firebase service account JSON. */
      readonly serviceAccount: string;
      readonly token: string;
      readonly packageName: string;
      readonly data: Readonly<Record<string, string>>;
      readonly alert: boolean;
    }) => Effect.Effect<{ readonly unregistered: boolean }, FcmSendError>;
  }
>()("t3/mobilePush/FcmSender") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const signature = yield* Signature.Signature;
  let cached:
    | {
        readonly serviceAccount: string;
        readonly accessToken: Effect.Effect<string, FcmSendError>;
        readonly invalidate: Effect.Effect<void>;
      }
    | undefined;

  const authorize = Effect.fn("FcmSender.authorize")(function* (account: {
    readonly client_email: string;
    readonly private_key: string;
  }) {
    const authorizeError = (cause: unknown) =>
      new FcmSendError({ operation: "authorize", status: null, cause });
    const issuedAt = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const encoder = new TextEncoder();
    const segment = (value: unknown) => Base64Url.encode(encoder.encode(encodeJson(value)));
    const unsigned = `${segment({ alg: "RS256", typ: "JWT" })}.${segment({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signed = yield* KeyFormat.decodePrivate(
      KeyFormat.pem(KeyFormat.pkcs8),
      Signature.rsaPkcs1v15Sha256,
      account.private_key,
    ).pipe(
      Effect.flatMap((key) => signature.sign(key, encoder.encode(unsigned))),
      Effect.mapError(authorizeError),
    );
    const response = yield* client
      .execute(
        HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${unsigned}.${Base64Url.encode(signed)}`,
          }),
        ),
      )
      .pipe(Effect.timeout(HTTP_STAGE_TIMEOUT), Effect.mapError(authorizeError));
    if (response.status !== 200)
      return yield* new FcmSendError({ operation: "authorize", status: response.status });
    return yield* response.json.pipe(
      Effect.timeout(HTTP_STAGE_TIMEOUT),
      Effect.flatMap(decodeAccessToken),
      Effect.map((body) => body.access_token),
      Effect.mapError(
        (cause) => new FcmSendError({ operation: "authorize", status: response.status, cause }),
      ),
    );
  });

  return FcmSender.of({
    send: Effect.fn("FcmSender.send")(function* ({ serviceAccount, ...input }) {
      const account = decodeServiceAccount(serviceAccount);
      if (Option.isNone(account))
        return yield* new FcmSendError({ operation: "configuration", status: null });
      if (cached?.serviceAccount !== serviceAccount) {
        const [accessToken, invalidate] = yield* Effect.cachedInvalidateWithTTL(
          authorize(account.value),
          "50 minutes",
        );
        cached = { serviceAccount, accessToken, invalidate };
      }
      const { accessToken, invalidate } = cached;
      const token = yield* accessToken.pipe(Effect.tapError(() => invalidate));
      const response = yield* HttpClientRequest.post(
        `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.value.project_id)}/messages:send`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({
          message: {
            token: input.token,
            data: input.data,
            android: {
              priority: "HIGH",
              ttl: "300s",
              ...(!input.alert ? { collapse_key: "t3-agent-activity" } : {}),
              restricted_package_name: input.packageName,
            },
          },
        }),
        Effect.flatMap(client.execute),
        Effect.timeout(HTTP_STAGE_TIMEOUT),
        Effect.mapError((cause) => new FcmSendError({ operation: "send", status: null, cause })),
      );
      if (response.status >= 200 && response.status < 300) return { unregistered: false };
      if (response.status === 401) yield* invalidate;
      const body = yield* response.json.pipe(
        Effect.timeout(HTTP_STAGE_TIMEOUT),
        Effect.mapError(
          (cause) => new FcmSendError({ operation: "send", status: response.status, cause }),
        ),
      );
      const unregistered = Option.exists(
        decodeFcmError(body),
        (decoded) =>
          decoded.error.details?.some(
            (detail) =>
              detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" &&
              detail.errorCode === "UNREGISTERED",
          ) === true,
      );
      if (unregistered) return { unregistered: true };
      return yield* new FcmSendError({ operation: "send", status: response.status });
    }),
  });
});

export const layer = Layer.effect(FcmSender, make);
