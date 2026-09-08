import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** T3's connection to an externally configured Pi runtime, not Pi configuration. */
export const PiConnectionSettings = Schema.Struct({
  binaryPath: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("pi")),
    Schema.annotateKey({
      title: "Binary path",
      description: "External Pi executable. Pi manages its own configuration and authentication.",
      providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
    }),
  ),
});
export type PiConnectionSettings = typeof PiConnectionSettings.Type;
