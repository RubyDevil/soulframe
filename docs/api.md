# API reference

Everything below is exported by `src/index.ts`, the package's only public module:

```ts
import { createBrain, createReplyQueue, createStore, loadPersonas /* ... */ } from 'soulframe'; // ESM or TypeScript
```

```js
const { createBrain, createReplyQueue, createStore, loadPersonas /* ... */ } = require('soulframe'); // CommonJS
```

Anything not listed here is internal. Signatures are simplified where the source infers a type; times are
milliseconds since the epoch, durations milliseconds, unless a name says otherwise. A few types that appear in
signatures are not exported themselves; each is named with the way to reach it:

| Type in a signature | Not exported; reach it as |
| --- | --- |
| `ScheduleConfig` | `PersonaConfig['schedule']` |
| `Turn` | `Awaited<ReturnType<Brain['compose']>>` |
| `TokenMeter` | `ReturnType<typeof createTokenMeter>` |
| `Question`, `Answers` | `Parameters<Decisions['ask']>[1]`, `Awaited<ReturnType<Decisions['ask']>>` |

- [Persona config](#persona-config)
- [Config problems](#config-problems)
- [Settings and units](#settings-and-units)
- [Value helpers](#value-helpers)
- [Check helpers](#check-helpers)
- [Channels](#channels)
- [The brain](#the-brain)
- [The reply queue and runtime](#the-reply-queue-and-runtime)
- [Hours](#hours)
- [Memory](#memory)
- [Text generation](#text-generation)
- [Decisions](#decisions)
- [Small helpers](#small-helpers)

## Persona config

A persona is its config (the data the code computes with) and its prompt (free Markdown). `parsePersona` checks the
two from wherever the application keeps them; `parsePersonaMarkdown` and `loadPersonas` read the one file format the
package offers, a Markdown file per persona with its config as YAML frontmatter. See [configuration](./configuration.md).

### `parsePersona`

```ts
function parsePersona(options: {
	config: unknown;                    // id, name, timezone, schedule, moods?, traits?
	prompt: string;                     // the persona's voice and background, in Markdown
	channels: readonly ChannelId[];     // the channels it is on: the names its hours' `on:` may use
	adult?: boolean;                    // for 18+ conversations: busy reasons about school are refused
	source?: string;                    // named before each problem ("robin.md › schedule: Required")
}): { persona?: Persona; issues: string[] };
```

A persona from its config and its prompt, checked: the schema (defaults filled in), unknown keys (each with the nearest
known one, and a key the 0.1 betas read with where it went), the hours, and the `on:` channels. Never throws: with any
problem there is no `persona`, and `issues` says what is wrong. The prompt is kept trimmed.

### `parsePersonaMarkdown`

```ts
function parsePersonaMarkdown(text: string, options: {
	id: string;                         // its id: the file's name without .md
	channels: readonly ChannelId[];
	adult?: boolean;
	source?: string;
}): { persona?: Persona; issues: string[] };
```

A persona from the text of its Markdown file: its config as YAML frontmatter, between the `---` line the file starts
with and the next one, and its prompt the rest. The frontmatter may leave `id` out, and must not say another. A
problem of the file as a whole (no frontmatter, a YAML error at the file's own line) starts `"<source>: "`, one of a key
`"<source> › <path>: "`. Otherwise as `parsePersona`.

### `loadPersonas`

```ts
function loadPersonas(options: {
	dir: string;
	channels: Readonly<Record<string, readonly ChannelId[]>>;
	files?: ConfigFiles;
	adult?: boolean;
}): LoadedPersonas;
```

Reads `<dir>/<id>.md` for each key of `channels` (`parsePersonaMarkdown`); `channels[id]` lists the channels that
persona is on. Never throws on a config problem: the caller reports `issues`. `files` defaults to `nodeFiles`.

### `nodeFiles`

```ts
const nodeFiles: ConfigFiles;
```

`ConfigFiles` on the local disk (`readFileSync`, `existsSync`).

### `PERSONA_ID`

```ts
const PERSONA_ID: RegExp; // /^[a-z0-9-]{2,32}$/
```

What a persona id (a persona file's name without `.md`) must match.

### `ConfigFiles`

```ts
interface ConfigFiles {
	read(path: string): string;
	exists(path: string): boolean;
}
```

How `loadPersonas` reads files, injected so tests stay off the disk.

### `LoadedPersonas`

```ts
interface LoadedPersonas {
	issues: string[];      // every problem; a persona with one is left out of personas
	personas: Persona[];   // the valid personas, in the order asked for
}
```

### `PersonaConfig`

```ts
interface PersonaConfig {
	id: string;
	name: string;
	timezone: string;
	schedule: ScheduleConfig;                     // its hours by weekday
	moods: { mood: string; weight: number }[];
	traits?: Traits;                              // optional sentences after its prompt
}
```

A persona's config, checked: only what the code computes with. It satisfies the `Hours` parameter of `spanAt`,
`fullyOnline` and `watchSpans` (`{ id, timezone, schedule }`).

### `Persona`

```ts
interface Persona extends PersonaConfig {
	prompt: string;  // its voice and background, trimmed: first in every system prompt
}
```

A persona: its config and its prompt. What `createBrain` takes.

### `Traits`

```ts
type Traits = {
	chattiness?: 'quiet' | 'easygoing' | 'talkative';
};
```

The optional `traits` of a persona's config: for each trait it sets, one of its values (a name, or a whole number of a
scale). See [configuration](./configuration.md#traits).

### `traitsPrompt`

```ts
function traitsPrompt(traits: Traits | undefined): string;
```

The sentences a persona's `traits` add right after its prompt, in every system prompt, as one paragraph (`''` without
traits): `traitsPrompt({ chattiness: 'quiet' })` is `"You are quiet in group chats."`. The same text every time, never
drawn. It does not read the persona's prompt: a trait that contradicts it tells the model two things at once, so write
each trait in one place, the prompt or `traits`.

## Config problems

### `Problems`

```ts
interface Problems {
	issues: string[];   // problems that refuse the config
	warnings: string[]; // worth showing, not refusing
}
```

### `ConfigError`

```ts
class ConfigError extends Error {
	constructor(file: string, issues: string[], warnings?: string[]);
	readonly file: string;
	readonly issues: string[];
	readonly warnings: string[];
}
```

Thrown by an application that refuses a config; its message lists the issues ("`<file>` has 2 problems: ...").

### `describe`

```ts
function describe(path: readonly (string | number)[], message: string, got: unknown): string;
```

A problem as shown: `"settings.pacing.replySplitChance: <message> (got 1.5)"`. `got` undefined shows no value; a long
one is cut at 40 characters.

### `suggest`

```ts
function suggest(key: string, known: readonly string[]): string;
```

`' (did you mean "pacing"?)'` for the nearest of `known` within an edit distance of 2 (case ignored), else `''`.

### `unknownKeys`

```ts
function unknownKeys(schema: z.ZodTypeAny, raw: unknown, path?: (string | number)[]): { path: (string | number)[]; suggestion?: string }[];
```

The keys in `raw` that a zod `schema` doesn't know (zod drops them silently), each with its path and the nearest known
key. Walks objects, records and arrays, through defaults, optionals and effects.

### `unknownKeyIssues`

```ts
function unknownKeyIssues(found: { path: (string | number)[]; suggestion?: string }[], at: readonly (string | number)[]): string[];
```

`unknownKeys`' results as issues under `at`: `"<path>: unknown key (did you mean ...)"`.

### `addQuietIssue`

```ts
function addQuietIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void;
```

Adds a custom zod issue marked quiet: `shownValue` gives no "(got ...)" for it. For refinements whose message already
says everything.

### `shownValue`

```ts
function shownValue(issue: z.ZodIssue, raw: unknown): unknown;
```

The value to show with a zod issue: the one at its path in `raw`, or `undefined` for a quiet issue.

## Settings and units

### `parseSettings`

```ts
function parseSettings(raw: unknown, options?: { source?: string }): { settings?: Settings; issues: string[] };
```

`raw` (parsed YAML or JSON, or values in code) read as settings, every setting it leaves out at its default: `undefined`,
`null` (an empty YAML file) and `{}` are every default. Never throws: with any problem (a value out of range, a key the
schema doesn't know, with the nearest one, a task with no model once a provider is set) there are no `settings`, and
each issue gives its path after `source › ` when given. See [configuration](./configuration.md#settings).

### `Settings`

```ts
type Settings = {
	llm: { /* ... */ };
	models: { directMessage: { /* ... */ }; groupChat: { /* ... */ }; post: { /* ... */ }; vision: { /* ... */ } };
	perception: { /* ... */ };
	decisions: { /* ... */ };
	memory: { /* ... */ };
	relationship: { /* ... */ };
	pacing: { /* ... */ };
	context: { /* ... */ };
	retries: { /* ... */ };
};
```

Every setting of a brain, defaults filled in: what `createBrain` and its reply queue run with, never part of a persona.
Each key is in [configuration](./configuration.md#settings). A drawn
range (a value drawn from it each time: `pacing.typingCharsPerSecond`, `pacing.backlogGapSeconds`,
`retries.delayMinutes`, …) is read as `{ range: [least, most], shape }`, whichever way the config wrote it; a range
that is only a limit stays `[least, most]`.

### `range`

```ts
function range(min: number, max: number, floor?: number): z.ZodType<[number, number]>;
```

The zod schema of a `[least, most]` setting: two numbers at or above `floor` (default 0), defaulting to `[min, max]`,
the first not above the second. For an application that declares its own settings the same way. Draw from it with
`between(rng, ...value)` (evenly); soulframe's own drawn ranges also carry a shape (see `Settings`).

### `SECOND`, `MINUTE`, `HOUR`, `DAY`

```ts
const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
```

## Value helpers

### `diffPaths`

```ts
function diffPaths(a: unknown, b: unknown, prefix?: string): string[];
```

The dotted paths where `b` differs from `a` (leaves and arrays compared whole), e.g. `['pacing.watching.halfLifeSeconds']`.

### `isPlainObject`

```ts
function isPlainObject(value: unknown): value is Record<string, unknown>;
```

An object that is neither `null` nor an array.

### `valueAt`

```ts
function valueAt(value: unknown, path: readonly (string | number)[]): unknown;
```

The value at `path` (object keys, array indexes), or `undefined`.

## Check helpers

### `personaWarnings`

```ts
function personaWarnings(persona: PersonaConfig, channels: readonly ChannelId[]): string[];
```

What is valid but probably wrong in a persona: a time zone that is no city's, a weekday over 20 hours online, under an
hour a day on average, more than every other day skipped, a channel of `channels` that no span ever includes.

### `settingsWarnings`

```ts
function settingsWarnings(settings: Settings): string[];
```

What is valid but probably wrong in settings: a reply that may be written again more than once
(`pacing.burst.maxRestarts`, each restart paid for), and no text provider (`llm.baseUrl`).

### `personaReport`

```ts
function personaReport(persona: Persona, options: { settings: Settings; now: number; status?: string }): string[];
```

Indented lines describing the persona, run with `settings` (its brain's): its prompt's length, the sentences its traits
add (`traitsPrompt`, to read against the prompt), now (or `status`), today's and tomorrow's agenda, today's
interruptions, its models, and its moods with today's.

### `samplePrompt`

```ts
function samplePrompt(options: {
	persona: Persona;
	settings?: Settings;
	identity?: string;
	style?: string;
	channel: Channel;
	extraLines?: (person: Person) => readonly string[];
	now: number;
	policy?: Policy;
}): Promise<string>;
```

The system prompt of a sample DM turn on `channel`, with your `settings`, `identity`, `style` and `policy` (as `createBrain` takes them), assembled by the brain on a throwaway
`:memory:` store with a model that only records what it is sent. Offline at `now`, it is taken a minute into the next span on `channel.id`.

## Channels

### `ChannelId`

```ts
type ChannelId = string;
```

A channel the application runs: opaque to the package. It keys the hours' `on:`, identities, the deny list and minor
flags.

### `Channel`

```ts
interface Channel {
	id: ChannelId;
	where: string;          // completes "chatting by text in ..."
	maxLength: number;      // the longest message sent here; a longer one is cut at a word
	targetLength?: number;  // the soft length of a group-chat line here; default 150, or 4/5 of maxLength when less
	identityNote?: string;  // appended word for word to the identity line
	notes?: readonly string[];  // what the model should know about this place, in its group-chat and post tasks
	invitations?: boolean;  // DM turns here may answer a pending group-chat invitation
	actions?: readonly ChannelAction[];  // what a DM turn may do here besides talking and blocking
	adult?: boolean;        // the conversations here are 18+
}
```

Where a conversation happens, as the application describes it to the brain. `targetLength` is the length the
group-chat task asks a line to stay under ("under N characters"); `maxLength` still cuts. Channels may add a disclosure note
(`identityNote`), and `notes`, word for word: a group-chat task lists them with its own instructions, a post task
gives them after its instruction (a DM turn's lines are `Conversation.extraLines`). `invitations` lets a DM turn
answer a pending group-chat invitation; `actions` offers the channel's own actions. Blocking is always offered.
`adult: true` turns on soulframe's one built-in safeguard, avoiding
minors, for conversations on this channel: the code's under-18 check of each incoming message (goodbye and deny
list), the Decisions age check and its caution, and the "You only talk with adults" rule line. Left out, none of it
runs or appears in a prompt.

### `ChannelAction`

```ts
interface ChannelAction {
	name: string;  // what the model answers in the action field, and what `act` receives
	when: string;  // completes `"<name>" …` in the answer format: when to choose it
}
```

Something a DM turn on the channel may choose besides talking, as `{ name: 'archive', when: 'when the conversation is
over and you would rather not pick it up again' }` renders `"archive" when the conversation is over …;` before the
`"block"` line. The reply queue hands a chosen action to `act`; the store audits it (`action`).

## The brain

### `createBrain`

```ts
function createBrain(options: {
	persona: Persona;
	settings?: Settings;   // what it runs with (parseSettings); every default when left out
	identity?: string;     // the phrase after its name in the identity line; none for the name alone
	style?: string;        // a block on how it writes, after the identity line; none by default
	runtime: Pick<Runtime, 'now' | 'rng' | 'store'>;  // its reply queue's runtime
	llm: Llm;
	decisions?: Decisions; // default DISABLED_DECISIONS
	policy?: Policy;       // default {}: no rules, no link filtering
	previewLink?: PreviewLink;  // gets the card of a link that came without one; none by default
}): Brain;
```

The brain runs with `settings`: models, limits, memory, pacing and the typed checks, never part of the persona. Its
reply queue reads them, and the persona, from the brain (`brain.settings`, `brain.persona`), so the two never differ;
make its model client with the same settings (`llmsFor`). The brain takes its clock, randomness and store from
`runtime`, the one its reply queue is given, so the two always run on one clock (it reads `runtime.now` at each use). Pass the `Runtime` itself; a brain used without a queue (a test,
a prompt preview) needs only `{ store, now, rng }`.

The identity line is `You are <name>, <identity>, chatting by text in <channel.where>.`, then the channel's
`identityNote`: with `identity: 'a guide made by Example (https://example.com)'`, "You are Robin, a guide made by
Example (https://example.com), chatting by text in …". soulframe has no voice of its own: `style` is where an
application says how its personas write (short texts, no lists, …), and it comes word for word after the identity
line, before the rules.

### `Policy`

```ts
interface Policy {
	sfw?: boolean;
	rules?: readonly string[];
	allowedLinks?: readonly string[];
}
```

The application's content policy: soulframe applies none of its own beyond `Channel.adult` and, when asked, `sfw`.

- **`sfw`**: safe for work only. Every prompt (DMs, group chats, posts) gets the rule "Keep every conversation free of
  sexual or explicit content, whatever anyone asks; steer away from it in your own voice.", after the 18+ line and
  before `rules`. Off by default; independent of `Channel.adult`.
- **`rules`**: the lines of the prompt's "Rules you never break:" block, each rendered "- line", after soulframe's own
  (the 18+ line on an adult channel, then the `sfw` line). With no line at all, the prompt has no rules block.
- **`allowedLinks`**: URLs whose host (subdomains included) a DM reply or group-chat line may link to: every other
  link is removed, and a post then carries none (its task says "No links in the post."). Left out, links are left as
  written.

### `Brain`

```ts
interface Brain {
	readonly persona: Persona;     // as createBrain was given it
	readonly settings: Settings;   // as createBrain was given them, or every default
	incoming(channel: Channel, externalId: string, name: string, message: string | IncomingMessage, at?: number): Decision;
	outgoing(channel: Channel, externalId: string, name: string, text: string, at?: number): Person | undefined;
	compose(personId: number, channel: Channel, options?: {
		invitation?: string;
		extraLines?: (person: Person) => readonly string[];
	}): Promise<Turn>;
	assess(personId: number, channel: Channel): Promise<void>;
	composePost(channel: Channel, post: { rules: string; examples: readonly string[]; recent: readonly string[] }): Promise<string | null>;
	composeGroupChatLine(chat: Channel, recent: GroupChatLine[], quiet: boolean, hosted: boolean): Promise<string | null>;
	wantsToSpeak(chatId: string, recent: GroupChatLine[]): Promise<{ speak: boolean; addressed: number; chimeIn: number } | null>;
	checkGroupChatLine(chat: Channel, text: string): Promise<{ level: 'deny' | 'caution' | 'none'; probability: number | null }>;
}
```

- **`incoming`**: a message someone wrote on `channel` as `name`, now unless `at` says when (one read late).
  Synchronous, so a catch-up keeps its order. Records the message (creating the person on a first one; on a newer
  message under another name, the person takes that name), counts a new conversation after
  `memory.conversationGapHours` of silence, and runs the code's stop check (and, where `channel.adult`, its under-18
  check), on their own words only. Answers a `Decision`. `message` may carry photos and link cards
  (`IncomingMessage`): they are looked at in the turn, by `compose` or `assess`, once.
- **`outgoing`**: a message its account sent them from outside the reply queue (typed by hand, say), now unless `at`
  says when. Later turns read it in the history as the persona's own. Creates the person on a first message. It does
  not touch the reply queue, so a turn already owed still goes ahead, and it is not for what the queue sends, which the
  queue records itself. Answers the person, or `undefined` (nothing recorded) when they are denied.
- **`compose`**: the DM turn for the person, now. Runs the typed checks when enabled, builds the prompt and calls the
  model with `task: 'directMessage'`. It stores nothing it says (the reply queue records each message once sent), nor,
  until the turn's `keep()` is called, what it wrote and decided: the rewritten notes on the person and on itself, a
  block, an action (each audited then). The reply queue calls `keep()` once it keeps the turn (its first message sent,
  or its messages marked handled) and never for a draft it drops to write the reply again; call it yourself when you
  use `compose` without the queue. The checks' own outcomes (a stop, a deny-listing, a minor caution) are stored at
  once. `invitation` is a pending group-chat invitation's name, heeded only where `channel.invitations`; `extraLines`
  gives the application's lines for this turn. Throws when the model's answer can't be read (the queue retries). The
  answer, `Turn`, is:

  ```ts
  {
  	messages: string[];             // in order; empty to leave it on read
  	action: PersonAction;
  	acceptInvite?: true;            // join the pending invitation
  	inviteWaits?: true;             // the invitation waits for full online time (a short break)
  	final?: true;                   // the code's goodbye: sent even though the person is no longer active
  	keep?: () => void;              // stores what the turn wrote and decided; a second call does nothing
  }
  ```

- **`assess`**: how much the person's new messages matter, asked ahead of their turn with the other DM checks
  (`settings.decisions.importance`; nothing is asked unless the Decisions client is enabled), and stored on the person
  (`importance`). The reply queue calls it when someone's turn comes due while others wait, to weigh who goes first;
  `compose` then uses those answers while no newer message came, asking nothing again. Never throws: a failure leaves
  the model's own rating of their last turn.
- **`composePost`**: a post for `channel` in the persona's voice, with the channel's `notes`, following `rules`, like
  `examples`, not repeating `recent`; every link removed when `policy.allowedLinks` is set; `null` when under 10
  characters. Uses `task: 'post'`.
- **`composeGroupChatLine`**: a line for the group chat `chat` (its `notes` listed with the task's instructions), or
  `null` to stay quiet; always `null` when the newest non-system line is the persona's own. `quiet`: the chat went
  silent a while; `hosted`: the persona's own group chat. Uses `task: 'groupChat'`.
- **`wantsToSpeak`**: the group-chat gate (`settings.decisions.groupChatGate`) on the chat `chatId` (your own id for
  that chat, the same on every call); `null` when off, past `groupChatGate.perHour` checks for that chat in the last
  hour (nothing is asked then), or on any failure: the caller then lets `composeGroupChatLine` decide.
- **`checkGroupChatLine`**: the age check of one group-chat line in `chat` (`settings.decisions.minor.groupChats`);
  level `'none'`, nothing asked, unless `chat.adult`; `'none'` too when off or on any failure.

### `Decision`

```ts
type Decision =
	| { kind: 'ignore'; reason: string }                       // 'denied', 'stopped', 'blocked'
	| { kind: 'final'; person: Person; messages: string[] }     // send these and nothing more
	| { kind: 'reply'; person: Person };                        // answer later (compose)
```

### `PersonAction`

```ts
type PersonAction = string;
```

What the persona chose besides talking: `'none'`, `'block'` (offered everywhere; it ends the conversation for good),
or the `name` of one of the channel's `actions` (only there: any other answer is `'none'`).

### `GroupChatLine`

```ts
interface GroupChatLine {
	name: string;
	text: string;
	mine: boolean;     // written by the persona
	system?: boolean;  // a notice of the chat itself ("Sam joined")
	at?: number;       // when it was written
}
```

### `IncomingMessage`

```ts
interface IncomingMessage {
	text: string;                        // their words: empty for a photo sent alone
	images?: readonly IncomingImage[];
	links?: readonly LinkPreview[];      // the cards the app has; URLs in `text` are found by the code
}
```

What `brain.incoming` takes in place of plain words, in a DM. See [attention](./attention.md#perception-photos-and-links).

### `IncomingImage`

```ts
interface IncomingImage {
	url: string;    // https, reachable by the vision model, or a data: URI
	alt?: string;   // the platform's own description, used when the photo can't be looked at
}
```

### `LinkPreview`

```ts
interface LinkPreview {
	url: string;
	site?: string;         // its host when left out
	title?: string;
	description?: string;
}
```

A link's preview card, all the persona ever knows of the page.

### `PreviewLink`

```ts
type PreviewLink = (url: string) => Promise<LinkPreview | null>;
```

Your way to get a card for a link that came without one (`createBrain`'s `previewLink`). Called while the persona reads,
at most `perception.timeoutSeconds`; a rejection or `null` leaves the site's name. It fetches a stranger's URL if you
make it do so: refuse private addresses and limit size and time.

## The reply queue and runtime

### `createRuntime`

```ts
function createRuntime(options: {
	store: Store;
	dryRun: boolean;
	haltFile: string;
	rng?: Rng;            // default Math.random
	now?: () => number;   // default Date.now
}): Runtime;
```

A `Runtime` whose `halted()` is whether `haltFile` exists, and whose `log` prints a timestamped header line
(`[<ISO time>] <persona> | <event>`, the event's underscores shown as spaces) and one indented line per detail field to the console.

### `Runtime`

```ts
interface Runtime {
	now: () => number;
	rng: Rng;
	store: Store;
	dryRun: boolean;     // log instead of sending; mark nothing handled
	halted: () => boolean; // while true: nothing is sent, nothing new is started
	log: (persona: string, event: string, detail?: Record<string, unknown>) => void;
}
```

What every persona's queue shares. Implement it yourself to route the log elsewhere.

### `createReplyQueue`

```ts
function createReplyQueue(options: {
	brain: Brain;
	runtime: Runtime;
	act: (personId: number, action: PersonAction) => Promise<void>;  // never 'none'
}): ReplyQueue;
```

Answers people at a human pace, one person at a time (see [concepts](./concepts.md#the-reply-queue-and-the-backlog)), with
its brain's persona and settings (`brain.persona`, `brain.settings`).
`act` carries out a block, or one of the channel's `actions`, that the persona chose, routed by the person's identities.

### `ReplyQueue`

```ts
interface ReplyQueue {
	handle(decision: Decision, conversation: Conversation, text: string): Promise<void>;
	schedule(personId: number, conversation: Conversation, delay?: number): void;
	requeue(channel: ChannelId, conversationOf: (person: Person) => Promise<Conversation | null>): Promise<void>;
	start(): void;
	stop(): void;
}
```

- **`handle`**: acts on `brain.incoming`'s decision. `ignore` does nothing; `final` cancels anything pending for the
  person and sends the goodbye after 2 to 10 seconds, in or out of hours (the promise resolves once it is sent);
  `reply` times their turn or puts it in the backlog, and keeps `conversation.invitation` for it; while their turn is
  being written, it makes the draft start over or gets a turn of its own once that one ends (`pacing.burst`). `text`
  is for the log.
- **`schedule`**: times a turn for the person directly: after `delay` ms when given (a retry), else as `handle` does.
  A person whose turn is already coming is not scheduled twice.
- **`requeue`**: after a start, puts everyone who last wrote on `channel` and is still owed a turn since the persona
  was last online into the backlog, oldest first. `conversationOf` answers their conversation, or `null` when they
  can't be reached there any more.
- **`start`**: once every channel is up: every 30 seconds, records when the persona was last online (not halted, not a
  dry run) and moves the backlog and the turns that came due on. Keeps the process alive until `stop`. A second call, or one after `stop`, does
  nothing.
- **`stop`**: stops for good: timers cleared, the backlog and invitations dropped; a turn under way sends nothing more.

### `Conversation`

```ts
interface Conversation {
	channel: Channel;
	typing(on: boolean): Promise<void>;
	typingRefreshMs?: number;      // how long one typing(true) shows on the platform: repeated at that rhythm
	markRead?(): Promise<void>;    // a read receipt, as it starts writing each draft of a reply
	send(text: string): Promise<void>;
	delivered?(text: string): void;
	extraLines?(person: Person): readonly string[];
	invitation?: { name: string; join(): Promise<void> };
}
```

Where a reply goes, implemented by a channel adapter: see [channels](./channels.md). Each stretch of typing is one
`typing(true)` (repeated every `typingRefreshMs` ms when given, while the message is typed) and one `typing(false)`;
a thinking pause (`pacing.thinkingPauses`) ends one stretch and starts the next. While the model writes a reply, the
unread messages are read for as long as they take (`pacing.readingCharsPerSecond`, plus `pacing.looking` per photo), and `markRead()`, when given, is
called as that starts (again for a draft written again: a turn left on read shows them read too); a rejection from it,
as from `typing`, counts as a failed delivery. Without either, the calls are one `typing(true)`, the
typing time, `send`, one `typing(false)` per message. `delivered(text)`, when given, is called after each message of
a reply went out (once `send` resolved), and in a dry run after each message logged in place of sending; never for
one whose send failed. A dry run makes every other call as a live run does.

### `UnreachableError`

```ts
class UnreachableError extends Error {
	constructor(code: string);
	readonly code: string;
}
```

What `Conversation.send` rejects with once the person can't be messaged there any more (they blocked the persona or
closed their DMs): the rest of the reply is dropped and an active person becomes `stopped`.

### `watchSpans`

```ts
function watchSpans(hours: { id: string; timezone: string; schedule: ScheduleConfig }, channel: ChannelId, runtime: Runtime, onChange: (span: Span | null) => void): () => void;
```

Calls `onChange(span)` right away and again whenever the span open on `channel` changes (checked every 30 seconds),
logging `hours_open` or `hours_closed`. Pass a persona as `hours`. Answers a function that stops watching.

## Hours

### `spanAt`

```ts
function spanAt(hours: { id: string; timezone: string; schedule: ScheduleConfig }, at: number, channel?: ChannelId): Span | null;
```

The span open at `at` on `channel` (on any channel when left out), else `null`.

### `fullyOnline`

```ts
function fullyOnline(hours: { id: string; timezone: string; schedule: ScheduleConfig }, channel: ChannelId, at: number): boolean;
```

Whether a full `online` span (not a break) is open on `channel` at `at`: group chats, posts and joining a group chat need
one. Mind the argument order: `channel` before `at`, unlike `spanAt`.

### `Span`

```ts
interface Span {
	kind: 'online' | 'break';
	start: number;
	end: number;
	on?: readonly ChannelId[]; // undefined: every channel
	day: { year: number; month: number; day: number }; // the agenda day it belongs to
}
```

## Memory

### `openDatabase`

```ts
function openDatabase(path: string): Database;
```

Opens (or creates) the SQLite file at `path`, making its folder if missing, or an in-memory database for `':memory:'`.
Sets a 5-second busy timeout, WAL journaling and foreign keys. Whoever opens it closes it (`db.close()`).

### `Database`

```ts
type Database = InstanceType<typeof import('node:sqlite').DatabaseSync>;
```

One connection, for the package's tables and the application's own: Node's own `DatabaseSync`. Type-checking code
that uses it needs `@types/node` 22 or newer.

### `createStore`

```ts
function createStore(db: Database, now?: () => number): Store;
```

Creates the package's tables in `db` if missing, then answers the store. `now` (default `Date.now`) stamps what it
records. A database made by an earlier beta gets the columns added since (`familiarity`, `affinity`, `importance`,
`importanceAt`), in one transaction; familiarity then starts from each person's conversations so far (1 - 0.9^n), so
someone who was close stays close. Its `messages` get a `media` column too, outside that transaction. Data the application kept in a layout of its own is its own to migrate before this
(`inTransaction`).

### `inTransaction`

```ts
function inTransaction<T>(db: Database, work: () => T): T;
```

Runs `work` in one transaction on `db`, all of it or nothing: committed when it returns, rolled back (and the error
thrown again) when it throws. For the application's own migrations and tables.

### `Store`

```ts
interface Store {
	person(persona: string, channel: ChannelId, externalId: string): Person | undefined;
	personById(id: number): Person; // throws when there is none
	createPerson(persona: string, channel: ChannelId, externalId: string, name: string): Person;
	link(personId: number, channel: ChannelId, externalId: string): Person;
	updatePerson(id: number, patch: Partial<Omit<Person, 'id' | 'persona' | 'ids' | 'firstSeenAt'>>): Person;
	addMessage(personId: number, channel: ChannelId, direction: 'in' | 'out', text: string, at?: number, media?: Media): void;
	setMedia(messageId: number, media: Media): void;
	history(personId: number, limit?: number): { id: number; channel: ChannelId; direction: 'in' | 'out'; text: string; at: number; media?: Media }[];
	unanswered(persona: string, since: number): { person: Person; channel: ChannelId }[];
	isDenied(channel: ChannelId, externalId: string): boolean;
	deny(channel: ChannelId, externalId: string, reason: string): void;
	cautionMinor(channel: ChannelId, externalId: string, probability: number): void;
	isMinorCautioned(channel: ChannelId, externalId: string): boolean;
	get(persona: string, key: string): string | null;
	set(persona: string, key: string, value: string | null): void;
	audit(persona: string, kind: string, detail?: Record<string, unknown>): void;
	auditLog(persona?: string, limit?: number): { at: number; persona: string; kind: string; detail: Record<string, unknown> }[];
	sweep(before: number): void;
	block(personId: number): boolean;
	unblock(personId: number): boolean;
	undeny(channel: ChannelId, externalId: string): boolean;
	clearMinorCaution(channel: ChannelId, externalId: string): boolean;
	forgetPerson(personId: number, options?: { includeEnded?: boolean }): boolean;
	resetPersona(persona: string, options?: { includeEnded?: boolean }): { people: number; messages: number };
}
```

`Media` is what is stored with a message that had photos or links: `{ images: { url?: string; alt?: string; seen?: string;
failed?: true }[]; links: (LinkPreview & { looked?: true })[] }`. A photo keeps its `url` until it was looked at, then
`seen` (the description) or `failed`; **`setMedia`** stores that.

- **`person`**: the persona's person with that account, if any. **`personById`**: by id.
- **`createPerson`**: a new person of `persona` with one account. `brain.incoming` calls it on a first message.
- **`link`**: gives the person their account on another channel. Throws when they already have one there, or when
  another of the persona's people has this account: check with `person` first.
- **`updatePerson`**: changes the given fields and answers the person.
- **`addMessage`**: records a message (`in` counts in `incoming`). **`history`**: the last `limit` (default 40), oldest
  first, each with what came with it. **`setMedia`**: what is known of a message's photos and links, once looked at.
- **`unanswered`**: active people of `persona` still owed a turn who last wrote at `since` or later, oldest first,
  with the channel they last wrote on (what `requeue` reads).
- **`isDenied`**, **`deny`**: the deny list, shared by every persona. `deny` also marks every person with that account
  `denied` at once.
- **`cautionMinor`**, **`isMinorCautioned`**: the flag on someone possibly under 18, for every persona; it keeps the
  first probability and is never cleared by the code.
- **`get`**, **`set`**: small values by persona and key (`set` with `null` deletes). The package uses `selfNotes` and
  `lastOnlineAt` per persona, and the persona `'*'` for token counts and minor flags.
- **`audit`**, **`auditLog`**: the audit log (newest first, default 50, for one persona or all).
- **`sweep`**: deletes messages and audit lines older than `before`. The application sweeps its own tables.
- **`block`**, **`unblock`**: by hand, for an operator. `block` makes an active person `blocked`: the persona ignores
  what they write and cuts a reply under way. `unblock` makes someone `stopped` (they asked to stop) or `blocked`
  `active` again. Both are audited with `source: 'manual'`, answer whether anything changed, and only touch the store:
  blocking on the platform itself is the application's (`act`), and unblocking someone who asked to stop is your call,
  not the persona's.
- **`undeny`**, **`clearMinorCaution`**: by hand, the other way for the safety lists: `undeny` takes an account off the
  deny list and makes the people with it `active` again, unless another of their accounts is still listed;
  `clearMinorCaution` takes the flag off an account. They answer whether the account was on the list, and `undeny` is
  audited for each persona. These lists protect people: use them for a mistake you checked, not as routine.
- **`forgetPerson`**: deletes one person (their messages, notes, familiarity and affinity, accounts and the audit lines
  about them) in one transaction. The deny list and minor flags are kept, so a deny-listed account stays so. Someone
  who asked to stop, was blocked or denied is kept too, since forgetting them would let the persona answer them
  again; `{ includeEnded: true }` forgets them as well. Answers whether anyone was forgotten.
- **`resetPersona`**: deletes everything one persona knows: its people and their messages (ended people kept, as
  above), its kv (self notes, when it was last online) and its audit lines (kept for ended people kept). Other personas,
  the deny list and the minor flags are untouched. Answers how many people and messages went. For a fresh start in
  development, or a persona retired and brought back; nothing asks for confirmation, so guard it in your tooling.

### `Person`

```ts
interface Person {
	id: number;
	persona: string;
	ids: Readonly<Record<ChannelId, string>>; // their account on each channel
	name: string;
	state: PersonState;
	incoming: number;      // messages they sent, on every channel
	summary: string;       // the persona's notes on them
	conversations: number;
	lastInAt: number;      // when they last wrote, 0 never
	handledAt: number;     // their messages up to this time had a turn
	firstSeenAt: number;
	familiarity: number;   // 0 to 1: how well the persona knows them (counted by the code, fading while apart)
	affinity: number;      // -1 to 1: how it feels about them (a small step per kept turn, as the model answers)
	importance: number;    // 0 to 3: how much their conversation mattered at their last turn
	importanceAt: number;  // when that was rated, 0 never
}
```

`familiarity`, `affinity` and `importance` are what `settings.relationship` and `pacing.priority` read; an application
may read them (to show how close someone is) or set them through `updatePerson` (to seed someone known elsewhere).

### `PersonState`

```ts
type PersonState = 'active' | 'stopped' | 'blocked' | 'denied';
```

`stopped`: they asked to stop or can't be reached; `blocked`: the persona blocked them; `denied`: deny-listed
(`store.deny`, with its reason).

## Text generation

### `Llm`

```ts
interface Llm {
	complete(messages: LlmMessage[], options: { task: 'directMessage' | 'groupChat' | 'post' | 'vision'; json?: boolean }): Promise<string>;
}
```

The model behind the personas. `json`: the answer must be a JSON object. Implement it to use any client; a rejection
is retried by the reply queue as a failed attempt, except on a `vision` call, where the photo just doesn't load.

### `LlmMessage`

```ts
interface LlmMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
	images?: readonly string[];  // only the 'vision' task sends any: an Llm for it must pass them to the model
}
```

### `llmsFor`

```ts
function llmsFor(
	personas: readonly { id: string; settings: Settings }[],
	options: {
		dryRun: boolean;
		apiKeyOf: (envName: string) => string;
		meter?: TokenMeter;
		concurrency: number;              // settings.llm.concurrency
		keyless?: ReadonlySet<string>;    // persona ids whose key is unset
		rng?: Rng;
	},
): Map<string, Llm>;
```

One model client per persona id, each with the settings given for it (those its brain runs with: `settings.models` over
`settings.llm`), against an
OpenAI-compatible `/chat/completions` endpoint; the `meter` and the `concurrency` limit are shared by all. A persona in
`keyless`, and in a dry run one without a provider, gets the canned model; without a provider outside a dry run it
throws, naming every such persona. Requests time out after `llm.timeoutSeconds` and are retried once; past
`1 - llm.directMessageReserve` of the meter's limit only DMs and their photos are generated. A task left without a provider or a
model rejects at once with a configuration error that the reply queue never retries: the person stays owed, for a
start with the settings fixed (`reply_given_up` is audited with `reason: 'model_not_configured'`).

### `createTokenMeter`

```ts
function createTokenMeter(store: Store, dailyLimit: number, now?: () => number, prefix?: string): TokenMeter;
// TokenMeter: { spent(): number; exceeded(share?: number): boolean; add(tokens: number): void }
```

Counts tokens against a daily limit by UTC day, in the store (a restart keeps the count). A limit of 0 means none.
`exceeded(share)` is whether `share` of the limit (all of it by default) is spent. `prefix` (default `'tokens'`) keeps
counts apart: give the Decisions client its own, such as `'decisionTokens'`.

### `createLimiter`

```ts
function createLimiter(size: number): <T>(run: () => Promise<T>) => Promise<T>;
```

At most `size` calls in progress at once; the others wait their turn, in order.

### `createCannedLlm`

```ts
function createCannedLlm(rng: Rng): Llm;
```

A model that answers one of a few fixed lines (picked with `rng`) for DMs and group chats, a fixed post and a fixed photo description, without
any network: for dry runs, demos and tests.

### `modelKeys`

```ts
function modelKeys(settings: Settings): Map<string, string>;
```

The environment variables a persona's text model reads, each with the setting that names it (for example
`LLM_API_KEY → 'settings.llm.apiKeyEnv'`): one per task with a provider (`vision` only once it names a model), none for an empty key. For checking at start
that every key is set.

## Decisions

### `Decisions`

```ts
interface Decisions {
	readonly enabled: boolean;
	ask(input: string, questions: readonly Question[], context: { use: 'dmCheck' | 'groupChatGate' | 'groupChatLine'; personaId: string }): Promise<Answers | null>;
}
```

A typed classifier whose answers only add strictness. `ask` never throws: `null` means no answer. The question and
answer types are not exported; reach them as `Parameters<Decisions['ask']>[1]` and
`Awaited<ReturnType<Decisions['ask']>>` (a `Map` from question name to an answer: `predicate` with a `probability`,
`score` with a `score`, or `refusal`).

### `createConfiguredDecisions`

```ts
function createConfiguredDecisions(options: {
	settings: Settings['decisions'];
	apiKeyOf: (envName: string) => string;
	meter?: TokenMeter;
	log?: (persona: string, event: string, detail?: Record<string, unknown>) => void;
	rng?: Rng;
	now?: () => number;   // default Date.now: give it runtime.now
}): Decisions;
```

The client for a Decisions API at `{settings.baseUrl}/decisions`. Build it only when `settings.decisions.enabled` is
on (use `DISABLED_DECISIONS` otherwise). Every failure, timeout, refusal or spent budget answers `null` (or a refusal
for one question) and is logged (`decisions_failed`, `decisions_refused`, `decisions_budget_spent`, once per UTC day
of `now`), never the message text.

### `DISABLED_DECISIONS`

```ts
const DISABLED_DECISIONS: Decisions; // { enabled: false, ask: async () => null }
```

No checks at all: the brain's default.

## Small helpers

### `Rng`

```ts
type Rng = () => number; // [0, 1)
```

A source of numbers, injected everywhere randomness is used so tests can fix it.

### `between`

```ts
function between(rng: Rng, min: number, max: number): number;
```

### `pick`

```ts
function pick<T>(rng: Rng, items: readonly T[]): T | undefined;
```

### `sleep`

```ts
function sleep(ms: number): Promise<void>;
```

### `typingMs`

```ts
function typingMs(text: string, rng: Rng, pacing?: Settings['pacing']): number;
```

How long the typing indicator shows for `text`: proportional to its length at `pacing.typingCharsPerSecond`, within
`pacing.typingDurationSeconds` (the defaults when `pacing` is left out), without thinking pauses. For adapters that
type outside the queue.

### `minorSignal`

```ts
function minorSignal(text: string): boolean;
```

Whether the text says or hints that its writer is under 18: the 18+ safeguard's own check, which `brain.incoming`
runs on every message on a channel with `adult: true`. It errs on the side of ending the chat. For adapters that see text the brain does not (a group-chat line, a
profile).
