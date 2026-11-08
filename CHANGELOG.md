# Changelog

All notable changes to soulframe are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bursts** (`pacing.burst`). Someone who writes several messages in a row gets one reply, once they stop:
  `settleSeconds` (default `[2, 5]`) of quiet after their newest message, each message starting the wait again, up to
  `maxSettleResets` (default 3) times. A message that lands while the reply is being written, before its first message
  is sent, drops the draft and writes it again with that message read (`restartOnNewMessage`, default `true`, at most
  `maxRestarts` times in a row, default 1); too late for that, it gets a turn of its own once this one ends. Each
  dropped draft was paid for, so `personaWarnings` warns when `maxRestarts` is above 1. New log events
  `reply_superseded`, `reply_restarted` and `reply_after_turn`.
- `Turn.keep()`: stores what a DM turn wrote and decided (its notes on the person and on itself, a block, an action),
  once; the reply queue calls it when it keeps the turn, never for a dropped draft.

### Changed

- **One person at a time, always**, with no polling: turns that came due wait in the order they came due and the first
  starts the moment the persona is free (they used to be checked again every 5 seconds, in no set order). A turn under
  way for over 10 minutes still stops holding the others back.
- **It reads while the model writes.** The read receipt (`markRead`) and the reading time now start with the model
  call, and typing starts once both are done, so a reply no longer waits for the model and then for the reading. A
  turn left on read now shows their messages read, and a turn whose model call fails ends at once.
- **BREAKING: `compose` stores nothing of a turn until its `keep()`.** The notes, a block or an action (and their
  audit lines) used to be stored as soon as the model answered, even for a reply never sent. Code that calls
  `brain.compose` without the reply queue calls `turn.keep?.()` once it uses the turn.

### Removed

- **BREAKING: `pacing.singlePresence`.** Answering one person at a time is no longer optional: with it off, turns for
  different people could overwrite each other's self notes. A config that still sets it fails to load with
  `settings.pacing.singlePresence: unknown key`: delete the line.

## [0.1.0-beta.0] - 2026-11-07

The first beta: a general-purpose persona framework that knows no messaging channel and no product, published to npm
on the `beta` dist-tag under the MIT license.

### Added

- **Published as compiled JavaScript.** `npm install soulframe` gives ESM (`dist/index.mjs`) and CommonJS (`dist/index.cjs`) builds with matching
  type declarations, behind a conditional `exports` map; `src/store.ts` loads `node:sqlite` with `process.getBuiltinModule`, which works in both.
- **MIT license.**
- Versioning, commit message and changelog standards written down in `CONTRIBUTING.md` and `AGENTS.md`, with `npm run lint:commits`.
- **Reading time.** Before it types, a persona spends as long as it takes to read what they wrote (the unread messages
  together): `pacing.readingCharsPerSecond` (default `[15, 25]`) within `pacing.readingDurationSeconds` (default
  `[1, 20]`), with or without `markRead`.
- `pacing.singlePresence` (default `true`): the reply queue answers one person at a time, so parallel turns cannot overwrite
  each other's self notes; a reply stuck over 10 minutes stops blocking the others. A temporary guard until self notes merge
  safely; with it off, turns for different people run in parallel and `personaWarnings` flags the risk.
- `sfw: true` in a persona's file or `_shared.yaml` (default `false`): every prompt of that persona gets one rule
  keeping its conversations free of sexual or explicit content.
- **Persona config.** `loadPersonas` reads a folder holding `_shared.yaml` (optional defaults) and `<id>.yaml` per
  persona, its prompt `<id>.md` beside it; `parsePersonas` does the same from values already read. Layers merge as
  defaults, `_shared.yaml`, then the persona's file; `null` clears an inherited value, `character.boundaries` add up.
  Every problem is returned with its file and path, unknown keys with the nearest known one. `PERSONA_ID`,
  `ConfigError` and the issue helpers (`describe`, `suggest`, `unknownKeys`, `unknownKeyIssues`, `addQuietIssue`,
  `shownValue`) let an application check its own config the same way.
- **Settings** for text generation (`llm`, `models`: `directMessage`, `groupChat`, `post`), typed checks (`decisions`), `memory`, `pacing`, `context`
  and `retries`, with defaults; `llm` and `decisions` are set once for every persona.
- **Agenda.** Hours as a `window` (the same every day) or a `schedule` by weekday with online blocks, short breaks
  (DMs only) and busy blocks with a reason; per-block `chance`, skipped days, `on:` to limit a block to some channels.
  Drawn per local date from a seed, stable across restarts and daylight saving changes. `spanAt`, `fullyOnline`,
  `watchSpans`.
- **Mood** of the day from `character.moods`, by weight, seeded per persona and agenda day.
- **The brain** (`createBrain`): `incoming` and `compose` for direct-message turns (reply, notes on the person and on
  itself, block or one of the channel's own `actions`, accepting a group-chat invitation where `Channel.invitations`),
  `composeGroupChatLine` (with `GroupChatLine`), `composePost`, `wantsToSpeak` (the gate, at most
  `groupChatGate.perHour` checks per chat in any hour) and `checkGroupChatLine`. Lenient
  parsing of the model's JSON answer; private notes are never sent.
- **The application's words.** The identity line names only the persona and where it talks ("You are Robin, chatting
  by text in …"), with the application's phrase after the name (`createBrain({ identity })`, e.g. "a guide made by
  Example") and the channel's `identityNote`; how the persona writes is the application's `style` block; what the
  model should know about a place is the channel's `notes`, in its group-chat and post tasks, and how short a
  group-chat line there should be is its `targetLength`; the actions a DM turn may
  choose besides blocking are the channel's `actions` (`ChannelAction`: a name and when to choose it), carried out by
  the reply queue's `act`. `samplePrompt` takes `identity` and `style` too.
- **Generic names throughout**: group chats (`composeGroupChatLine`,
  `GroupChatLine`, `checkGroupChatLine`, `settings.models.groupChat`, `settings.decisions.groupChatGate`,
  `settings.decisions.minor.groupChats`, the Decisions uses `dmCheck`, `groupChatGate` and `groupChatLine`), posts
  (`settings.models.post`), `Conversation.invitation.name`, `Channel.invitations` and `Channel.actions`.
- **No content policy of its own.** soulframe is unrestricted by default: the rules a prompt carries and the links a
  reply may keep are the application's, passed as `createBrain({ policy: { rules, allowedLinks } })` (type `Policy`,
  also taken by `samplePrompt`). Without a policy a prompt has no rules block and links are left as written.
- **Stop requests** are handled by code before the model is called, on every channel: a goodbye, then the
  conversation ends.
- **An opt-in 18+ safeguard.** `Channel.adult: true` marks a conversation as 18+ and turns on the under-18 check of
  `incoming` (a goodbye, then every linked account is deny-listed for every persona), the Decisions age check and its
  caution (`settings.decisions.minor.*`), and the "You only talk with adults" rule line; personas loaded with
  `adult: true` also refuse school as a busy reason. Without it none of these run. `minorSignal` is exported for
  adapters.
- **Typed checks** (`createConfiguredDecisions`, `DISABLED_DECISIONS`): optional age and stop checks and a
  group-chat gate through a Decisions API, additive only, with its own daily token budget.
- **Reply queue** (`createReplyQueue`, `createRuntime`): human-paced replies inside open spans, typing time per
  message, a backlog answered one person at a time when the persona comes back, requeueing after a restart, retries,
  a halt switch and a dry-run mode. `Conversation` and `UnreachableError` for adapters; `Conversation.delivered` is
  told of each message that went out, or that a dry run logged in place of sending.
- **Memory** (`openDatabase`, `createStore`): people, identities per channel (`link`), messages, notes, a shared deny
  list, minor-caution flags, kv and audit in one SQLite database (`node:sqlite`), its tables made on open. An
  application with data in a layout of its own migrates it before `createStore`; `inTransaction` runs such a step
  all or nothing.
- **Text generation** (`llmsFor`, `createTokenMeter`, `createLimiter`, `modelKeys`): any OpenAI-compatible provider,
  one model per task, a shared daily token budget with a reserve for DMs, a global concurrency limit, retries that wait
  out outages. `createCannedLlm` for runs without a model.
- **Checks** for an application's config command: `personaWarnings`, `personaReport` and `samplePrompt`.
- Small shared helpers: `between`, `pick`, `sleep`, `typingMs`, `range`, `diffPaths`, `isPlainObject`, `valueAt`,
  `SECOND`, `MINUTE`, `HOUR`, `DAY`.
- Documentation, a runnable console example (`examples/console-chat.ts`) and the soulframe logo.
- **Typing realism**, opt-in: `Conversation.typingRefreshMs` makes the queue show typing again at the platform's
  rhythm while a message is typed (indicators expire after a few seconds, a message may be typed for 45);
  `Conversation.markRead()` shows the person their messages read once per reply, when the reading starts;
  `pacing.thinkingPauses` (`chance`, default `0`; `minChars` 120; `max` 2; `seconds` `[2, 6]`) lets typing stop a
  moment and start again in a long message. The halt switch, `stop()` and the person's state are checked after every
  wait, typing never stays on after a cut or a failure, and a dry run makes the same calls. Without the hooks and with
  `thinkingPauses.chance` at 0, each message is one `typing(true)`, the typing time, `send` and one `typing(false)`.
- **One clock and one rng.** `createBrain` takes the reply queue's `runtime` (its `now`, `rng` and `store`, read at
  each use), so the brain and the queue can't run on different clocks; `{ store, now, rng }` is enough for a brain
  used without a queue. `createConfiguredDecisions` takes a `now` (default `Date.now`) for the day it logs a spent
  budget on.
- **Configuration errors are not retried.** A task with no provider or no model set rejects with a configuration
  error: the queue gives up at once (`reply_given_up` with `reason: 'model_not_configured'`) and the person stays
  owed for a start with the settings fixed.
- A person takes the name of their newest message (one read late changes nothing).
- Doc drift tests (`test/docs.test.ts`): every `file.ts:NN` reference in the README and `docs/` points at existing
  lines that hold what its code span names, every export is documented in `docs/api.md` (and nothing else), and every
  relative link and anchor resolves.

[Unreleased]: https://github.com/RubyDevil/soulframe/compare/v0.1.0-beta.0...HEAD
[0.1.0-beta.0]: https://github.com/RubyDevil/soulframe/releases/tag/v0.1.0-beta.0
