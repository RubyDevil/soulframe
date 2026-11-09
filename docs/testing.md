# Testing

Everything in soulframe that depends on time, chance, files or a model takes it as a parameter, so a test can fix
it. The package's own tests (`test/`, run with Vitest: `npm test`) use the same tools as below.

## A persona without files

`parsePersona` takes the config as values and the prompt as text, so no file is read:

```ts
import { parsePersona, parseSettings, type Persona, type Settings } from 'soulframe';

export function testPersona(fields: Record<string, unknown> = {}): Persona {
	const { persona, issues } = parsePersona({
		config: { id: 'test', name: 'Test', timezone: 'UTC', schedule: { days: { 'mon-sun': { online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }] } } }, ...fields },
		prompt: 'A friendly voice.',
		channels: ['chat'],
	});
	if (!persona) throw new Error(issues.join('\n'));
	return persona;
}

/** Settings for a test brain, as written: every other one at its default. */
export function testSettings(raw: unknown = {}): Settings {
	const { settings, issues } = parseSettings(raw);
	if (!settings) throw new Error(issues.join('\n'));
	return settings;
}
```

To test config errors, assert on `issues`. `parsePersonaMarkdown` reads a persona file's text, and `loadPersonas`
takes a `files` option (`ConfigFiles`: `read` and `exists`) for a folder that lives only in memory. If your
application loads its personas with `adult: true` (for 18+ conversations), pass it in tests too, so they run the same
checks.

## An in-memory store

```ts
import { createStore, openDatabase } from 'soulframe';

const store = createStore(openDatabase(':memory:'), () => NOW);
```

Each `':memory:'` database is its own, fresh and gone when the test ends; nothing touches the disk. The store's `now`
stamps people, messages and audit lines. `store.auditLog()` and `store.history(personId)` are the easiest things to
assert on.

`node:sqlite` is loaded with `process.getBuiltinModule`, which no bundler or test resolver intercepts, so Vitest
(whose resolver doesn't know `node:sqlite`) runs the store without any configuration.

## A fixed clock and fixed randomness

Give `now` and `rng` to the store and the runtime; the brain runs on the runtime, as its reply queue does:

```ts
const NOW = Date.UTC(2026, 9, 15, 20, 0); // inside the persona's hours (19:00 to 23:00 UTC)
const now = () => NOW;
const rng = () => 0; // or 0.5, or your own seeded source

const store = createStore(openDatabase(':memory:'), now);
const runtime = createRuntime({ store, dryRun: false, haltFile: '/no/such/file', rng, now });
const brain = createBrain({ persona, settings: testSettings(), identity: 'a guide made by Example', runtime, llm });
```

A brain tested without a queue needs only those three: `createBrain({ persona, settings, runtime: { store, now, rng }, llm })`.

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

`createCannedLlm(rng)` answers one of a few fixed lines for DMs and group chats (as the JSON the brain expects), a
fixed post and, once `models.vision.model` is set, a fixed photo description. It never touches the network: good for flows where the text doesn't matter.

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
		if (task === 'vision') return '{"seen": "a grey cat asleep on a laptop"}';
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

Return `null` from `ask` to test that a failure behaves as if the checks were off. The brain's `settings.decisions`
(`createBrain({ settings })`) say which checks run and their thresholds; `enabled` on the
`Decisions` object is what the brain reads to know whether any can run.

## The reply queue

The reply queue uses real timers (`setTimeout`, `setInterval`) for its delays, typing and backlog. Two ways to keep
tests fast:

- **Zero the pacing** in the test brain's settings: `testSettings({ pacing: { glance: { delaySeconds: [0, 0] },
  watching: { delaySeconds: [0, 0] }, interruptions: { meanMinutes: 0 }, typingDurationSeconds: [0, 0],
  betweenReplyMessagesSeconds: [0, 0] } })` (and `readingDurationSeconds: [0, 0]`, `looking: [0, 0]`, `burst: { settleSeconds: [0, 0] }`),
  then wait
  for the `reply_sent` event (wrap `runtime.log`) or poll the store. A code goodbye (`final`) still waits 2 to 10
  seconds.
- **Interruptions** (`pacing.interruptions`) come from the persona's own seed, per day, as its agenda does, not from
  the `rng` you pass: a test at a fixed time is inside one or not, the same on every run. Turn them off
  (`interruptions: { meanMinutes: 0 }`) where they are not what the test is about; the config check
  (`personaReport`) lists today's.
- **Fake timers**: Vitest's `vi.useFakeTimers()` and `await vi.runAllTimersAsync()` (or `advanceTimersByTimeAsync`).
  Don't call `queue.start()` under `runAllTimersAsync`: its 30-second interval never ends.
- **A step clock**: keep the real pacing and skip its waits. `createStepClock()` gives a `now` and `timers` for the
  runtime (`createRuntime({ ..., now: clock.now, timers: clock.timers })`); wrap the model's calls in `clock.track`
  and `await clock.run({ done })`. Each timer runs as the clock is stepped to it, the clock moved forward to when it
  was due, so every stored message and prompt reads the time it would have live. Unlike fake timers it needs no test
  framework and never skips a wait while a model call is under way, so it also runs against a live model.

Call `queue.stop()` at the end of a test that started anything. A `Runtime` you write yourself
(`{ now, rng, store, dryRun, halted: () => false, log }`) avoids the halt file and keeps the console quiet; with
`createRuntime`, give a `haltFile` that doesn't exist, or create it to test the halt switch.

## Two personas, live

`npm run persona-test` ([`scripts/persona-test/run.ts`](../scripts/persona-test/run.ts)) is the whole stack against
a live model, for improving the personas and the framework: two personas talk to each other through their own brains
and reply queues, at the pace their settings give (glances, reading, typing, interruptions, their hours), on a step
clock that skips every wait. Timestamps start at the real time and move on as they would live, so an evening's
conversation runs in the time its model calls take, and the model calls' own time counts as the personas' reading
time, as it does live. Then a model reviews each conversation against a rubric
([`scripts/persona-test/analysis.md`](../scripts/persona-test/analysis.md)), given the transcript, the metrics, what
each persona noted and the system prompt each was last sent: character, naturalness, coherence, memory, pacing,
engagement and variety, each scored 1 to 5, and every problem quoted, with the area its fix belongs to (`persona`:
the persona file; `framework`: soulframe's prompts and code; `pacing`; `memory`; `model`) and a suggestion.

```sh
export LLM_BASE_URL=https://api.provider.example/v1 LLM_MODEL=provider-chat-large LLM_API_KEY=...
npm run persona-test -- --suite scripts/persona-test/suite.yaml --runs 3             # the suite, each scenario 3 times
npm run persona-test -- --suite scripts/persona-test/suite.yaml --runs 3 --baseline persona-test-results/<earlier>
npm run persona-test -- --a my-persona.md --opener "hey" --messages 40               # one conversation
npm run persona-test -- --canned --suite scripts/persona-test/suite.yaml              # offline: canned lines, no review
```

**The suite** ([`scripts/persona-test/suite.yaml`](../scripts/persona-test/suite.yaml)) holds the same scenarios on
every run, so two runs compare: `evening` (a first chat while both are free), `closing` (one of them has to go soon,
and they pick it up the next day) and `away` (the other is offline when it starts and answers hours later). A
scenario sets its personas, opener, start (`online`, `closing`, `away`, `now` or an ISO time), message and hour
limits and channel; `--a`, `--b`, `--messages`, `--hours` and `--adult` override every scenario's, so the suite can
test your own personas. `--only` picks scenarios, `--runs` repeats each. A conversation stops at its message limit
(the opener included), its hour limit, or once neither owes the other a reply (one left the other on read).

**Improving with it.** A review varies from run to run as the conversations do: run each scenario a few times and
read the means. Run the suite once before a change (on `main`, say) and once after, the second with `--baseline` on
the first's results: the summary shows each mean's change. The issues are grouped by area; each conversation's
`calls.jsonl` holds every prompt the models were sent and what they answered, to trace an issue to the instruction
behind it. `--judge-model` gives the reviewer a model of its own (keep it the same across the runs you compare), and
`--min-score` makes the run fail when the mean overall score is under it. `--settings` and `--service` take the same
files as an application (models, pacing, budget, the Decisions client); without a service file there is no daily
token limit. `--help` lists the rest.

The results go to `--out` (default `persona-test-results/<time>/`): `summary.md` and `summary.json` (the scores by
scenario, with the changes since the baseline; the issues by area; every conversation), and for each conversation, in
`<scenario>/<run>/`, its `report.md` (its review, its metrics side by side, what each persona noted about the other),
`transcript.md`, `calls.jsonl`, `events.jsonl` (every runtime event, timed), `run.json` and `conversation.db` (the
store). A single conversation writes straight into `--out`. The run fails (exit code 1) when a persona gave up on a
reply, when the other never answered, or under `--min-score`.

The **Persona test** workflow ([`.github/workflows/persona-test.yml`](../.github/workflows/persona-test.yml)) runs the
suite from the repository's Actions tab, with the repository secret `LLM_API_KEY` and the variables `LLM_BASE_URL`
and `LLM_MODEL` (optionally `LLM_JUDGE_MODEL`). Its inputs choose the suite, the scenarios, the runs, the personas,
the models and the settings; `baseline_run` is the id of an earlier run of the workflow (from its URL), whose results
it compares with. Run it on `main`, then on your branch with that run's id. The summary is the job's summary, and the
results are kept as the `persona-test` artifact for 90 days. CI runs the suite with `--canned` on every change, so it
keeps working.

## The example

`examples/console-chat.ts` puts all of this together: an inline persona, a `:memory:` store, the canned model, a fixed
clock and randomness, a quiet runtime and a console conversation. Run it with
`npx tsx examples/console-chat.ts` from a clone of this repository.
