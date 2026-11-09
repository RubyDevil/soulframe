<div align="center">

<img src="./assets/soulframe-logo.svg" alt="soulframe" width="300">

**AI personas that keep hours, remember people and chat at a human pace, on any channel you plug in.**

[![npm](https://img.shields.io/npm/v/soulframe/beta?color=cb3837&logo=npm)](https://www.npmjs.com/package/soulframe)
[![CI](https://github.com/RubyDevil/soulframe/actions/workflows/ci.yml/badge.svg)](https://github.com/RubyDevil/soulframe/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

soulframe is a TypeScript framework for running AI personas. It owns the persona, its schedule, its memory and the
pace of its replies. You write an adapter for each channel, and the package stays independent of any platform.

> [!IMPORTANT]
> soulframe is in beta: the API, the config and the database layout may change before 1.0. Install `soulframe@beta`
> and pin the exact version you test with. See the [roadmap](./docs/roadmap.md) for current limits.

## Features

- **Personas as config and prompt:** the data the code needs, checked with exact error locations, and free Markdown for
  the rest; optionally one Markdown file per persona, its config as frontmatter.
- **Realistic schedules:** online hours, breaks and busy blocks, drawn per day from a seed.
- **Human pacing:** one conversation at a time, with reading, typing and interruptions timed like a person's.
- **Long-term memory:** people, history, notes and relationships in a single SQLite file.
- **Photos and links:** photos are described once by a vision model; links expose only their preview card.
- **Any OpenAI-compatible provider:** one model per task, with a shared daily token budget.
- **Safeguards in code:** stop requests are always honored, with an opt-in 18+ safeguard and optional typed checks.
- **Testable offline:** the clock, randomness, files and model are all injected.

soulframe has no content policy of its own. What a persona may say is decided by your model, its prompt and the
`policy` you pass in.

## Install

```sh
npm install soulframe@beta
```

Requires Node.js 22.13 or newer. Ships ESM, CommonJS and type declarations.

## Quick start

This runs offline with the canned model. Save it as `quick-start.mts` and run `npx tsx quick-start.mts`.

```ts
import {
	createBrain,
	createCannedLlm,
	createReplyQueue,
	createRuntime,
	createStore,
	openDatabase,
	parsePersona,
	parseSettings,
	type Conversation,
} from 'soulframe';

// A fixed clock and randomness for the demo: a real service keeps the defaults
const now = () => Date.UTC(2026, 0, 15, 20, 0);
const rng = () => 0.5;

// A persona: its config (what the code computes with) and its prompt (everything else)
const { persona, issues } = parsePersona({
	config: {
		id: 'robin',
		name: 'Robin',
		timezone: 'UTC',
		schedule: { days: { 'mon-sun': { online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }] } } },
	},
	prompt: 'You are Robin, warm and curious, writing in lowercase.',
	channels: ['console'],
});
if (!persona) throw new Error(issues.join('\n'));

// What its brain runs with. Instant replies for the demo: the defaults wait as a person would
const { settings, issues: problems } = parseSettings({
	pacing: {
		glance: { delaySeconds: [0, 0] },
		interruptions: { meanMinutes: 0 },
		readingDurationSeconds: [0, 0],
		typingDurationSeconds: [0, 0],
		burst: { settleSeconds: [0, 0] },
	},
});
if (!settings) throw new Error(problems.join('\n'));

const store = createStore(openDatabase(':memory:'), now);
const runtime = createRuntime({ store, dryRun: false, haltFile: './HALT', rng, now });
const brain = createBrain({ persona, settings, identity: 'a character in a demo', runtime, llm: createCannedLlm(rng) });
const queue = createReplyQueue({ brain, runtime, act: async () => {} });

// A channel: where the conversation happens, and how a message goes out
const conversation: Conversation = {
	channel: { id: 'console', where: 'a terminal chat', maxLength: 500 },
	async typing() {},
	async send(text) {
		console.log(`Robin: ${text}`);
	},
};

const text = 'hey robin, how is your evening going?';
await queue.handle(brain.incoming(conversation.channel, 'sam', 'Sam', text), conversation, text);
```

Replace `createCannedLlm` with a real client ([configuration](./docs/configuration.md#llm)) to talk through your
provider. [`examples/console-chat.ts`](./examples/console-chat.ts) is a longer, commented version, and
[`examples/personas/robin.md`](./examples/personas/robin.md) a persona as a file (`loadPersonas`).

## Documentation

| Guide | Covers |
| --- | --- |
| [Concepts](./docs/concepts.md) | How the persona, agenda, channels, queue, memory and safeguards fit together |
| [Configuration](./docs/configuration.md) | Every setting, with its type, default and range |
| [Attention and timing](./docs/attention.md) | When a persona answers, who goes first and how it gets to know people |
| [Channel adapters](./docs/channels.md) | Connecting a platform: messages, photos, delivery errors, restarts |
| [System prompts](./docs/prompts.md) | Every part of every prompt and typed check |
| [Testing](./docs/testing.md) | The canned model, in-memory stores, a fixed clock and randomness |
| [API reference](./docs/api.md) | Every export of the package |
| [Roadmap](./docs/roadmap.md) | Current limits and what is planned before 1.0 |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) and the [changelog](./CHANGELOG.md).

## License

[MIT](./LICENSE) © RubyDevil
