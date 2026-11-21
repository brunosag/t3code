import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const listSpellCheckWords = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPELL_CHECK_LIST_WORDS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(Schema.String),
  handler: Effect.fn("desktop.ipc.spellCheck.listWords")(function* () {
    const words = yield* Effect.promise(() =>
      Electron.session.defaultSession.listWordsInSpellCheckerDictionary(),
    );
    return words.toSorted((left, right) => left.localeCompare(right));
  }),
});

export const removeSpellCheckWord = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SPELL_CHECK_REMOVE_WORD_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.spellCheck.removeWord")(function* (word) {
    yield* Effect.sync(() =>
      Electron.session.defaultSession.removeWordFromSpellCheckerDictionary(word),
    );
  }),
});
