import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";

export class ReadAloudScriptError extends Schema.TaggedError<ReadAloudScriptError>()(
  "ReadAloudScriptError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Markdown, code or TeX the voice would read out or stumble on. */
const UNSPOKEN = /[`*|\\{}_$^<>#[\]]/;

const SCRIPT_INSTRUCTIONS = `You turn a coding agent's reply into the script a text-to-speech voice reads aloud to the developer who asked for it. They are listening, not looking at the screen, and should come away knowing everything the reply says.

Keep the reply's content, order and tone. Don't summarise, shorten, comment on or answer it; keep every point, caveat and number. Change only what a voice would read badly or what only works on the page:
- Say code the way a developer says it to a colleague: an identifier as its words ("use thread shell", "max chunk chars"), a command as you would read it out ("N P M run dev"), a flag by its name ("the hidden flag"), an expression or operator by what it does.
- Say a file path or file link by its file name, adding a folder only when the reply needs it to tell files apart, and a line number only when the reply relies on it.
- Say a URL by the site or page it points to. Leave out a commit hash, ID or long number, or name what it identifies, unless the reply depends on its value; then say its first few characters.
- Read maths the way a good teacher says it aloud: a subscript follows its letter without "sub" ("v 1", "x i"), with only the grouping needed for it to be heard right.
- Say symbols, arrows and shorthand as what they mean there: "to" or "becomes" for an arrow, "at least" for a greater-or-equal sign, "for example" for "e.g.", "versus" for "vs.".
- Spell out with spaces the letters said one by one ("P R", "C I", "U I", "S S H"); keep a name said as a word as one word ("JSON", "Tailscale").
- Write a number the way it is said when its reading isn't obvious: versions ("version 2 point 0 point 63"), units and sizes ("4 gigabytes", "180 milliseconds"), ranges, times and percentages.
- Don't read a code block line by line: say in a sentence what it is or does, unless it is a short command or line the listener needs, which you read out. Mention a long log, diff or output only as far as the reply relies on it.
- Read a table row by row, each row a sentence that names its columns where that helps.
- Make each heading, list item and table row its own sentence. Drop emphasis, emoji and decoration, or say them as a word when they carry meaning ("done" for a check mark).
- Write in the reply's own language.

Write plain sentences in paragraphs separated by a blank line, using only words, digits and ordinary punctuation: no markdown, code, backticks, asterisks, pound signs, pipes, slashes, underscores, brackets, braces, backslashes or other symbols. Return the script as the "transcription" value.`;

function buildReadAloudScriptPrompt(markdown: string): string {
  return `${SCRIPT_INSTRUCTIONS}\n\nThe reply:\n<reply>\n${markdown}\n</reply>`;
}

/** Why `script` can't be read aloud as written, or "" when it can. */
function scriptProblem(script: string): string {
  if (!script.trim()) return "an empty script";
  const match = UNSPOKEN.exec(script);
  if (!match) return "";
  const excerpt = script
    .slice(Math.max(0, match.index - 20), match.index + 20)
    .replace(/\s+/g, " ");
  return `a script with ${JSON.stringify(match[0])} in "${excerpt.trim()}"`;
}

export class ReadAloudScript extends Context.Service<
  ReadAloudScript,
  {
    /**
     * The reply as the read aloud model rewrites it for speech, or null when no model is set.
     * `onWriting` runs just before the model is asked.
     */
    readonly write: (
      markdown: string,
      onWriting: Effect.Effect<void>,
    ) => Effect.Effect<string | null, ReadAloudScriptError>;
  }
>()("t3/speech/readAloudScript") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const textGeneration = yield* TextGeneration.TextGeneration;
  return ReadAloudScript.of({
    write: Effect.fn("ReadAloudScript.write")(function* (markdown, onWriting) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new ReadAloudScriptError({ detail: "Couldn't read the read aloud settings.", cause }),
        ),
      );
      const modelSelection = settings.readAloudModelSelection;
      if (modelSelection === null || !markdown.trim()) return null;
      yield* onWriting;
      // Providers run in a working directory; rewriting must not read a checkout.
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-read-aloud-" })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ReadAloudScriptError({ detail: "Couldn't create a working directory.", cause }),
          ),
        );
      const prompt = buildReadAloudScriptPrompt(markdown);
      let problem = "";
      // The voice-cleanup operation is a plain prompt-to-text call on every provider.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { transcription } = yield* textGeneration
          .generateTranscriptionPostProcessing({ cwd, prompt, modelSelection })
          .pipe(
            Effect.mapError((cause) => new ReadAloudScriptError({ detail: cause.detail, cause })),
          );
        problem = scriptProblem(transcription);
        if (!problem) return transcription.trim();
      }
      return yield* new ReadAloudScriptError({
        detail: `The read aloud model answered twice with ${problem}.`,
      });
    }, Effect.scoped),
  });
});

export const layer = Layer.effect(ReadAloudScript, make);
