# Testing

Everything in soulframe that depends on time, chance, files or a model takes it as a parameter, so a test can fix
it. The package's own tests (`test/`, run with Vitest: `npm test`) use the same tools as below.

## A persona without files

`parsePersonas` takes the YAML as values and a `readPrompt` function, so no file is read:

```ts
import { parsePersonas, type PersonaConfig } from 'soulframe';

export function testPersona(fields: Record<string, unknown> = {}): PersonaConfig {
	const loaded = parsePersonas({
		personas: [{ id: 'test', file: 'test.yaml', raw: { name: 'Test', timezone: 'UTC', window: { start: ['19:00', '19:00'], end: ['23:00', '23:00'] }, ...fields } }],
		channels: { test: ['chat'] },
		readPrompt: () => 'A friendly voice.',
	});
	if (loaded.issues.length) throw new Error(loaded.issues.join('\n'));
	return loaded.personas[0]!;
}
```

To test config errors, assert on `loaded.issues`. `loadPersonas` takes a `files` option (`ConfigFiles`: `read` and
`exists`) for a folder that lives only in memory. If your application loads its personas with `adult: true` (for 18+
conversations), pass it to `parsePersonas` too, so the tests run the same checks.

## An in-memory store

```ts
import { createStore, openDatabase } from 'soulframe';

const store = createStore(openDatabase(':memory:'), () => NOW);
```

Each `':memory:'` database is its own, fresh and gone when the test ends; nothing touches the disk. The store's `now`
stamps people, messages and audit lines. `store.auditLog()` and `store.history(personId)` are the easiest things to
assert on.

`node:sqlite` is loaded through Node's own `require`, so Vitest (whose resolver doesn't know it) runs the store
without any configuration.

## A fixed clock and fixed randomness

Give `now` and `rng` to the store and the runtime; the brain runs on the runtime, as its reply queue does:

```ts
const NOW = Date.UTC(2026, 9, 15, 20, 0); // inside the persona's hours (19:00 to 23:00 UTC)
const now = () => NOW;
const rng = () => 0; // or 0.5, or your own seeded source

const store = createStore(openDatabase(':memory:'), now);
const runtime = createRuntime({ store, dryRun: false, haltFile: '/no/such/file', rng, now });
const brain = createBrain({ persona, identity: 'a guide made by Example', runtime, llm });
```

A brain tested without a queue needs only those three: `createBrain({ persona, runtime: { store, now, rng }, llm })`.

The agenda is drawn from a seed of the persona id and the date, not from `rng`, so a fixed clock fixes the hours too:
check the spans with `spanAt(persona, NOW, 'chat')`. A constant `rng` makes every random choice the same (delays,
the canned line, splitting a long reply). The package does not export a seeded generator; any `() => number` in
`[0, 1)` works, such as a small mulberry32.

To move time, use a variable: `let at = NOW; const now = () => at;` and change `at` between steps.

The prompts and the checks follow what the brain is given, so build it as your application does: the same `policy`
(`createBrain({ ..., policy })`) and the same `Channel`s, `adult: true` included where yours have it. A test channel
without `adult` runs no age check, and a brain without a `policy` adds no rules and keeps every link.

## Models

### The canned model

`createCannedLlm(rng)` answers one of a few fixed lines for DMs and group chats (as the JSON the brain expects) and a
fixed post. It never touches the network: good for flows where the text doesn't matter.

### A scripted or recording model

For assertions on what the model is sent, or on how an answer is handled, implement `Llm` yourself:

```ts
import type { Llm, LlmMessage } from 'soulframe';

const sent: LlmMessage[][] = [];
const llm: Llm = {
	async complete(messages, { task }) {
		sent.push(messages);
		if (task === 'directMessage') return JSON.stringify({ reply: 'hey you!', notes: 'likes hiking', self: null, action: 'none' });
		if (task === 'groupChat') return '{"reply": null}';
		return 'evenings are for slow chats, say hi';
	},
};
```

`sent[0][0].content` is then the whole system prompt. `samplePrompt` builds the same prompt for a sample DM turn
without a test harness, which is handy for snapshot tests of a persona's prompt.

A DM answer is a JSON object with `reply` (a string, `\n` between messages, or `null`), `notes` and `self` (rewritten
notes, or `null` to keep them), `action` (`"none"`, `"block"`, or the name of one of the channel's `actions`) and, where invitations are offered,
`acceptInvite`. A rejection from `complete` is a failed attempt the reply queue retries (`settings.retries`).

## Decisions

`DISABLED_DECISIONS` (the brain's default) runs no checks. To test the typed checks, give the brain your own
`Decisions`: `enabled: true` and an `ask` that answers a `Map` from each question's name to an answer. The question
and answer types are not exported; derive them:

```ts
import type { Decisions } from 'soulframe';

type Questions = Parameters<Decisions['ask']>[1];
type Answers = NonNullable<Awaited<ReturnType<Decisions['ask']>>>;

/** Every predicate at `probability`, every score at `score`. */
const scripted = (probability: number, score = 0): Decisions => ({
	enabled: true,
	async ask(_input, questions: Questions) {
		const answers: Answers = new Map();
		for (const question of questions) {
			if (question.type === 'predicate') answers.set(question.name, { type: 'predicate', name: question.name, probability });
			else answers.set(question.name, { type: 'score', name: question.name, score, probabilities: {}, confidence: null });
		}
		return answers;
	},
});
```

Return `null` from `ask` to test that a failure behaves as if the checks were off. The settings in
`persona.settings.decisions` (set in `_shared.yaml`) say which checks run and their thresholds; `enabled` on the
`Decisions` object is what the brain reads to know whether any can run.

## The reply queue

The reply queue uses real timers (`setTimeout`, `setInterval`) for its delays, typing and backlog. Two ways to keep
tests fast:

- **Zero the pacing** in the test persona: `settings: { pacing: { quickReplyChance: 1, slowReplyChance: 0,
  quickReplyDelaySeconds: [0, 0], typingDurationSeconds: [0, 0], betweenReplyMessagesSeconds: [0, 0] } }` (and
  `readBeforeTypingSeconds: [0, 0]` for a conversation with `markRead`), then wait
  for the `reply_sent` event (wrap `runtime.log`) or poll the store. A code goodbye (`final`) still waits 2 to 10
  seconds.
- **Fake timers**: Vitest's `vi.useFakeTimers()` and `await vi.runAllTimersAsync()` (or `advanceTimersByTimeAsync`).
  Don't call `queue.start()` under `runAllTimersAsync`: its 30-second interval never ends.

Call `queue.stop()` at the end of a test that started anything. A `Runtime` you write yourself
(`{ now, rng, store, dryRun, halted: () => false, log }`) avoids the halt file and keeps the console quiet; with
`createRuntime`, give a `haltFile` that doesn't exist, or create it to test the halt switch.

## The example

`examples/console-chat.ts` puts all of this together: an inline persona, a `:memory:` store, the canned model, a fixed
clock and randomness, a quiet runtime and a console conversation. Run it with
`npx tsx examples/console-chat.ts` from a clone of this repository.
