<div align="center">

<img src="./assets/soulframe-logo.svg" alt="soulframe" width="300">

**AI personas that keep hours, remember people and chat at a human pace, on any channel you plug in.**

[![npm](https://img.shields.io/npm/v/soulframe/beta?color=cb3837&logo=npm)](https://www.npmjs.com/package/soulframe)
[![CI](https://github.com/RubyDevil/soulframe/actions/workflows/ci.yml/badge.svg)](https://github.com/RubyDevil/soulframe/actions/workflows/ci.yml)
[![status: beta](https://img.shields.io/badge/status-beta-7c5cff)](#status-beta)
[![node: >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-5fa04e?logo=node.js&logoColor=white)](https://nodejs.org/)
[![types: included](https://img.shields.io/badge/types-included-3178c6?logo=typescript&logoColor=white)](./docs/api.md)
[![module: ESM + CJS](https://img.shields.io/badge/module-ESM%20%2B%20CJS-f7df1e)](#install)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

soulframe is the part of a persona service that has nothing to do with where the conversation happens. It owns the
persona (its prompt, fixed character, mood and hours), the agenda that says when it is online, the brain that writes
its direct-message turns, group-chat lines and posts, the reply queue that answers at a human pace, and the SQLite
memory of everyone it talks with. You bring the channels: an adapter turns a platform's messages into calls to the
brain and its `send` into the platform's API. soulframe never names a platform; it knows a channel only by the id you
give it.

It is a general-purpose persona framework, for any kind of persona on any platform, with no content policy or voice
of its own: what a persona is and may say is decided by your model and its provider, the persona's prompt, and what
you pass in (`createBrain({ identity, style, policy })`). It ships one
opt-in safeguard, for conversations you mark as 18+ (`Channel.adult`): keeping minors out. A persona can also be made
safe for work (`sfw: true`).

## Features

- **Personas as config.** One YAML file and one Markdown prompt per persona, with shared defaults in `_shared.yaml`;
  every problem is reported with its file and path, unknown keys come with a "did you mean".
- **A day that looks real.** Online hours by weekday, short breaks, busy blocks with a reason ("at work", "at the gym"),
  skipped days, all drawn per day from a seed so a restart draws the same agenda, across daylight saving changes too.
- **Human pacing.** One person at a time, the next picked by closeness, how much their conversation matters and how
  long they waited; answers within seconds while it still has someone's chat open, and when it next glances at its
  messages otherwise; short interruptions now and then; one reply to someone who writes in bursts (a draft written
  again when they add to it mid-reply), messages read while the reply is written, typing time proportional to each
  message at each persona's own speed, long replies split in two, a backlog answered one person at a time when the
  persona comes back online; opt-in read receipts, typing kept alive on platforms that expire it, and thinking pauses
  in long messages.
- **Memory that stays small.** People, their accounts on each channel, the conversation history, the model's own notes
  on each person and on itself, how well it knows and likes each of them (familiarity grown by what their
  conversations meant, affinity moved a step at a time, both described in levels you can rewrite), a cross-persona
  deny list and an audit log, all in one SQLite file (Node's built-in `node:sqlite`), its tables made on open.
- **Three capabilities.** Direct-message turns (reply, notes, block or an action the channel declares, accept a
  group-chat invitation), lines in a group chat (or staying quiet), and short posts for a channel's rules.
- **Your words, your rules.** The persona's identity phrase and writing style are yours to give (`identity`, `style`),
  and what the model should know about each place is the channel's (`notes`). Unrestricted by default: no rule lines
  and no link filtering until you pass a `policy`
  (`rules` for the prompt's "Rules you never break", `allowedLinks` for the only hosts a reply may link to). Stop
  requests are always handled by code before the model is called.
- **An opt-in 18+ safeguard.** On a channel marked `adult: true`, a sign of someone under 18 ends the conversation and
  deny-lists them, and the prompt says the persona only talks with adults. Off everywhere else.
- **Safe-for-work personas.** `sfw: true` adds one rule to every prompt of that persona: keep every conversation free
  of sexual or explicit content.
- **Optional typed checks.** A Decisions API client (OpenAI's by default) adds probability-based stop checks (and
  age checks on 18+ channels) and a group-chat gate. Off by default, additive only: any failure behaves as if it were off.
- **Any OpenAI-compatible provider.** One model per task, a shared daily token budget with a reserve for DMs, a global
  concurrency limit, retries that wait out outages.
- **Testable.** Clock, randomness, file reading and the model are all injected; a canned model and `:memory:` stores
  run everything offline.

## Status: beta

> [!IMPORTANT]
> soulframe is **beta** software: the API may still change before 1.0. Releases are SemVer prereleases
> (`0.1.0-beta.N`) on the `beta` dist-tag, so install with `soulframe@beta` and pin the exact version you test with.

What the beta does not do yet:

- **No stability promise.** The exports, the persona config and the database layout may change between betas, and
  there is no migration policy yet (see the [roadmap](#roadmap-to-10)).
- **One kind of text provider.** Text generation speaks the OpenAI-compatible `/chat/completions` API only.
- **A small default budget.** `llm.dailyTokens` defaults to 200,000 tokens a day for every persona together, about
  55 DM turns at the shipped prompt sizes: size it to your fleet ([configuration](./docs/configuration.md#llm)).
- **No adapters.** You write the channel adapters ([guide](./docs/channels.md)).
- **Test helpers and model error classes are not exported** (a scripted Decisions client, a seeded random source,
  the errors a custom model client needs to signal a spent budget or an outage).

Errors: config problems are returned as `issues`, never thrown; the rest is listed in
[concepts](./docs/concepts.md#errors).

## Install

```sh
npm install soulframe@beta
```

It ships compiled JavaScript with type declarations, as both ESM and CommonJS, so it works from TypeScript, `import`
and `require` alike:

```ts
import { createBrain } from 'soulframe'; // ESM or TypeScript
```

```js
const { createBrain } = require('soulframe'); // CommonJS
```

soulframe needs **Node.js 22.13 or newer** (for `node:sqlite` without a flag) and depends on
[`zod`](https://zod.dev/) and [`yaml`](https://eemeli.org/yaml/) only.

`node:sqlite` is still marked experimental in Node 22, so Node may print an `ExperimentalWarning` once, when soulframe
loads. It is harmless; run `node --disable-warning=ExperimentalWarning` to hide it.

## Quick start

A persona, an in-memory store, the canned model (no provider, no key) and a channel that prints to the console. It
uses top-level `await`, so it runs as an ES module: save it as `quick-start.mts` (or as `quick-start.ts` in a project
whose `package.json` has `"type": "module"`) and run it with [tsx](https://tsx.is/):

```sh
npx tsx quick-start.mts
```

```ts
import {
	createBrain,
	createCannedLlm,
	createReplyQueue,
	createRuntime,
	createStore,
	openDatabase,
	parsePersonas,
	type Conversation,
} from 'soulframe';

// A fixed clock inside the persona's hours and fixed randomness (a real service keeps the defaults, Date.now and Math.random)
const now = () => Date.UTC(2026, 0, 15, 20, 0);
const rng = () => 0.5;

// 1. A persona: loadPersonas reads the same from <dir>/robin.yaml and robin.md
const { personas, issues } = parsePersonas({
	personas: [{
		id: 'robin',
		file: 'robin.yaml',
		raw: {
			name: 'Robin',
			timezone: 'UTC',
			window: { start: ['19:00', '19:00'], end: ['23:00', '23:00'] },
			// Instant replies for the demo (the defaults wait seconds to minutes, as a person would)
			settings: {
				pacing: {
					glance: { delaySeconds: [0, 0] },
					interruptions: { meanMinutes: 0 },
					readingDurationSeconds: [0, 0],
					typingDurationSeconds: [0, 0],
					burst: { settleSeconds: [0, 0] },
				},
			},
		},
	}],
	channels: { robin: ['console'] },
	readPrompt: () => 'You are Robin, warm and curious, writing in lowercase.',
});
if (issues.length) throw new Error(issues.join('\n'));
const persona = personas[0]!;

// 2. Memory, the runtime (the clock, randomness and store the brain and its queue share), the brain (`identity`:
//    what the persona is, after its name) and its reply queue
const store = createStore(openDatabase(':memory:'), now);
const runtime = createRuntime({ store, dryRun: false, haltFile: './HALT', rng, now });
const brain = createBrain({ persona, identity: 'a character in a demo', runtime, llm: createCannedLlm(rng) });
const queue = createReplyQueue({ persona, brain, runtime, act: async () => {} });

// 3. A channel: where the conversation happens, and how a message goes out
const conversation: Conversation = {
	channel: { id: 'console', where: 'a terminal chat', maxLength: 500 },
	async typing() {},
	async send(text) {
		console.log(`Robin: ${text}`);
	},
};

// 4. One message in: the brain decides at once, the queue answers at the persona's pace
const text = 'hey robin, how is your evening going?';
await queue.handle(brain.incoming(conversation.channel, 'sam', 'Sam', text), conversation, text);
```

The runtime logs each step to the console (`dm received`, `reply scheduled`, `reply processing`, `dm sent`, `reply sent`)
and the reply is printed between them:

```text
Robin: what are you up to today?
```

(one of the canned model's fixed lines). Swap `createCannedLlm` for a real client (`llmsFor`, see
[configuration](./docs/configuration.md#llm)) and the same code talks through your provider. A longer, commented
version that also shows memory and the 18+ safeguard is in [`examples/console-chat.ts`](./examples/console-chat.ts).
From a clone of this repository, after `npm install`:

```sh
npx tsx examples/console-chat.ts
```

## Core concepts

| Concept | In one line |
| --- | --- |
| **Persona** | `PersonaConfig`: the prompt, `character` (facts, interests, boundaries, moods), time zone, hours, chattiness, `sfw` and settings, from `_shared.yaml` + `<id>.yaml` + `<id>.md`. |
| **Agenda** | The hours drawn into exact **spans** (`online`, or a short `break` for DMs only) and **busy** blocks for each local date; the prompt hears what it is doing now and next (its **situation**). |
| **Channel** | Your platform, as a `ChannelId` string and a `Channel` description (where, length limit and a soft one for group-chat lines, an optional `identityNote` and `notes`, whether DMs there answer invitations, its own `actions`, whether it is 18+). |
| **Conversation** | What an adapter implements per person: `typing`, `send`, optional `typingRefreshMs`, `markRead`, `delivered`, `extraLines` and `invitation`. |
| **Brain** | `incoming` (synchronous, the code's own checks first), `compose` (a DM turn), `composeGroupChatLine`, `composePost`, plus the group-chat checks; your `identity`, `style` and `policy`, if any. |
| **Reply queue** | Answers each person once at a time, at a human pace, inside open spans; everyone else waits in the **backlog**. |
| **Store** | One SQLite database: people, identities per channel, messages, notes, deny list, kv and audit. |

Read [concepts](./docs/concepts.md) for the whole picture.

## Documentation

- [Concepts](./docs/concepts.md): persona, agenda, channels, the reply queue, memory, the brain, safeguards and policy, Decisions.
- [Configuration](./docs/configuration.md): every key of `_shared.yaml` and `<id>.yaml`, with type, default and range.
- [API reference](./docs/api.md): every export of `soulframe`.
- [Writing a channel adapter](./docs/channels.md): `Conversation`, delivery errors, invitations, restarts, presence.
- [Testing](./docs/testing.md): the canned model, in-memory stores, a fixed clock and randomness.
- [System prompts](./docs/prompts.md): every part of every prompt and typed check, its order, what switches it and who writes it.
- [Changelog](./CHANGELOG.md) and [contributing](./CONTRIBUTING.md).

## FAQ

**Which model providers work?**
Any provider with an OpenAI-compatible `/chat/completions` endpoint, local ones included (leave `apiKeyEnv` empty for
no authentication). Pick one whose terms allow the conversations your personas will have. Each task (DMs, group chat,
posts) can use its own model, even its own provider.

**Does it run without a model?**
Yes: `createCannedLlm` answers fixed lines, and `llmsFor` falls back to it in a dry run for personas without a provider.

**Who decides what a persona may say?**
You do. soulframe adds no rules of its own: your model and its provider, your `policy`, and each persona's prompt,
`character.boundaries` and `sfw` decide. What it does ship is code, not settings: stop handling everywhere, and the
minors safeguard on channels you mark `adult: true`; no persona config turns them off.

**Can one person talk with a persona on several channels?**
Yes. A person has one account per channel (`Person.ids`); `store.link` attaches another, and the history, notes and
relationship are shared across them.

**Where are the secrets?**
Never in the config: settings only name the environment variables that hold keys (`apiKeyEnv`), and your code reads
them (`apiKeyOf`).

## Roadmap to 1.0

- Export the test helpers (a scripted Decisions client, a seeded random source) and the error classes a custom model
  client needs to signal a spent budget or an outage.
- Freeze the public API and the database layout; document the migration policy.
- More channel adapter examples.

## Contributing

Issues and pull requests are welcome at
[RubyDevil/soulframe](https://github.com/RubyDevil/soulframe/issues). See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the development setup and the package's boundary rules.

## License

[MIT](./LICENSE) © RubyDevil.
