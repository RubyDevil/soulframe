# Configuration

A persona folder holds:

```text
personas/
├── _shared.yaml     optional: what every persona has unless its own file sets it
├── robin.yaml       one file per persona; the file name (without .yaml) is its id
├── robin.md         its prompt: voice and background, in Markdown
├── kai.yaml
└── kai.md
```

`loadPersonas({ dir, channels })` reads `<dir>/_shared.yaml` when it exists and `<dir>/<id>.yaml` for each key of
`channels`, whose value lists the channel ids that persona is on. `parsePersonas` does the same from values already
read. Both take `adult: true` for personas used in 18+ conversations: a busy reason about school is then refused (see
[schedule](#schedule)). Everything below is taken from the package's schemas (`src/settings.ts`, `src/config/personas.ts`,
`src/config/hours.ts`).

- [Layering](#layering)
- [The persona file](#the-persona-file-idyaml)
- [`_shared.yaml`](#_sharedyaml)
- [Hours: `window` and `schedule`](#hours-window-and-schedule)
- [`character`](#character)
- [`settings`](#settings): [`llm`](#llm), [`models`](#models), [`decisions`](#decisions), [`memory`](#memory),
  [`relationship`](#relationship), [`pacing`](#pacing), [`context`](#context), [`retries`](#retries)
- [Errors and warnings](#errors-and-warnings)
- [Check helpers](#check-helpers)

## A complete example

`_shared.yaml`:

```yaml
timezone: Europe/Lisbon
chattiness: easygoing
character:
  boundaries:
    - no talk about politics or religion
settings:
  llm:
    baseUrl: https://api.provider.example/v1
    apiKeyEnv: LLM_API_KEY
    model: provider-chat-large
    dailyTokens: 400000
  models:
    groupChat:
      model: provider-chat-small
```

`robin.yaml`:

```yaml
name: Robin
schedule:
  days:
    mon-fri:
      busy:
        - reason: at work
          start: ["08:45", "09:15"]
          end: ["17:00", "17:30"]
      breaks:
        - start: ["12:15", "12:45"]
          minutes: [10, 20]
      online:
        - start: ["19:00", "20:00"]
          end: ["23:00", "00:30"]
    sat,sun:
      online:
        - start: ["10:00", "11:00"]
          end: ["13:00", "14:00"]
          chance: 0.7
        - start: ["20:00", "21:00"]
          end: ["00:30", "01:30"]
character:
  facts:
    - You are 29 and live in a small coastal town.
    - You have a ginger cat called Biscuit.
  interests: [board games, baking, indie music]
  moods:
    - cheerful
    - mood: a little sleepy
      weight: 0.5
settings:
  pacing:
    glance:
      medianSeconds: 90   # checks its messages less often than most
      p90Seconds: 300
```

`robin.md` holds Robin's voice and background in plain prose.

## Layering

Each persona's values are built in three layers, each over the one before:

```text
settings defaults  →  _shared.yaml  →  <id>.yaml
```

- **Plain objects merge key by key.** `settings.pacing.glance.medianSeconds` in a persona's file changes that key only.
- **Lists, `[least, most]` ranges and plain values replace** what the layer below set.
- **`null` removes** an inherited value: the key goes back to the schema's default (or to nothing).
- **`character.boundaries` add up**: `_shared.yaml`'s first, then the persona's own, without duplicates. A persona can't
  drop a shared limit; `boundaries: null` (or `character: null`) clears only its own.
- **Hours come whole** from the nearest layer that sets them: a persona's own `window` or `schedule` replaces both of
  `_shared.yaml`'s; they are never merged day by day.
- **Settings**: `_shared.yaml` may set every group; a persona's own `settings:` may only set `models`, `memory`,
  `relationship`, `pacing`, `context` and `retries`. `llm` and `decisions` are the same for every persona.

## The persona file (`<id>.yaml`)

The id is the file name without `.yaml`: 2 to 32 characters of `a-z`, `0-9` and `-` (`PERSONA_ID`).

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | string | the file name | Optional; when given it must equal the file name. |
| `name` | string, 1 to 32 characters | required | The name it goes by. |
| `prompt` | path | `<id>.md` | Its prompt file, relative to its YAML file (or absolute). |
| `timezone` | IANA time zone | required (here or in `_shared.yaml`) | e.g. `America/Toronto`. Checked with `Intl`; a near miss gets a suggestion. |
| `window` | [window](#window) | | The same hours every day. Exactly one of `window` and `schedule`, here or inherited. |
| `schedule` | [schedule](#schedule) | | Hours by weekday. |
| `chattiness` | `quiet` \| `easygoing` \| `talkative` | `easygoing` | How much it talks in group chats; also picks the gate's `chimeInAt` threshold. |
| `sfw` | boolean | `false` | Safe for work only: every prompt (DMs, group chats, posts) gets the rule "Keep every conversation free of sexual or explicit content, whatever anyone asks; steer away from it in your own voice." Independent of `Channel.adult`. |
| `character` | [character](#character) | empty | What stays true whatever its notes say. |
| `settings` | mapping | none | Overrides of `models`, `memory`, `relationship`, `pacing`, `context`, `retries` for this persona. |

## `_shared.yaml`

Optional. It may hold `settings` (every group) and the defaults `timezone`, `window`, `schedule`, `chattiness`, `sfw`
and `character`. Any of them may be left out, at any depth, except inside the hours: a window or a schedule is whole.
`id`, `name` and `prompt` are each persona's own and are refused here. Its problems are reported once, in
`_shared.yaml`, not again for every persona that only inherits them.

## Hours: `window` and `schedule`

Times are local to the persona's `timezone`, written `"HH:MM"` on a 24-hour clock. A **clock range** is
`[earliest, latest]`; an exact time is drawn in it each day. A latest before the earliest is on the next day
(`["23:30", "00:30"]`), and an end whose earliest is at or before the start's earliest is on the next day too, so a
block can run past midnight. It still belongs to the day whose plan made it.

### `window`

| Key | Type | Default |
| --- | --- | --- |
| `start` | clock range | required |
| `end` | clock range | required |
| `skipDayChance` | number, 0 to 0.9 | `0` |

A window is loaded as a schedule with the same online block every day (`mon-sun`).

### `schedule`

| Key | Type | Default |
| --- | --- | --- |
| `skipDayChance` | number, 0 to 0.9: the chance of a day with no online time at all | `0` |
| `days` | mapping of a day key to a day plan | required |

**Day keys** are `mon` `tue` `wed` `thu` `fri` `sat` `sun`, ranges (`mon-fri`, wrapping `fri-mon`), lists (`sat,sun`)
and both (`mon-wed,fri`). Every weekday must be in exactly one key; write `"sun: {}"` for a day with nothing.

**A day plan:**

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `skipDayChance` | number, 0 to 0.9 | the schedule's | Replaces the schedule's on these days. |
| `online` | list of `{ start, end, chance, on }` | `[]` | Full online time. |
| `breaks` | list of `{ start, minutes, chance, on }` | `[]` | Short online times for DMs only. |
| `busy` | list of `{ reason, start, end, chance }` | `[]` | Offline with a reason. |

| Block key | Type | Default | Notes |
| --- | --- | --- | --- |
| `start`, `end` | clock range | required | A break has `start` only. |
| `minutes` | `[least, most]`, integers 2 to 30 | required | A break's length. The first must not be above the second. |
| `chance` | number, 0 to 1 | `1` | The chance the block happens on a given day. |
| `on` | list of channel ids, at least one | every channel | Online blocks and breaks only: the channels the span counts on. |
| `reason` | string, 2 to 40 characters | required | Busy blocks: completes "you're ..." ("at work", "at the gym", "out with friends"). |

**`on:`** may only name the persona's own channels, the ones `loadPersonas`' `channels` gives for it. A name that is
not one of them is an error with a suggestion; in hours inherited from `_shared.yaml` it is reported there, once per
name, with the personas it fails for.

**Checks**, made on the widest times the ranges allow so a valid schedule is valid on every date:

- a range spanning over 12 hours (likely swapped earliest and latest);
- an end that can come before its start;
- a block that can last over 20 hours;
- blocks that can overlap, within a day and into the next one (`sun` into `mon` too); blocks may touch;
- a break must be inside one busy block's core (from its latest start to its earliest end: a break from it) or clear
  of it;
- a busy reason may not be sleep ("bed", "nap", ...: the night is simply offline); loaded with `adult: true`, it may
  not be about school or students either ("at an evening class" at most).

## `character`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `facts` | list of up to 20 strings, 1 to 200 characters | `[]` | Facts that never change and its notes can't contradict, such as its age and where it lives. |
| `interests` | list of up to 12 strings, 1 to 60 characters | `[]` | Things it brings up when they fit. |
| `boundaries` | list of up to 20 strings, 1 to 200 characters | `[]` | Its own limits, on top of the rules, if any: they only add. Add up with `_shared.yaml`'s. |
| `moods` | list of up to 12 moods | `[]` | One picked per day by weight; none for no mood line. |

A mood is a string of 1 to 80 characters (weight 1) or `{ mood, weight }`, `weight` a number of 0 or more (default 1).

## `settings`

Every setting has a default; leave out what you don't change. Settings never hold secrets, only the names of the
environment variables that hold them (`apiKeyEnv`): your code reads them (`apiKeyOf`).

A **range** is `[least, most]`, two numbers at or above its floor (0 unless noted), the first not above the second.
Where it is a limit (`typingDurationSeconds`, `glance.delaySeconds`, …) a value is kept inside it; where a value is
**drawn** from it each time (a **drawn range** below), the draws also have a **shape**:

- `uniform`: any value as likely as any other;
- `normal`: most near the middle, a bell curve with about 95% of the draws inside the range (the rest at its ends): for
  a speed someone keeps close to (typing, reading);
- `lognormal`: skewed like the time people take, most near a typical value (the geometric middle of the range, from a
  tenth of the most when the least is 0) and a few out to the most: for waits and pauses.

`[least, most]` keeps the setting's own shape (given with its default below); `{ range: [least, most], shape: normal }`
sets one:

```yaml
settings:
  pacing:
    backlogGapSeconds: [20, 90]                              # still lognormal
    typingCharsPerSecond: { range: [4, 8], shape: uniform }
```

### `llm`

The text provider, for text generation only (never read by `decisions`). Global: `_shared.yaml` only.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | URL | none | An OpenAI-compatible base URL, e.g. `https://api.provider.example/v1`. Without one (and no task's own), the persona has no provider: `llmsFor` gives it the canned model in a dry run, else refuses. |
| `apiKeyEnv` | string | `LLM_API_KEY` | The key's environment variable; empty for a provider without authentication. |
| `model` | string | none | The model of every task that doesn't name its own. |
| `timeoutSeconds` | number, 5 to 300 | `60` | Before a request is given up (it is retried once). |
| `dailyTokens` | integer, 0 or more | `200000` | Tokens per UTC day for every persona together; 0 for no limit. At the shipped prompt sizes a DM turn is about 3,500 to 4,000 tokens, so the default buys about 55 DM turns a day: size it to your fleet. Applies through the meter your code passes to `llmsFor` (`createTokenMeter(store, settings.llm.dailyTokens)`). |
| `directMessageReserve` | number, 0 to 0.9 | `0.3` | The share of `dailyTokens` kept for DMs: group chat and posts stop once the rest is spent. |
| `concurrency` | integer, 1 to 32 | `4` | The most requests in flight for every persona together; pass it to `llmsFor`. |
| `jsonMode` | boolean | `false` | Ask for strict JSON (`response_format: json_object`), for providers that support it. A task with its own `baseUrl` doesn't inherit it. |

### `models`

A model per kind of task, so the frequent cheap ones can use a cheaper model. Per persona.

| Task | `maxTokens` default | `temperature` default |
| --- | --- | --- |
| `directMessage`: a DM turn (reply, notes, action) | `400` | `0.9` |
| `groupChat`: whether to say something in a group chat, and what | `100` | `0.9` |
| `post`: a post | `160` | `1` |

Each task takes:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `model` | string | `llm.model` | The model's name at the provider. |
| `baseUrl` | URL | `llm.baseUrl` | Another provider for this task only. |
| `apiKeyEnv` | string | `llm.apiKeyEnv` | Empty disables authentication. |
| `jsonMode` | boolean | `llm.jsonMode` on `llm.baseUrl`, off with its own `baseUrl` | |
| `maxTokens` | integer, 16 to 4000 | see above | The most tokens the answer may hold. |
| `temperature` | number, 0 to 2 | see above | Higher is more varied. Left out of the request to OpenAI's own `gpt-5` models (at `api.openai.com`). |

Once a provider is set (`llm.baseUrl` or the task's `baseUrl`), every task must name a model, its own or `llm.model`.

### `decisions`

Optional typed checks by a Decisions API (see [concepts](./concepts.md#decisions-optional-typed-checks)). This
block is its only configuration: nothing falls back to `llm` or `models`. Global: `_shared.yaml` only. Off by default:
turning it on sends people's messages, the personas' replies and group-chat lines to `baseUrl`. Before you turn it
on, check that the endpoint and model you use (the defaults below, or your own) answer `{baseUrl}/decisions`: any
failure behaves as if the checks were off, so a wrong endpoint would only show in the `decisions_failed` log.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | The switch for every Decisions call. |
| `baseUrl` | URL | `https://api.openai.com/v1` | Requests go to `{baseUrl}/decisions`. |
| `apiKeyEnv` | string | `OPENAI_API_KEY` | Empty for no authentication. |
| `model` | string | `gpt-6-luna` | |
| `timeoutSeconds` | number, 1 to 30 | `5` | Before a request is given up (it is retried once). |
| `dailyTokens` | integer, 0 or more | `2000000` | Input tokens per UTC day for every Decisions call, counted apart from `llm.dailyTokens`; 0 for no limit. Applies through the meter your code passes to `createConfiguredDecisions`. |
| `dmMessages` | integer, 1 to 20 | `6` | The person's newest messages (since the persona's last reply) sent with each DM check. |
| `minor.enabled` | boolean | `true` | Whether to run the age check, only on channels with `adult: true`: elsewhere the `minor` settings do not apply. |
| `minor.denyAt` | number, 0.5 to 1 | `0.9` | At or above: goodbye and deny list, like the code's own check. Only on channels with `adult: true`. |
| `minor.cautionAt` | number, 0.3 to 1 | `0.5` | At or above, below `denyAt`: flagged for every persona; their DM prompt on an 18+ channel then rules out any sexual or suggestive talk with them. Must not be above `denyAt`. Only on channels with `adult: true`. |
| `minor.groupChats` | boolean | `true` | Also check each line people write in group chats (`brain.checkGroupChatLine`), only in group chats with `adult: true`. |
| `stop.enabled` | boolean | `true` | Whether to run the stop check. |
| `stop.at` | number, 0.5 to 1 | `0.9` | At or above: treated as a stop, for good. |
| `importance.enabled` | boolean | `true` | How much their new messages matter (0 small talk to 3 something big), asked with the other DM checks, and ahead of a turn that comes due while others wait (alone when no other check is on), so the reply queue can weigh it (`pacing.priority`). Off, or on any failure, the model's own rating of their last turn is used. |
| `groupChatGate.enabled` | boolean | `true` | Whether to gate group chats (`brain.wantsToSpeak`). |
| `groupChatGate.addressedAt` | number, 0 to 1 | `0.5` | Speaks when the newest lines are addressed to it at or above this (0 always speaks). |
| `groupChatGate.chimeInAt.quiet` | number, 0 to 3 | `2.2` | "Chime in" score (0 intrude, 1 optional, 2 opening, 3 expected) at or above which a `quiet` persona speaks. |
| `groupChatGate.chimeInAt.easygoing` | number, 0 to 3 | `1.7` | For an `easygoing` persona. |
| `groupChatGate.chimeInAt.talkative` | number, 0 to 3 | `1.2` | For a `talkative` persona. |
| `groupChatGate.perHour` | integer, 1 or more | `120` | The most gate checks per group chat in any hour, counted by `wantsToSpeak` per its `chatId`; past it, it answers `null` without asking and the model decides. |

### `memory`

Per persona.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `personNotes` | integer, 0 to 2000 | `280` | Characters of notes on each person. |
| `selfNotes` | integer, 0 to 2000 | `800` | Characters of notes on itself, shared by all its conversations. |
| `historyMessages` | integer, 2 to 100 | `20` | Messages of the conversation sent with each turn. |
| `conversationGapHours` | number, 0.5 to 168 | `6` | Hours of silence from them after which their next message starts a new conversation. |

### `relationship`

Per persona. How it comes to know and like each person, kept for each of them in the store (`Person.familiarity`,
`Person.affinity`), and how the DM prompt describes it. Unknown keys here are refused.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `familiarity.growth` | number, 0 to 0.5 | `0.012` | The share of what is left to know (1 - familiarity) that one kept turn of an ordinary chat (importance 1) adds; small talk (0) adds a quarter of that, something personal (2) two and a half times, something that matters a lot (3) five times. |
| `familiarity.fadeHalfLifeDays` | number, 0 to 3650 | `60` | Days apart over which it halves, counted when they next write; `0` never fades. |
| `familiarity.levels` | list of `{ from, text }` | the shipped seven | The levels the prompt describes, lowest first: each from its `from` (0 to 1; the first is 0, each above the one before) up to the next, its `text` with `{name}` for their name. Replaces the shipped levels whole (`FAMILIARITY_LEVELS` in `prompts.ts`). |
| `affinity.enabled` | boolean | `true` | Off: the model is asked nothing about it, the prompt says nothing of it, and it weighs nothing in who goes first. |
| `affinity.step` | number, 0.001 to 0.5 | `0.05` | How far one turn moves it; the model answers -1 (a little cooler), 0 or 1 (a little warmer). |
| `affinity.fadeHalfLifeDays` | number, 0 to 3650 | `0` | Days apart over which it drifts halfway back to neutral; `0` never. |
| `affinity.levels` | list of `{ from, text }` | the shipped five | As `familiarity.levels`, from -1; an empty `text` says nothing (the shipped neutral level). Replaces `AFFINITY_LEVELS` whole. |
| `hysteresis` | number, 0 to 0.5 | `0.05` | How far below a level's `from` a value must fall before the level shown goes back down. |

The levels are set when a conversation starts (`memory.conversationGapHours`) and kept for all of it. Your own words,
with thresholds of your own:

```yaml
settings:
  relationship:
    familiarity:
      levels:
        - { from: 0, text: "{name} is new here; you're still a bit formal." }
        - { from: 0.25, text: "You and {name} chat often and easily." }
        - { from: 0.6, text: "{name} is a friend: you joke around and check in on each other." }
    affinity:
      enabled: false
```

### `pacing`

Per persona. Unknown keys here are refused.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `watching.halfLifeSeconds` | number, 1 to 3600 | `90` | While it writes a reply to anyone it is on its phone; after, the chance it still is starts at 1 and halves every this many seconds (an interruption since ends it). On its phone, a message from anyone is noticed after the short lag below. |
| `watching.chatHalfLifeSeconds` | number, 1 to 3600 | `90` | The same for one person's chat: the chance it still has it open, which weighs who goes first when several wait (`priority`). |
| `watching.medianSeconds` | number, 0.1 to 600 | `4` | The lag before it answers while watching (also every delay on a short break, when it is on its phone anyway): half are shorter. |
| `watching.p90Seconds` | number, 0.1 to 3600 | `8` | Nine in ten are shorter; above `medianSeconds`. |
| `watching.delaySeconds` | range | `[2, 20]` | The shortest and longest lag. |
| `glance.medianSeconds` | number, 1 to 3600 | `40` | Off its phone: the time until it next looks at its messages, drawn when the first message comes in; everyone who writes before that look is noticed at it, together. Half its looks come sooner. |
| `glance.p90Seconds` | number, 1 to 7200 | `150` | Nine in ten come sooner; above `medianSeconds`: how long the tail is. |
| `glance.delaySeconds` | range | `[4, 900]` | The shortest and longest of those; the least is also the shortest time a reply must still fit in its span. |
| `interruptions.meanMinutes` | `0`, or a number from 1 to 1440 | `40` | Now and then while online (not on a short break) something takes it away from its messages: on average once every this many minutes of online time. `0` for none. |
| `interruptions.minutes` | drawn range, lognormal | `[2, 8]` | How long each lasts. |
| `interruptions.holdAtImportance` | number, 0 to 4 | `2` | A conversation whose importance is at least this (0 small talk, 1 ordinary, 2 personal, 3 matters a lot), rated within the last `priority.importanceHalfLifeMinutes`, holds an interruption off while it goes on: an exchange within `calmMinutes`, or a turn of theirs under way or coming (not a retry or a wait for the budget). `4` never holds one off. |
| `interruptions.calmMinutes` | number, 0.5 to 120 | `5` | Minutes without an exchange after which such a conversation has calmed down: a held interruption comes then, for the time it had left (never past the end of its online time). Unknown keys under `watching`, `glance` and `interruptions` are refused too. |
| `priority.weighted` | boolean | `true` | When several are due at once: picked at random by weight (closeness, how much their conversation matters now, whether it still watches their chat, how long they waited). `false`: in the order they came due. |
| `priority.agingMinutes` | number, 0.1 to 120 | `2` | Minutes of waiting that add their whole weight again (1 + waited / agingMinutes): nobody waits forever. |
| `priority.importanceHalfLifeMinutes` | number, 1 to 1440 | `30` | Minutes over which the importance of their conversation fades halfway back to an ordinary chat's. |
| `typingCharsPerSecond` | drawn range, floor 0.5, normal | `[3.5, 7]` | The typing indicator shows for as long as the message would take. |
| `typingDurationSeconds` | range | `[1.5, 45]` | The shortest and longest typing time for one message (thinking pauses come on top). |
| `readingCharsPerSecond` | drawn range, floor 1, normal | `[15, 25]` | How fast it reads: before typing it waits as long as their unread messages (together) take to read, with or without a `markRead` receipt (see [channels](./channels.md#typing-read-receipts-and-thinking-pauses)). |
| `readingDurationSeconds` | range | `[1, 20]` | The shortest and longest that reading takes. |
| `thinkingPauses.chance` | number, 0 to 1 | `0` | The chance of each pause while a long message is typed (typing off a moment, then on again); `0`: none. |
| `thinkingPauses.minChars` | integer, 1 or more | `120` | The shortest message, in characters, that may have a pause. |
| `thinkingPauses.max` | integer, 1 to 3 | `2` | The most pauses in one message. |
| `thinkingPauses.seconds` | drawn range, lognormal | `[2, 6]` | How long each pause lasts; it adds to the typing time. Unknown keys under `thinkingPauses` are refused too. |
| `burst.settleSeconds` | drawn range, lognormal | `[2, 5]` | Quiet after their newest message before it starts writing the reply: a message in that time starts the wait again. `[0, 0]` for none. |
| `burst.maxSettleResets` | integer, 0 to 20 | `3` | The most messages that may start that wait again; past them it starts writing anyway. |
| `burst.restartOnNewMessage` | boolean | `true` | A message that comes in while it writes the reply, before the reply's first message is sent, drops the draft: it is written again with that message read. `false`: that message gets a turn of its own once this one is sent. |
| `burst.maxRestarts` | integer, 1 to 5 | `1` | The most times in a row one reply may be written again so. Each dropped draft was paid for (a whole DM turn of tokens): `personaWarnings` warns above 1. Unknown keys under `burst` are refused too. |
| `betweenReplyMessagesSeconds` | drawn range, lognormal | `[0.8, 3.5]` | Between two messages of the same reply. |
| `replySplitChance` | number, 0 to 1 | `0.35` | Chance that a single reply over 90 characters is sent as two messages. |
| `returnOnlineReplyDelayMinutes` | drawn range, lognormal | `[0, 0]` | Extra wait after a span opens, before its first backlog reply; `[0, 0]` for none. |
| `backlogGapSeconds` | drawn range, lognormal | `[30, 150]` | Before each backlog conversation. |

How a persona types is its own, like the rest of `pacing`: a quick typist gets `typingCharsPerSecond: [6, 9]` in its
file, a slow and careful one `[2.5, 4]` with a few thinking pauses:

```yaml
settings:
  pacing:
    typingCharsPerSecond: [2.5, 4]
    thinkingPauses:
      chance: 0.4
      seconds: [3, 8]
```

How soon it answers depends on what it is doing, not on a roll per message. While it chats with anyone it is on its
phone: a new message from anyone is noticed within seconds (`watching`), and the longer it goes without a turn, the
likelier it put the phone down. Not watching, it answers when it next glances at its messages
(`glance`): usually within a minute, now and then a few. Both are skewed the way real answer times are (log-normal):
set by a median (half come sooner) and a 90th percentile (how long the slow tail is), within bounds. Now and then
something takes it away for a few minutes (`interruptions`, drawn per day from a seed like the agenda, and listed by
the config check): nobody's turn starts then (one it is typing is finished first), and it watches no chat when it
comes back. Not in the middle of a conversation that matters, though: one that comes then is held off until that
conversation calms down (`holdAtImportance`, `calmMinutes`). Going offline at the end of its hours is its agenda's,
and comes whatever the conversation.

```yaml
settings:
  pacing:
    watching:
      halfLifeSeconds: 180    # stays on a chat longer
    interruptions:
      meanMinutes: 20         # easily distracted
      minutes: [1, 4]
```

A persona answers one person at a time, always: while it writes or sends a reply to someone, the others' turns wait,
and the first that came due starts the moment it is free (a turn under way for over 10 minutes stops holding them
back). Someone who writes in bursts gets one reply once they stop: with the defaults it waits 2 to 5 seconds of quiet
after their newest message, and a message that lands while the reply is being written makes it write the reply again,
once, with that message read:

```yaml
settings:
  pacing:
    burst:
      settleSeconds: [3, 6]       # a slower reader of bursts
      restartOnNewMessage: false  # never drop a draft: a late message gets its own reply
```

Each message is typed for its length at a speed drawn from `typingCharsPerSecond`, plus 0.4 to 1.5 seconds, kept
within `typingDurationSeconds`; a message of `thinkingPauses.minChars` or more then gets each of up to
`thinkingPauses.max` pauses with `thinkingPauses.chance`, its typing time cut into equal stretches around them.

### `context`

Per persona. `false` leaves that text out of the prompt; nothing else changes (hours, presence and pacing included).

| Key | Type | Default | What the model is told |
| --- | --- | --- | --- |
| `situation` | boolean | `true` | What it is doing now; in a DM near the end of a span, the wrap-up. |
| `upcoming` | boolean | `true` | What comes next and when it is online again. |
| `awayContext` | boolean | `true` | In DMs, that their messages came in while it was offline. |
| `relationship` | boolean | `true` | In DMs, how well it knows and likes the person, and how that went lately (`relationship`). |
| `timeSince` | boolean | `true` | How long since each side wrote in DMs, and since the last line in a group chat. |

### `retries`

Per persona.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `attempts` | integer, 1 to 10 | `3` | Failed tries at one answer before giving up (the person can write again). A spent budget or a provider outage counts none. |
| `delayMinutes` | drawn range, uniform | `[1, 4]` | Before the next try, times the attempt number; through an outage, doubled after each try, up to 16 times. |
| `budgetCheckMinutes` | number, 1 or more | `60` | While the day's tokens are spent, minutes between checks. |

## Errors and warnings

`loadPersonas` and `parsePersonas` never throw on a config problem. They answer a `LoadedPersonas`:

- `issues`: every problem, as text. A persona with a problem of its own is left out of `personas`; while
  `_shared.yaml`'s settings have problems, no persona is loaded.
- `personas`: the valid personas, in the order asked for.
- `shared`: `_shared.yaml`'s settings over the defaults, when they have no problem.

What is valid but probably wrong is not their concern: [`personaWarnings`](#check-helpers) gives those warnings.

Each issue names its file and path, and the value it got when that helps:

```text
robin.yaml › settings.pacing.replySplitChance: Number must be less than or equal to 1 (got 1.5)
robin.yaml › settings.pacng: not a setting (did you mean "pacing"?)
robin.yaml › settings.llm: cannot be set per persona: the text provider and its daily cap are shared (a persona may name its own models in settings.models)
robin.yaml › schedule.days: no plan for sat, sun (add them, or "sat,sun: {}" for days with nothing)
_shared.yaml › name: is each persona's own, not a default
no file personas/kai.yaml
```

A key the schema doesn't know is always an error, with the nearest known key (an edit distance of 2 at most). To stop
on problems, throw a `ConfigError(file, issues, warnings)`: its message lists them.

## Check helpers

For a config check command (none of them starts anything or touches the network):

- **`personaWarnings(persona, channels)`**: what is valid but probably wrong: a time zone that is no city's (an
  abbreviation or a fixed offset), a weekday over 20 hours online, under an hour a day on average, more than every
  other day skipped, one of `channels` that no span ever includes (its DMs would wait forever), and no text provider.
- **`personaReport(persona, { shared, now, status? })`**: lines describing what is in effect: its prompt file, what it
  is doing now (or `status`), today's and tomorrow's agenda, its settings that differ from `shared`, its models, its
  character and today's mood.
- **`samplePrompt({ persona, identity?, style?, channel, extraLines?, now, policy? })`**: the system prompt of a sample DM turn on
  `channel`, built by the brain itself on a throwaway in-memory store. Offline at `now`, it is taken a minute into the
  next span on that channel, so the lines about its day show.
