# Changelog

All notable changes to soulframe are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Texting first, off by default** (`settings.initiative`). A persona may start a DM conversation itself with
  someone who wrote to it before, on the channels the app allows (`queue.allowInitiative(channel, conversationOf)`).
  This first kind is the follow-up: a DM turn may plan to text them again about something still ahead of them or
  something it promised (the `followUp` field of the DM answer format, `initiative.followUps`), and when the day
  comes the persona decides whether to send it (`brain.composeOpener`, the new `models.initiative` task). The code
  decides who and when, with guardrails no setting relaxes: never to anyone who never wrote, is not active, is
  deny-listed or flagged; never with a reply owed or mid-conversation; one unanswered opener at most, with a gap
  (`personGapHours`) that doubles for each one ignored; `perDay` a day and one a day per account across personas; only
  at an hour they have written at; in a full online span with `spanEndMinutes` left, and only when no reply waits. If
  they write first, the opener is dropped. Openers spend the budget DMs don't keep for themselves, and each outcome is
  audited (`opener_sent`, `opener_declined`, …). A persona may set its own `initiative` in its config. The store keeps
  them in a new `openers` table (made when it opens), with methods for them (`planOpener`, `dueOpeners`, …).
- **A persona is its config and its prompt.** `parsePersona({ config, prompt, channels })` checks a persona from
  wherever the application keeps it (its own loader, a database, values in code) and answers `{ persona?, issues }`,
  never throwing. The config (`PersonaConfig`) holds only what the code computes with: `id`, `name`, `timezone` and
  `schedule`; everything else about the persona is its prompt, free Markdown. A loaded persona is a
  `Persona` (`PersonaConfig` with its `prompt`).
- **Persona files with frontmatter**, the one file format the package reads, and only if you want it: `<id>.md`, its
  config as YAML frontmatter between two `---` lines, its prompt the rest. `parsePersonaMarkdown(text, { id, channels })`
  reads one file's text (a YAML error points at the file's own line); `loadPersonas({ dir, channels })` reads a folder
  of them. [`examples/personas/robin.md`](./examples/personas/robin.md) is one, loaded by the tests.
- `parseSettings(raw, { source })`: the settings a brain runs with, read from wherever the application keeps them,
  every default filled in, every problem returned with its path (an unknown key with the nearest known one).
- `createBrain({ settings })` (required: `parseSettings({})` gives every default), and `brain.persona` and
  `brain.settings`, which the reply queue reads.
- `settingsWarnings(settings)`: the warnings about settings that `personaWarnings` used to give (`pacing.burst.maxRestarts`
  above 1, no text provider).
- `Policy.sfw`: the safe-for-work rule, now the application's policy (`createBrain({ policy: { sfw: true } })`), in the
  same place in the rules block, after the 18+ line.
- A key that a 0.1 beta persona file read (`window`, `prompt`, `chattiness`, `sfw`, `character`, `settings`) is refused
  with where it went, not only as unknown; a `_shared.yaml` or `<id>.yaml` left in the folder is reported by
  `loadPersonas`, which then loads no persona it may have set something for (a shared `sfw` or limit is never lost
  without a word).
- **Service settings** (`parseServiceSettings`, `ServiceSettings`): what every persona shares, set once and never per
  brain: the text provider's budget (`text`: `dailyTokens`, `directMessageReserve`, `concurrency`) and the Decisions
  client (`decisions`: `enabled`, `baseUrl`, `apiKeyEnv`, `model`, `timeoutSeconds`, `dailyTokens`). Build the token
  meters, the model clients (`llmsFor`'s new `budget`) and the Decisions client from them.
- `models.default`: the provider and model of every task that names none (`baseUrl`, `apiKeyEnv`, `model`,
  `jsonMode`, `timeoutSeconds`), and a `timeoutSeconds` of each task's own. `personaReport` names the host of a task on
  a provider of its own.
- **A persona's own `pacing` and `relationship`**: only the keys it changes, in its config, merged over its brain's
  settings by `createBrain` (`brain.settings`; a `ConfigError` if they don't fit). `parsePersona` and the loaders check
  them over their new `settings` option.

### Changed

- **BREAKING: settings are the brain's, never a persona's.** Give them to `createBrain({ persona, settings })`
  (required: `parseSettings({})` gives every default), the same object for every persona or one of their own, and the
  same settings to `llmsFor` (whose `{ id, settings }` entries are unchanged). `createReplyQueue({ brain, runtime,
  act })` takes no `persona`: it answers with its brain's persona and settings, so the two can't differ.
- **BREAKING: `decisions.groupChatGate.chimeInAt` is one number** (default `1.7`), no longer one per chattiness: give a
  quieter persona's brain a higher one (`2.2` was `quiet`'s, `1.2` `talkative`'s). The old shape is refused with a
  message that says so.
- **BREAKING: the group-chat task says nothing of how much the persona talks.** "You are easygoing in group chats." (or
  quiet, or talkative, by `chattiness`) was in every persona's group-chat prompt; it is gone. Say in the persona's
  prompt how much it talks in group chats.
- **BREAKING: `loadPersonas` reads `<dir>/<id>.md`** (frontmatter and prompt in one file) and answers
  `{ issues, personas }`, without `shared`.
- **BREAKING: `personaReport(persona, { settings, now, status? })`** takes the settings its brain runs with in place
  of `shared`: no `overrides` lines; `prompt:` gives the prompt's length; no `character:` line.
- `personaWarnings` warns only about the persona (its time zone, hours, channels and own `pacing.burst.maxRestarts`);
  `samplePrompt` takes `settings`.
- **BREAKING: the Decisions client's settings are the service settings'.** `decisions.enabled`, `baseUrl`,
  `apiKeyEnv`, `model`, `timeoutSeconds` and `dailyTokens` moved there (each refused in a brain's settings with where
  it went), and `createConfiguredDecisions` takes the service settings' `decisions`, giving `DISABLED_DECISIONS` while
  it is off. A brain's `settings.decisions` keeps which checks it asks and their thresholds.
- `vision` never takes the default model in the model client either (it already never did in the brain).

### Removed

- **BREAKING: `_shared.yaml` and the layering of persona files.** Each persona's config is its own. Settings shared by
  every persona are one settings object given to every brain; a limit every persona keeps belongs in the
  `policy.rules` you give each brain, after the persona's prompt, where no persona can drop it.
- **BREAKING: the `window` form of the hours.** Write the same hours every day as a schedule:
  `schedule: { skipDayChance, days: { mon-sun: { online: [{ start, end }] } } }`, which draws exactly the hours the
  window did.
- **BREAKING: `chattiness`, `sfw` and `character` in a persona's config.** `chattiness` is gone (say in the prompt how
  much it talks in group chats; the gate's threshold is `chimeInAt`) and `sfw` moved to `Policy.sfw`; write the
  persona's facts, interests and boundaries in its prompt, in your words (the fixed "Facts about you that never change…",
  "Things you're into…" and "Things you won't do…" blocks are gone).
- **BREAKING: the mood of the day** (`character.moods`): the seeded daily pick and the "Your mood today: …" sentence
  that ended DM and group-chat time lines are gone, and so is `personaReport`'s mood. A mood that follows what happens,
  shared by everyone the persona talks with, is on the roadmap.
- **BREAKING: `settings:` in a persona's file**, and the split of settings into per-persona and global groups.
- **BREAKING: `parsePersonas`** (use `parsePersona` per persona), the `Chattiness` type, the
  `prompt:` path key (the prompt is the file's body), and `PersonaConfig`'s `promptText`, `source` and `settings`.
- **BREAKING: `settings.llm` is gone.** Its `baseUrl`, `apiKeyEnv`, `model`, `jsonMode` and `timeoutSeconds` are
  `models.default`'s; its `dailyTokens`, `directMessageReserve` and `concurrency` are the service settings' `text`, and
  `llmsFor` takes them as `budget` in place of `concurrency`. An old `llm` block is refused with where each key went.
  `modelKeys` names `models.default.apiKeyEnv` and `models.<task>.apiKeyEnv`.

### Security

- **A task on a provider of its own no longer gets the default provider's key.** A task with its own `baseUrl` and no
  `apiKeyEnv` used to be sent `llm.apiKeyEnv`'s key, so that key went to another host; it was given the default model
  name and `jsonMode` too. Such a task now takes nothing of the default provider but its timeout: `parseSettings`
  refuses it until it names its own `apiKeyEnv` (`''` for none) and `model`, and the model client never sends it the
  default key.

### Fixed

- A config key named like a built-in member of every object (`constructor`, `toString`, `valueOf`) was taken as known
  and dropped without a word; it is refused as unknown like any other (`unknownKeys` too).

## [0.1.0-beta.1] - 2026-11-08

### Added

- `brain.outgoing`: records a message the persona's account sent from outside the reply queue (typed by hand, say), so
  later turns read it in the history as its own.
- **Personas see photos and link previews in DMs.** `brain.incoming` also takes an `IncomingMessage` (`text`, `images`,
  `links`), and a photo sent alone now gets a turn. A photo is described once by `models.vision` (off until it names a
  model, never `llm.model`), the description stored in place of its URL, and the chat model reads only that. It takes
  `pacing.looking` per photo (default `[1.5, 5]` s), and a description that fails or takes over
  `perception.timeoutSeconds` (default 15) leaves a photo that "wouldn't load" (or only its `alt`) instead of holding the reply up. A link
  is only its preview card (from the app, or `createBrain`'s new `previewLink`), else its site's name: the prompt says
  it has not opened it and must not claim to have. soulframe fetches no URL itself. New `perception` settings,
  `store.setMedia`, a `media` column on `messages` added on open, `LlmMessage.images`, and an `image_unseen` audit
  line. A URL no longer counts as reading time.
- **Bursts** (`pacing.burst`). Someone who writes several messages in a row gets one reply, once they stop:
  `settleSeconds` (default `[2, 5]`) of quiet after their newest message, each message starting the wait again, up to
  `maxSettleResets` (default 3) times. A message that lands while the reply is being written, before its first message
  is sent, drops the draft and writes it again with that message read (`restartOnNewMessage`, default `true`, at most
  `maxRestarts` times in a row, default 1); too late for that, it gets a turn of its own once this one ends. Each
  dropped draft was paid for, so `personaWarnings` warns when `maxRestarts` is above 1. New log events
  `reply_superseded`, `reply_restarted` and `reply_after_turn`.
- `Turn.keep()`: stores what a DM turn wrote and decided (its notes on the person and on itself, a block, an action),
  once; the reply queue calls it when it keeps the turn, never for a dropped draft.
- **It answers by what it is doing, not by a roll per message.** While it writes a reply to anyone, and for a while
  after, it is on its phone (`pacing.watching`: the chance halves every `halfLifeSeconds`, default 90) and notices a
  new message from anyone after a short lag (`medianSeconds` 4, `p90Seconds` 8, within `delaySeconds` `[2, 20]`), so
  a live conversation stays live and doesn't leave anyone else waiting for its next glance. Off its phone, it notices
  a message when it next looks at its messages (`pacing.glance`: `medianSeconds` 40, `p90Seconds` 150, within
  `[4, 900]`), one look for everyone: whoever wrote before it is noticed at once, and picked among by weight; once it
  picks up its phone for someone's turn, whatever else was waiting is noticed too. Both delays
  are drawn from a log-normal distribution, the skewed shape of real answer times. Whether it still has one person's
  chat open (`chatHalfLifeSeconds`, default 90) only weighs who goes first. On a short break it is on its phone.
  `reply_scheduled` logs `watching`.
- **Familiarity and affinity, kept per person** (`settings.relationship`, `Person.familiarity`, `Person.affinity`).
  Familiarity (0 to 1) is counted by the code: each turn the reply queue keeps adds `familiarity.growth` (default
  0.012) of what is left, times 0.25 to 5 by how much the turn mattered, and it halves over `fadeHalfLifeDays` (default
  60) apart. Affinity (-1 to 1) moves `affinity.step` (default 0.05) per turn as the model answers (warmer, cooler or no
  change); `affinity.enabled: false` turns it off. The DM prompt describes both as levels, shipped as seven and five
  sentences (`FAMILIARITY_LEVELS`, `AFFINITY_LEVELS` in `prompts.ts`) and replaceable whole, thresholds and words
  (`familiarity.levels`, `affinity.levels`); the levels are set once per conversation, go back down only past
  `hysteresis` (default 0.05), and say when they grew closer lately or drifted apart.
- **Importance.** The DM answer format asks how much the conversation matters now (`importance`, 0 small talk to 3
  something that matters a lot) and how the exchange changed the persona's feelings (`affinity`, -1, 0 or 1). The
  importance is stored on the person (`Person.importance`, `importanceAt`). With the typed checks on, it is also asked
  with the other DM checks (`decisions.importance`, default on, a switch of its own), ahead of a turn that comes due
  while others wait (`brain.assess`), whose answers `compose` then reuses.
- **Who goes first** (`pacing.priority`): when several are due while the persona is busy, the next is drawn by weight:
  closeness (familiarity, affinity), how much their conversation matters now (fading back over
  `importanceHalfLifeMinutes`, default 30), up to three times as much while it still watches their chat, and more the
  longer they waited (`agingMinutes`, default 2), so nobody waits forever. `weighted: false` keeps the order they came
  due. Logged as `reply_picked`.
- A database made by `0.1.0-beta.0` gets the new `people` columns when the store opens; familiarity starts from each
  person's conversations so far, so nobody who was close becomes a stranger.
- **Interruptions** (`pacing.interruptions`): now and then while online, something takes the persona away from its
  messages for a few minutes (on average once every `meanMinutes`, default 40, of online time, for `minutes`, default
  `[2, 8]`; `0` for none). Drawn per day from a seed, like the agenda, so a restart finds the same ones. Nobody's turn
  starts until it is back (a reply it was typing is finished), and it watches no chat then. One that comes in the
  middle of a conversation that matters (importance at `holdAtImportance`, default 2, or more, rated in the last
  `priority.importanceHalfLifeMinutes`, with an exchange in the last `calmMinutes`, default 5, or a turn of theirs
  coming) is held off and taken once it calms down, for the time it had left; the end of its online time comes
  regardless. A chat it was answering when called away is not watched when it comes back. Logged as `away` (with `from` and `until`) and
  `interruption_held`; `personaReport` lists today's as scheduled.

- `docs/attention.md`: when a persona answers, who goes first, how it gets to know people, every setting of it
  explained in plain terms, and what to change coming from `0.1.0-beta.0`.

- `store.block(id)`, `unblock(id)`, `undeny(channel, id)` and `clearMinorCaution(channel, id)`: block and unblock people by
  hand, and lift a deny-list entry or a minor flag you checked, each audited with `source: 'manual'`.
- `store.forgetPerson(id)` and `store.resetPersona(persona)`: delete one person, or everything one persona knows, in one
  transaction. The deny list and minor flags are kept, and so are people who asked to stop or were blocked unless
  `{ includeEnded: true }`.

### Changed

- **Drawn ranges have a shape.** Each setting a value is drawn from each time (typing and reading speeds, the burst
  quiet, pauses between and inside messages, backlog gaps, interruption lengths, retry waits) is drawn `uniform`,
  `normal` (a bell curve, about 95% inside the range) or `lognormal` (skewed like the time people take, around the
  range's geometric middle), still within the range, from one draw. The defaults follow what each one is: speeds
  `normal`, waits and pauses `lognormal`, retry waits `uniform`. `[least, most]` keeps a setting's own shape;
  `{ range: [least, most], shape }` sets it. Read back as `{ range, shape }` in `Settings`.

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

- **BREAKING: the per-message delay rolls** `pacing.quickReplyChance`, `slowReplyChance`, `quickReplyDelaySeconds`,
  `slowReplyDelaySeconds` and `busyReplyDelaySeconds`. Each reply had a chance of a slow or busy delay however live the
  conversation was. `watching`, `glance` and `interruptions` time replies now, and others' turns are what keeps
  someone waiting while it is busy; a config that still sets the old keys fails to load (`unknown key`). Roughly:
  a faster or slower persona sets `glance.medianSeconds`, and a long busy gap becomes `interruptions.minutes`.
- **BREAKING: `memory.relationshipAfter`.** The relationship is no longer a count of conversations: it is
  `settings.relationship` (familiarity and affinity, with levels of your own if you like). A config that still sets
  it fails to load (`unknown key`); to keep four levels at your old counts, set `relationship.familiarity.levels`.
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

[Unreleased]: https://github.com/RubyDevil/soulframe/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/RubyDevil/soulframe/compare/v0.1.0-beta.0...v0.1.0-beta.1
[0.1.0-beta.0]: https://github.com/RubyDevil/soulframe/releases/tag/v0.1.0-beta.0
