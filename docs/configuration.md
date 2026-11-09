# Configuration

A persona is two things: its **config**, the data the code computes with (its id, name, time zone and hours),
and its **prompt**, free Markdown: who it is, how it talks, what it knows. `parsePersona({ config, prompt, channels })`
checks the two, from wherever your app keeps them. The one file format soulframe reads, and only if you want it, is
a Markdown file per persona with its config as YAML frontmatter (`loadPersonas`, `parsePersonaMarkdown`).

What a brain runs with (its models, memory, pacing, which typed checks it asks) is its **settings**: you give them to
`createBrain({ persona, settings })` and read them with `parseSettings`; a persona may set
[its own pacing and relationship](#its-own-pacing-and-relationship) over them. What every persona
shares (the text provider's daily budget, the Decisions client) is the **service settings**, set once
(`parseServiceSettings`).

Everything below is taken from the package's schemas (`src/config/personas.ts`, `src/config/hours.ts`,
`src/settings.ts`).

- [A persona file](#a-persona-file)
- [The config](#the-config)
- [The prompt](#the-prompt)
- [`schedule`](#schedule)
- [Its own pacing and relationship](#its-own-pacing-and-relationship)
- [Your own loader](#your-own-loader)
- [`settings`](#settings): [`models`](#models), [`perception`](#perception), [`decisions`](#decisions),
  [`memory`](#memory), [`relationship`](#relationship), [`pacing`](#pacing), [`context`](#context), [`retries`](#retries)
- [Service settings](#service-settings): [`text`](#text), [`decisions` (the client)](#decisions-the-client)
- [Errors and warnings](#errors-and-warnings)
- [Check helpers](#check-helpers)
- [Coming from 0.1.0-beta.1](#coming-from-010-beta1)

## A persona file

```text
personas/
├── robin.md     one file per persona; the file name (without .md) is its id
└── kai.md
```

[`examples/personas/robin.md`](../examples/personas/robin.md):

```markdown
---
name: Robin
timezone: Europe/Lisbon
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
---

You are Robin, 29, living in a small coastal town with a ginger cat called Biscuit. You work in a bookshop and
spend your evenings on board games, baking and whatever indie record a friend sent you last.

You are warm and curious, quick to ask a follow-up question and slow to give advice nobody asked for. You write in
lowercase, in short messages, and you like a good story more than a clever one.

You don't talk about politics or religion: you change the subject, kindly.
```

The frontmatter is the YAML between the `---` line the file starts with and the next `---` line: the persona's
config. The rest of the file, trimmed, is its prompt. `id` may be left out (the file's name gives it); written, it
must be the file's name.

`loadPersonas({ dir, channels })` reads `<dir>/<id>.md` for each key of `channels`, whose value lists the channel ids
that persona is on (the names its hours' `on:` may use). `parsePersonaMarkdown(text, { id, channels })` reads one file's
text, for files you read yourself (a bundler, remote storage). Both take `adult: true` for personas used in 18+
conversations: a busy reason about school is then refused (see [`schedule`](#schedule)). Neither is required: see
[your own loader](#your-own-loader).

## The config

Only what the code computes with: who the persona is to the code, and its hours and their time zone. Everything it
says is its prompt's; how its brain runs is its [settings](#settings).

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | 2 to 32 of `a-z`, `0-9` and `-` (`PERSONA_ID`) | required (a file's name gives it) | The key of everything stored about it, and the seed of its days. |
| `name` | string, 1 to 32 characters | required | The name it goes by: in its identity line, and how group chats and the typed checks name it. |
| `timezone` | IANA time zone | required | e.g. `America/Toronto`. Checked with `Intl`; a near miss gets a suggestion. |
| `schedule` | [schedule](#schedule) | required | Its hours by weekday. |
| `pacing` | any keys of [`pacing`](#pacing) | none | [Its own](#its-own-pacing-and-relationship), over its brain's. |
| `relationship` | any keys of [`relationship`](#relationship) | none | [Its own](#its-own-pacing-and-relationship), over its brain's. |
| `initiative` | any keys of [`initiative`](#initiative) | none | [Its own](#its-own-pacing-and-relationship), over its brain's: whether and how it texts first. |

A key the schema doesn't know is an error, with the nearest known one; a key the 0.1 betas read says where it went
(see [Coming from 0.1.0-beta.1](#coming-from-010-beta1)).

## The prompt

The persona's voice and background, in Markdown: the body of its file, or `parsePersona`'s `prompt`. It is first in
every system prompt (DMs, group chats, posts), trimmed, written by you; soulframe adds nothing to it. What used to be
fixed config (facts about it, its interests, its own limits, how much it talks in group chats) is written here, in
your words. A limit every persona
keeps belongs in your `policy.rules` ([concepts](./concepts.md#safeguards-and-policy)), which come after the prompt and
win over it. See [system prompts](./prompts.md#the-persona-prompt).

## `schedule`

Its hours by weekday, local to its `timezone`. Times are written `"HH:MM"` on a 24-hour clock. A **clock range** is
`[earliest, latest]`; an exact time is drawn in it each day. A latest before the earliest is on the next day
(`["23:30", "00:30"]`), and an end whose earliest is at or before the start's earliest is on the next day too, so a
block can run past midnight. It still belongs to the day whose plan made it.

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

**`on:`** may only name the persona's own channels, the ones `parsePersona`'s `channels` gives for it (`loadPersonas`'
`channels[id]`). A name that is not one of them is an error with a suggestion.

**Checks**, made on the widest times the ranges allow so a valid schedule is valid on every date:

- a range spanning over 12 hours (likely swapped earliest and latest);
- an end that can come before its start;
- a block that can last over 20 hours;
- blocks that can overlap, within a day and into the next one (`sun` into `mon` too); blocks may touch;
- a break must be inside one busy block's core (from its latest start to its earliest end: a break from it) or clear
  of it;
- a busy reason may not be sleep ("bed", "nap", ...: the night is simply offline); parsed with `adult: true`, it may
  not be about school or students either ("at an evening class" at most).

The same hours every day are one online block under `mon-sun`:

```yaml
schedule:
  skipDayChance: 0.1
  days:
    mon-sun:
      online:
        - start: ["19:00", "20:00"]
          end: ["23:00", "00:30"]
```

## Its own pacing and relationship

A persona's config may set its own `pacing`, `relationship` and `initiative`, only the keys it changes, written as in
[the settings](#settings):

```yaml
pacing:
  typingCharsPerSecond: [2.5, 5]
relationship:
  familiarity: { growth: 0.008 }
initiative: { enabled: false }   # a shy one never texts first, whatever its brain's settings say
```

They are merged over its brain's settings key by key (a list or a range replaces whole, keeping the shape the brain's
settings give a drawn range; `null` is back to the default), and `createBrain` runs with the result (`brain.settings`). `parsePersona` and the loaders check them over the `settings` you give them (the
defaults unless given): give the ones its brain will run with, since `createBrain` checks again and throws a
`ConfigError` if they don't fit.

## Your own loader

The file format is a convenience. Keep personas anywhere (a database, JSON, values in code) and hand each one to
`parsePersona`:

```ts
import { parsePersona } from 'soulframe';

const { persona, issues } = parsePersona({
	config: { id: 'robin', name: 'Robin', timezone: 'Europe/Lisbon', schedule: { days: { 'mon-sun': { online: [{ start: ['19:00', '20:00'], end: ['23:00', '00:30'] }] } } } },
	prompt: 'You are Robin, 29, living in a small coastal town...',
	channels: ['chat'],
	source: 'robin (database)', // named before each problem
});
if (!persona) throw new Error(issues.join('\n'));
```

It runs the same checks as the loaders: the schema, unknown keys, the hours and the `on:` channels.

## `settings`

What a brain runs with: `createBrain({ persona, settings })`, and the same settings to `llmsFor` for its model client.
One settings object for every persona is the usual; a persona whose brain needs others (a cheaper model) gets its own. Keep them wherever your app keeps its config, and read them with
`parseSettings(raw, { source })`: like the persona parsers it fills in every default, never throws, and answers every
problem. `createBrain` needs them: `parseSettings({})` gives every default.

What every persona shares is not here: the text provider's daily budget and the Decisions client are the
[service settings](#service-settings), set once.

[`examples/settings.yaml`](../examples/settings.yaml):

```yaml
models:
  default:
    baseUrl: https://api.provider.example/v1
    apiKeyEnv: LLM_API_KEY
    model: provider-chat-large
  groupChat:
    model: provider-chat-small
```

```ts
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { ConfigError, parseSettings } from 'soulframe';

const { settings, issues } = parseSettings(parse(readFileSync('settings.yaml', 'utf8')), { source: 'settings.yaml' });
if (!settings) throw new ConfigError('settings.yaml', issues);
```

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
pacing:
  backlogGapSeconds: [20, 90]                              # still lognormal
  typingCharsPerSecond: { range: [4, 8], shape: uniform }
```

### `models`

The text provider and a model per kind of task, for text generation only (never read by `decisions`). `default` is
the provider and model of every task that names none; a task may name a cheaper model (group chats are frequent and
mostly a decision to stay quiet) or move to a provider of its own.

`default`:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | URL | none | An OpenAI-compatible base URL, e.g. `https://api.provider.example/v1`. Without one (and no text task's own), the persona has no provider: `llmsFor` gives it the canned model in a dry run, else refuses. |
| `apiKeyEnv` | string | `LLM_API_KEY` | The key's environment variable; empty for a provider without authentication. |
| `model` | string | none | The model of every text task that doesn't name its own (never `vision`'s). |
| `jsonMode` | boolean | `false` | Ask for strict JSON (`response_format: json_object`), for providers that support it. |
| `timeoutSeconds` | number, 5 to 300 | `60` | Before a request is given up (it is retried once). |

`default` is no task: it holds the connection only. Each task's answer limits are its own:

| Task | `maxTokens` default | `temperature` default |
| --- | --- | --- |
| `directMessage`: a DM turn (reply, notes, action) | `400` | `0.9` |
| `groupChat`: whether to say something in a group chat, and what | `100` | `0.9` |
| `post`: a post | `160` | `1` |
| `vision`: describing a photo someone sent in a DM, once | `200` | `0.2` |
| `initiative`: a first message it sends on its own ([`initiative`](#initiative)), called only while that is on | `300` | `0.9` |

Each task takes:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `model` | string | `default.model` | The model's name at its provider. |
| `baseUrl` | URL | `default.baseUrl` | A provider of its own for this task only (see below). |
| `apiKeyEnv` | string | `default.apiKeyEnv` on the default provider | Empty disables authentication. |
| `jsonMode` | boolean | `default.jsonMode` on the default provider, off on its own | |
| `timeoutSeconds` | number, 5 to 300 | `default.timeoutSeconds` | |
| `maxTokens` | integer, 16 to 4000 | see above | The most tokens the answer may hold. |
| `temperature` | number, 0 to 2 | see above | Higher is more varied. Left out of the request to OpenAI's own `gpt-5` models (at `api.openai.com`). |

**A task on a provider of its own** (its own `baseUrl`) takes nothing of the default provider but its timeout: no key,
no model, no `jsonMode`. It names its own `model` and `apiKeyEnv` (empty for none), and `parseSettings` refuses it
otherwise, so the default provider's key is never sent to another host:

```yaml
models:
  default:
    baseUrl: https://api.provider.example/v1
    model: provider-chat-large
  groupChat:
    baseUrl: http://localhost:11434/v1   # a local model for the frequent group-chat calls
    apiKeyEnv: ''
    model: llama3.2
```

Once a provider is set, every text task must have a model: its own, or `default.model` on the default provider
(`initiative` only once `initiative.enabled` is on).

`vision` is the exception: it is optional and off until it names a model of its own. It never takes `default.model`,
which may not take images. Left out, a photo is only its `alt`, else it shows as not loading. If your chat model takes
images, name it here too.

### `perception`

What comes with a message in a DM (see [attention](./attention.md#perception-photos-and-links)).

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `descriptionChars` | integer, 40 to 2000 | `400` | Characters of a photo's description, stored with the message and sent with every turn it stays in the history. |
| `imagesPerMessage` | integer, 0 to 10 | `4` | The most photos of one message that are looked at; 0 for none. |
| `linksPerMessage` | integer, 0 to 10 | `3` | The most links of one message it notices; 0 leaves them plain text, with no rule against claiming to have opened them. |
| `timeoutSeconds` | number, 1 to 120 | `15` | How long a photo's description or a link's card may take; past it, the reply goes on without. |

### `decisions`

Which typed checks a brain asks of the Decisions client, and the thresholds that act on the answers (see
[concepts](./concepts.md#decisions-optional-typed-checks)). Whether any check runs at all, and the client itself, are
the [service settings'](#service-settings) `decisions`: one client for every persona. Nothing here falls back to
`models`.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
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
| `groupChatGate.chimeInAt` | number, 0 to 3 | `1.7` | "Chime in" score (0 intrude, 1 optional, 2 opening, 3 expected) at or above which it speaks: higher for a persona that rarely speaks unasked (about `2.2` waits for a clear opening), lower for a chatty one (about `1.2` takes even an optional remark). Give such a persona's brain its own. |
| `groupChatGate.perHour` | integer, 1 or more | `120` | The most gate checks per group chat in any hour, counted by `wantsToSpeak` per its `chatId`; past it, it answers `null` without asking and the model decides. |

### `memory`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `personNotes` | integer, 0 to 2000 | `280` | Characters of notes on each person. |
| `selfNotes` | integer, 0 to 2000 | `800` | Characters of notes on itself, shared by all its conversations. |
| `historyMessages` | integer, 2 to 100 | `20` | Messages of the conversation sent with each turn. |
| `conversationGapHours` | number, 0.5 to 168 | `6` | Hours of silence from them after which their next message starts a new conversation. |

### `relationship`

Explained in full, with the reply timing and who goes first, in
[attention, timing and relationships](./attention.md#relationship-getting-to-know-and-like-each-person). How it comes to know and like each person, kept for each of them in the store (`Person.familiarity`,
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

What the timing settings mean together, in plain terms: [attention, timing and relationships](./attention.md).

Unknown keys here are refused.

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
| `looking` | drawn | `[1.5, 5]`, lognormal | Seconds it spends on each photo, on top of the reading. |
| `thinkingPauses.chance` | number, 0 to 1 | `0` | The chance of each pause while a long message is typed (typing off a moment, then on again); `0`: none. |
| `thinkingPauses.minChars` | integer, 1 or more | `120` | The shortest message, in characters, that may have a pause. |
| `thinkingPauses.max` | integer, 1 to 3 | `2` | The most pauses in one message. |
| `thinkingPauses.seconds` | drawn range, lognormal | `[2, 6]` | How long each pause lasts; it adds to the typing time. Unknown keys under `thinkingPauses` are refused too. |
| `burst.settleSeconds` | drawn range, lognormal | `[2, 5]` | Quiet after their newest message before it starts writing the reply: a message in that time starts the wait again. `[0, 0]` for none. |
| `burst.maxSettleResets` | integer, 0 to 20 | `3` | The most messages that may start that wait again; past them it starts writing anyway. |
| `burst.restartOnNewMessage` | boolean | `true` | A message that comes in while it writes the reply, before the reply's first message is sent, drops the draft: it is written again with that message read. `false`: that message gets a turn of its own once this one is sent. |
| `burst.maxRestarts` | integer, 1 to 5 | `1` | The most times in a row one reply may be written again so. Each dropped draft was paid for (a whole DM turn of tokens): `settingsWarnings` warns above 1 (`personaWarnings` for a persona's own). Unknown keys under `burst` are refused too. |
| `betweenReplyMessagesSeconds` | drawn range, lognormal | `[0.8, 3.5]` | Between two messages of the same reply. |
| `replySplitChance` | number, 0 to 1 | `0.35` | Chance that a single reply over 90 characters is sent as two messages. |
| `returnOnlineReplyDelayMinutes` | drawn range, lognormal | `[0, 0]` | Extra wait after a span opens, before its first backlog reply; `[0, 0]` for none. |
| `backlogGapSeconds` | drawn range, lognormal | `[30, 150]` | Before each backlog conversation. |

How a persona types is its brain's settings, like the rest of `pacing`: a quick typist's brain gets
`typingCharsPerSecond: [6, 9]`, a slow and careful one's `[2.5, 4]` with a few thinking pauses:

```yaml
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
pacing:
  burst:
    settleSeconds: [3, 6]       # a slower reader of bursts
    restartOnNewMessage: false  # never drop a draft: a late message gets its own reply
```

Each message is typed for its length at a speed drawn from `typingCharsPerSecond`, plus 0.4 to 1.5 seconds, kept
within `typingDurationSeconds`; a message of `thinkingPauses.minChars` or more then gets each of up to
`thinkingPauses.max` pauses with `thinkingPauses.chance`, its typing time cut into equal stretches around them.

### `context`

`false` leaves that text out of the prompt; nothing else changes (hours, presence and pacing included).

| Key | Type | Default | What the model is told |
| --- | --- | --- | --- |
| `situation` | boolean | `true` | What it is doing now; in a DM near the end of a span, the wrap-up. |
| `upcoming` | boolean | `true` | What comes next and when it is online again. |
| `awayContext` | boolean | `true` | In DMs, that their messages came in while it was offline. |
| `relationship` | boolean | `true` | In DMs, how well it knows and likes the person, and how that went lately (`relationship`). |
| `timeSince` | boolean | `true` | How long since each side wrote in DMs, and since the last line in a group chat. |

### `retries`

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `attempts` | integer, 1 to 10 | `3` | Failed tries at one answer before giving up (the person can write again). A spent budget or a provider outage counts none. |
| `delayMinutes` | drawn range, uniform | `[1, 4]` | Before the next try, times the attempt number; through an outage, doubled after each try, up to 16 times. |
| `budgetCheckMinutes` | number, 1 or more | `60` | While the day's tokens are spent, minutes between checks. |

### `initiative`

Texting first, off by default: the persona may start a DM conversation itself, through its reply queue, with someone
who wrote to it before, on a channel the app allows (`queue.allowInitiative`). The code decides who and when, with
guardrails no setting relaxes; the model decides whether to text and what, and may decline. See
[concepts](./concepts.md#texting-first).

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Whether it ever texts first. Off, nothing below runs and no prompt says anything of it. |
| `perDay` | integer, 1 to 20 | `2` | The most first messages (openers) it sends in any 24 hours, every kind together. |
| `personGapHours` | number, 1 to 720 | `48` | At least this long between two openers to the same person, doubled for each one in a row they ignored (they wrote only after this long, or not at all). |
| `spanEndMinutes` | number, 1 to 120 | `20` | Minutes of its online time that must be left when an opener goes: it stays around for the answer. |
| `followUps.enabled` | boolean | `true` | A DM turn may plan a follow-up: texting them again about something still ahead of them (an interview, a trip) or something it promised. One plan per person. |
| `followUps.maxDays` | integer, 0 to 30 | `14` | The furthest ahead one may be planned, in days (0: later the same day). |

Each opener costs about one DM turn of tokens, sent or declined, from the share of the daily budget DMs don't keep for
themselves (the service settings' [`text.directMessageReserve`](#text)): openers stop before replies run short. A
failed or budget-refused opener is not tried again.

## Service settings

What the whole service shares, set once and never per brain: the text provider's daily budget, which every persona's
model client spends together (one meter, one limit of requests in flight), and the Decisions client, one for every
persona. Read them with `parseServiceSettings(raw, { source })`, as `parseSettings` reads a brain's, and build the
shared pieces from them. [`examples/service.yaml`](../examples/service.yaml):

```yaml
text:
  dailyTokens: 400000
decisions:
  enabled: true
```

```ts
import { ConfigError, createConfiguredDecisions, createTokenMeter, llmsFor, parseServiceSettings } from 'soulframe';

const { service, issues } = parseServiceSettings(parse(readFileSync('service.yaml', 'utf8')), { source: 'service.yaml' });
if (!service) throw new ConfigError('service.yaml', issues);
const meter = createTokenMeter(store, service.text.dailyTokens, runtime.now);
const llms = llmsFor(personas.map(({ id }) => ({ id, settings })), { dryRun, apiKeyOf, meter, budget: service.text });
const decisions = createConfiguredDecisions({ settings: service.decisions, apiKeyOf, meter: createTokenMeter(store, service.decisions.dailyTokens, runtime.now, 'decisionTokens'), now: runtime.now });
```

### `text`

The text provider's budget, for every persona together.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `dailyTokens` | integer, 0 or more | `200000` | Tokens per UTC day for every persona together; 0 for no limit. At the shipped prompt sizes a DM turn is about 3,500 to 4,000 tokens, so the default buys about 55 DM turns a day: size it to your fleet. Spent through the meter you build with it (`createTokenMeter`) and pass to `llmsFor`. |
| `directMessageReserve` | number, 0 to 0.9 | `0.3` | The share of `dailyTokens` kept for DMs and their photos: group chats and posts stop once the rest is spent. |
| `concurrency` | integer, 1 to 32 | `4` | The most text model requests in flight for every persona together; the others wait their turn. |

### `decisions` (the client)

The Decisions API client. Off by default: turning it on sends people's messages, the personas' replies and group-chat
lines to `baseUrl`. Before you turn it on, check that the endpoint and model you use (the defaults below, or your own)
answer `{baseUrl}/decisions`: any failure behaves as if the checks were off, so a wrong endpoint would only show in the
`decisions_failed` log. While `enabled` is off, `createConfiguredDecisions` gives the disabled client: nothing is ever
sent, for any persona.

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | The switch for every Decisions call. |
| `baseUrl` | URL | `https://api.openai.com/v1` | Requests go to `{baseUrl}/decisions`. |
| `apiKeyEnv` | string | `OPENAI_API_KEY` | Empty for no authentication. |
| `model` | string | `gpt-6-luna` | |
| `timeoutSeconds` | number, 1 to 30 | `5` | Before a request is given up (it is retried once). |
| `dailyTokens` | integer, 0 or more | `2000000` | Input tokens per UTC day for every Decisions call, counted apart from text generation; 0 for no limit. Spent through the meter you pass to `createConfiguredDecisions`. |

## Errors and warnings

None of `parsePersona`, `parsePersonaMarkdown`, `loadPersonas`, `parseSettings` and `parseServiceSettings` throws on a
config problem:

- `parsePersona` and `parsePersonaMarkdown` answer `{ persona?, issues }`: no persona while there is any problem;
- `loadPersonas` answers `{ personas, issues }`: a persona with a problem is left out, the others are loaded, in the
  order asked for;
- `parseSettings` answers `{ settings?, issues }`, and `parseServiceSettings` `{ service?, issues }`: none while there is
  any problem.

A file the 0.1 betas read, left in the folder (`_shared.yaml`, an `<id>.yaml` beside its `<id>.md`), is a problem too:
`loadPersonas` then loads no persona it may have set something for, so a shared `sfw` or limit is never quietly lost.

What is valid but probably wrong is not their concern: [`personaWarnings` and `settingsWarnings`](#check-helpers) give
those warnings.

Each issue names its source and path, and the value it got when that helps: `<source> › <path>: …` for a key,
`<source>: …` for the whole of it (a file with no frontmatter, a YAML error, a config that is no mapping):

```text
personas/robin.md › schedule.days: no plan for sat, sun (add them, or "sat,sun: {}" for days with nothing)
personas/robin.md › nmae: unknown key (did you mean "name"?)
personas/robin.md › sfw: is the brain's policy now: createBrain({ policy: { sfw: true } })
personas/kai.md: no frontmatter: a persona file starts with its config between two --- lines
settings.yaml › pacing.replySplitChance: Number must be less than or equal to 1 (got 1.5)
settings.yaml › pacng: unknown key (did you mean "pacing"?)
settings.yaml › models.groupChat.apiKeyEnv: on a provider of its own (its baseUrl), it names its own key variable ('' for none): the default one is never sent to another host
no file personas/sky.md
```

A key the schema doesn't know is always an error, with the nearest known key (an edit distance of 2 at most). To stop
on problems, throw a `ConfigError(file, issues, warnings)`: its message lists them.

## Check helpers

For a config check command (none of them starts anything or touches the network):

- **`personaWarnings(persona, channels)`**: what is valid but probably wrong in a persona: a time zone that is no
  city's (an abbreviation or a fixed offset), a weekday over 20 hours online, under an hour a day on average, more than
  every other day skipped, one of `channels` that no span ever includes (its DMs would wait forever), and its own
  `pacing.burst.maxRestarts` above 1.
- **`settingsWarnings(settings)`**: the same for settings: a reply that may be written again more than once
  (`pacing.burst.maxRestarts`), and no text provider.
- **`personaReport(persona, { settings, now, status? })`**: lines describing what is in effect: its prompt's length,
  what it is doing now (or `status`), today's and tomorrow's agenda, today's
  interruptions and its models.
- **`samplePrompt({ persona, settings, identity?, style?, channel, extraLines?, now, policy? })`**: the system prompt of
  a sample DM turn on `channel`, built by the brain itself on a throwaway in-memory store. Offline at `now`, it is
  taken a minute into the next span on that channel, so the lines about its day show.

## Coming from 0.1.0-beta.1

| Before | Now |
| --- | --- |
| `<id>.yaml`, its prompt in `<id>.md` | `<id>.md`: the YAML as its frontmatter, the prompt after it |
| `_shared.yaml` | Gone: each persona's config is its own. Settings go to each brain (one object for all, or one of their own); a limit every persona keeps goes in `policy.rules` |
| `prompt: robin.md` | The file's body, or `parsePersona`'s `prompt` |
| `window: { start, end, skipDayChance }` | `schedule: { skipDayChance, days: { mon-sun: { online: [{ start, end }] } } }` (the same hours drawn) |
| `chattiness: quiet` | Gone: say in the prompt how much it talks in group chats; with the group-chat gate on, how readily it speaks is its brain's `decisions.groupChatGate.chimeInAt` (`2.2` was quiet's, `1.7` easygoing's, `1.2` talkative's) |
| `sfw: true` | `createBrain({ policy: { sfw: true } })` |
| `character.facts`, `interests`, `boundaries` | In the prompt, in your words |
| `character.moods` | Gone: soulframe picks no mood. A mood that follows what happens is planned ([roadmap](./roadmap.md)) |
| `settings:` in a persona's file or `_shared.yaml` | `parseSettings`, then `createBrain({ settings })` and `llmsFor`; a persona's own `pacing` and `relationship` are keys of its config |
| `settings.llm.baseUrl`, `apiKeyEnv`, `model`, `jsonMode`, `timeoutSeconds` | `models.default.*` |
| `settings.llm.dailyTokens`, `directMessageReserve`, `concurrency` | The service settings' `text` (`parseServiceSettings`); `llmsFor` takes it as `budget` in place of `concurrency` |
| `settings.decisions.enabled`, `baseUrl`, `apiKeyEnv`, `model`, `timeoutSeconds`, `dailyTokens` | The service settings' `decisions`, given to `createConfiguredDecisions` (the thresholds stay in each brain's `settings.decisions`) |
| A task with its own `baseUrl` using `llm.apiKeyEnv` and `llm.model` | Name its own `apiKeyEnv` (`''` for none) and `model`: the default provider's are never sent to another host |
| `parsePersonas({ shared, personas, channels, readPrompt })` | `parsePersona({ config, prompt, channels })` per persona |
| `createReplyQueue({ persona, brain, runtime, act })` | `createReplyQueue({ brain, runtime, act })`: the persona and settings are the brain's |
| `personaReport(persona, { shared, now })` | `personaReport(persona, { settings, now })` |
| The provider and budget warnings of `personaWarnings` | `settingsWarnings(settings)` |
