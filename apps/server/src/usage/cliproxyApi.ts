import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";

import { codexPlanLabel } from "../provider/CodexProvider.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

/** A hub with its management key already read from wherever the setting keeps it. */
export interface CliproxyHub {
  readonly url: UsageLimitSourceConfig["url"];
  readonly managementKey: string;
}

const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  // Unknown so an odd hand-edited value cannot break the Limits view.
  priority: Schema.optional(Schema.Unknown),
  id_token: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_plan_type: Schema.optional(Schema.String),
      plan_type: Schema.optional(Schema.String),
    }),
  ),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
// Decoded apart from AuthFiles so a cooldown shape change cannot break the Limits view.
const AuthFileCooldowns = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      disabled: Schema.optional(Schema.Boolean),
      cooldowns: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              scope: Schema.String,
              model_key: Schema.optional(Schema.String),
              retry_at: Schema.String,
            }),
          ),
        ),
      ),
    }),
  ),
});
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  limit_window_seconds: Schema.optional(Schema.Number),
});
const CodexUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    }),
  ),
});
const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  spend: Schema.optional(Schema.Unknown),
  extra_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        is_enabled: Schema.Boolean,
        monthly_limit: Schema.NullOr(Schema.Number),
        used_credits: Schema.NullOr(Schema.Number),
        utilization: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const ClaudeProfile = Schema.Struct({
  organization: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ rate_limit_tier: Schema.optional(Schema.NullOr(Schema.String)) }),
    ),
  ),
});
// Max quotas are multiples of Pro's; pooled meters weight accounts by them.
const CLAUDE_TIERS: Record<string, { readonly plan: string; readonly capacity: number }> = {
  default_claude_ai: { plan: "Claude Pro", capacity: 1 },
  default_claude_max_5x: { plan: "Claude Max 5x", capacity: 5 },
  default_claude_max_20x: { plan: "Claude Max 20x", capacity: 20 },
};
const CreditList = Schema.Struct({
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const authPriority = (account: typeof AuthFile.Type) =>
  typeof account.priority === "number" && Number.isSafeInteger(account.priority)
    ? account.priority
    : 0;
const hubProvider = (driver: ProviderDriverKind) =>
  driver === "codex" ? "codex" : driver === "claudeAgent" ? "claude" : undefined;
const decodeAuthFileCooldowns = Schema.decodeUnknownEffect(AuthFileCooldowns);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditList));
const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeUsage));
const decodeClaudeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeProfile));
const decodeCodexUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexUsage));
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

// Extra CAs can fix untrusted chains; expiry/hostname failures report codes only.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// fetch wraps Node error codes in generic TypeErrors.
const nodeErrorCode = (cause: unknown) => {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
};

// Hub responses can contain credentials; expose only failure kind, HTTP status or Node code.
const describeManagementFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "The hub did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `The hub answered with HTTP ${reason.response.status}.`;
    }
    const code = reason._tag === "TransportError" ? nodeErrorCode(reason.cause) : undefined;
    if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
      return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
    }
    if (code !== undefined) return `The hub request failed (${code}).`;
  }
  return "The hub management request failed.";
};
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
const creditRedeemRequestId = Effect.fn("CliproxyApi.creditRedeemRequestId")(function* (
  accountId: string,
  creditId: string,
) {
  const digest = yield* Digest.Digest;
  const name = new TextEncoder().encode(`${accountId}:${creditId}`);
  const input = new Uint8Array(CREDIT_REDEEM_NAMESPACE.length + name.length);
  input.set(CREDIT_REDEEM_NAMESPACE);
  input.set(name, CREDIT_REDEEM_NAMESPACE.length);
  const bytes = (yield* digest.digest(Digest.sha1, input).pipe(Effect.orDie)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;

  const management = Effect.fn("CliproxyApi.management")(function* (
    hub: CliproxyHub,
    path: string,
    body?: unknown,
    method: "POST" | "PATCH" = "POST",
  ) {
    const url = yield* Effect.try({
      try: () => {
        const base = new URL(hub.url);
        // Users often paste the hub's web panel URL, which ends in management.html.
        base.pathname = base.pathname.replace(/(\/management\.html)?\/?$/i, "/");
        return new URL(`v0/management/${path}`, base).toString();
      },
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      body === undefined
        ? HttpClientRequest.get(url)
        : method === "PATCH"
          ? HttpClientRequest.patch(url)
          : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${hub.managementKey}`));
    const response = yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (error) => new UsageLimitSourceError({ detail: describeManagementFailure(error) }),
        ),
      );
    return response;
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (hub: CliproxyHub) {
    const response = yield* management(hub, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  // A credential serves the model again once its credential-wide and model cooldowns both end.
  const claudeCooldownEnd = Effect.fn("CliproxyApi.claudeCooldownEnd")(function* (
    hub: CliproxyHub,
    model: string,
  ) {
    const { files } = yield* decodeAuthFileCooldowns(yield* management(hub, "auth-files"));
    const ends = files.flatMap((account) => {
      if (account.disabled || account.provider !== "claude") return [];
      const retries = (account.cooldowns ?? []).flatMap((cooldown) =>
        cooldown.scope === "credential" || cooldown.model_key === model
          ? [Date.parse(cooldown.retry_at)]
          : [],
      );
      return retries.length > 0 && retries.every(Number.isFinite) ? [Math.max(...retries)] : [];
    });
    return ends.length > 0 ? Math.min(...ends) : undefined;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    hub: CliproxyHub,
    account: typeof AuthFile.Type,
    url: string,
    data?: unknown,
  ) {
    const header =
      account.provider === "codex"
        ? {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
            ...(account.id_token?.chatgpt_account_id
              ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id }
              : {}),
          }
        : {
            Authorization: "Bearer $TOKEN$",
            "anthropic-beta": "oauth-2025-04-20",
            // The OAuth usage endpoint can return 429 without a Claude Code user agent.
            "User-Agent": "claude-code/2.1.273",
          };
    const raw = yield* management(hub, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new UsageLimitSourceError({
        detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
      });
    }
    return response.body;
  });

  const credits = Effect.fn("CliproxyApi.credits")(function* (
    hub: CliproxyHub,
    account: typeof AuthFile.Type,
  ) {
    const body = yield* apiCall(hub, account, CREDIT_URL);
    const response = yield* decodeCreditList(body);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return response.credits
      .filter(
        (credit) =>
          credit.reset_type === "codex_rate_limits" &&
          credit.status === "available" &&
          Date.parse(credit.expires_at) > now,
      )
      .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  });

  // A plan rarely changes, so each account's is read once per process.
  const claudeTiers = new Map<string, (typeof CLAUDE_TIERS)[string]>();
  const claudeTier = Effect.fn("CliproxyApi.claudeTier")(function* (
    hub: CliproxyHub,
    account: typeof AuthFile.Type,
  ) {
    const known = claudeTiers.get(account.id);
    if (known) return known;
    const profile = yield* decodeClaudeProfile(
      yield* apiCall(hub, account, "https://api.anthropic.com/api/oauth/profile"),
    );
    const tier = CLAUDE_TIERS[profile.organization?.rate_limit_tier ?? ""];
    if (tier) claudeTiers.set(account.id, tier);
    return tier;
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    hub: CliproxyHub,
    account: typeof AuthFile.Type,
  ) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: account.id,
      driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),
      priority: authPriority(account),
      ...(account.email ? { email: account.email } : {}),
      ...(account.id_token?.chatgpt_account_id?.trim()
        ? { workspaceId: account.id_token.chatgpt_account_id.trim() }
        : {}),
    };
    const read = Effect.gen(function* () {
      if (account.provider === "claude") {
        const body = yield* apiCall(hub, account, "https://api.anthropic.com/api/oauth/usage");
        const usage = yield* decodeClaudeUsage(body);
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        const rateLimits = {
          five_hour: usage.five_hour ?? null,
          seven_day: usage.seven_day ?? null,
          model_scoped,
          spend: usage.spend,
          extra_usage: usage.extra_usage ?? null,
        };
        const tier = yield* claudeTier(hub, account).pipe(Effect.orElseSucceed(() => undefined));
        return {
          ...base,
          plan: tier?.plan ?? "Claude Subscription",
          ...(tier ? { capacity: tier.capacity } : {}),
          usageLimits: claudeUsageResponseToLimits({
            checkedAt,
            response: {
              rate_limits_available: true,
              rate_limits: rateLimits,
            },
          }).limits,
        };
      }
      const body = yield* apiCall(hub, account, `${CODEX_BASE}/usage`);
      const usage = yield* decodeCodexUsage(body);
      const toWindow = (window: typeof CodexWindow.Type | null | undefined) =>
        window
          ? {
              usedPercent: window.used_percent,
              resetsAt: window.reset_at ?? null,
              ...(window.limit_window_seconds === undefined
                ? {}
                : { windowDurationMins: window.limit_window_seconds / 60 }),
            }
          : null;
      const available = yield* credits(hub, account).pipe(Effect.orElseSucceed(() => undefined));
      const next = available?.[0];
      const planType =
        usage.plan_type ?? account.id_token?.plan_type ?? account.id_token?.chatgpt_plan_type;
      return {
        ...base,
        plan: codexPlanLabel(planType),
        usageLimits: {
          ...codexRateLimitsToLimits({
            checkedAt,
            snapshot: {
              planType: planType ?? null,
              primary: toWindow(usage.rate_limit?.primary_window),
              secondary: toWindow(usage.rate_limit?.secondary_window),
            },
          }),
          ...(available
            ? {
                resetCredits: {
                  availableCount: available.length,
                  ...(next
                    ? {
                        nextCreditId: next.id,
                        nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
    });
    return yield* read.pipe(
      Effect.orElseSucceed(() => ({
        ...base,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: "The hub could not read this account's usage.",
        }),
      })),
    );
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    hub: CliproxyHub,
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const accounts = yield* authFiles(hub).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
    return yield* Effect.forEach(
      accounts.filter(
        (account) =>
          !account.disabled && (account.provider === "codex" || account.provider === "claude"),
      ),
      (account) => readAccount(hub, account),
      { concurrency: 4 },
    );
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    hub: CliproxyHub,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(hub)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(hub, account, `${CREDIT_URL}/consume`, {
        redeem_request_id: yield* creditRedeemRequestId(
          account.id_token?.chatgpt_account_id ?? account.id,
          creditId,
        ).pipe(Effect.provideService(Digest.Digest, digest)),
        credit_id: creditId,
      });
      const response = yield* decodeConsumeResponse(body);
      const outcome = (
        {
          reset: "reset",
          nothing_to_reset: "nothingToReset",
          no_credit: "noCredit",
          already_redeemed: "alreadyRedeemed",
        } as const
      )[response.code];
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = yield* management(hub, "reset-quota", {
        auth_index: account.auth_index,
      }).pipe(Effect.result);
      return {
        outcome,
        ...(cleared._tag === "Failure"
          ? {
              warning:
                "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
            }
          : {}),
      } as const;
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: "The hub returned an unexpected reset-credit response.",
            }),
      ),
    );
  });
  /** Listed accounts first, then the driver's others by their current priority; null ties them all. */
  const setAccountOrder = Effect.fn("CliproxyApi.setAccountOrder")(function* (
    hub: CliproxyHub,
    driver: ProviderDriverKind,
    accountIds: ReadonlyArray<string> | null,
  ): Effect.fn.Return<ReadonlyMap<string, number>, UsageLimitSourceError> {
    const provider = hubProvider(driver);
    if (provider === undefined) {
      return yield* new UsageLimitSourceError({ detail: "The hub does not route this provider." });
    }
    const files = (yield* authFiles(hub).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    )).filter((account) => account.provider === provider);
    const listed = [...new Set(accountIds)].flatMap(
      (id) => files.find((account) => account.id === id) ?? [],
    );
    const ordered = [
      ...listed,
      ...files
        .filter((account) => !listed.includes(account))
        .toSorted((left, right) => authPriority(right) - authPriority(left)),
    ];
    // The bottom keeps the hub default, so an account added later shares the last place.
    const priorities = new Map(
      ordered.map((account, index) => [
        account.id,
        accountIds === null ? 0 : ordered.length - 1 - index,
      ]),
    );
    yield* Effect.forEach(
      ordered.filter((account) => authPriority(account) !== priorities.get(account.id)),
      (account) =>
        management(
          hub,
          "auth-files/fields",
          { name: account.id, priority: priorities.get(account.id) },
          "PATCH",
        ),
      { concurrency: 4, discard: true },
    );
    return priorities;
  });
  return { readAccounts, consume, claudeCooldownEnd, setAccountOrder };
});
