/**
 * The persona test: two personas talk to each other through their real brains and reply queues, on a live model, at
 * the pace the settings give (seconds to minutes between messages, their hours, their interruptions), then a model
 * reviews the conversation. The queues run on a step clock (`createStepClock`): every wait is skipped, while every
 * timestamp (in the store, the prompts and the transcript) is what it would have been live, from the real time on.
 * A conversation of hours runs in the time its model calls take.
 *
 *   npx tsx scripts/persona-test/run.ts --help
 *
 * Writes the transcript, the report, every runtime event, the run as JSON and the SQLite database to --out.
 * See docs/testing.md ("Two personas, live").
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import {
	createBrain,
	createCannedLlm,
	createConfiguredDecisions,
	createReplyQueue,
	createStepClock,
	createStore,
	createTokenMeter,
	DISABLED_DECISIONS,
	HOUR,
	isPlainObject,
	llmsFor,
	MINUTE,
	modelKeys,
	openDatabase,
	parsePersonaMarkdown,
	parseServiceSettings,
	parseSettings,
	spanAt,
	type Channel,
	type Conversation,
	type Decisions,
	type Llm,
	type Persona,
	type Rng,
	type Runtime,
	type Settings,
} from 'soulframe';
import { localTime, metricsOf, parseAnalysis, reportMarkdown, transcriptMarkdown, duration, type Analysis, type EndState, type LoggedEvent, type ModelCall, type RunSummary, type Sent, type Side } from './report.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const HELP = `Two personas talk to each other on a live model, their waits skipped, then a model reviews it.

  npx tsx scripts/persona-test/run.ts [options]

Personas and setting
  --a <file.md>          the persona who opens (default examples/personas/robin.md)
  --b <file.md>          the other persona (default examples/personas/noa.md)
  --opener <text>        the first message, from --a (default "hey! how's your day going?")
  --where <text>         the channel, as the brain is told it (default "a private chat app")
  --identity <text>      the app's phrase after each persona's name in its identity line (default none)
  --adult                mark the channel 18+ (the minors safeguard runs on every message)

Models (OpenAI-compatible)
  --settings <file.yaml> the brains' settings (models, pacing, memory...); default every default
  --service <file.yaml>  the service settings (budget, Decisions client); default no token limit
  --base-url <url>       models.default.baseUrl (or LLM_BASE_URL)
  --model <name>         models.default.model (or LLM_MODEL)
  --judge-model <name>   the reviewer's model (or LLM_JUDGE_MODEL; default the personas')
                         The key is read from models.default.apiKeyEnv: LLM_API_KEY by default.
  --canned               no network: canned lines and no review (a smoke test of the harness)

When and how long
  --start <when>         "now", "online" (default: now, or the next time both are online with 45 min
                         left) or an ISO time
  --messages <n>         stop after n messages, the opener included (default 30)
  --hours <h>            stop after h hours of persona time (default 24)

Output
  --out <dir>            where to write the results (default persona-test-results/<time>)
  --no-review            skip the model's review
  --min-score <n>        exit 1 when the review's overall score is under n (1 to 5)
  --quiet                print only the summary
`;

const { values: args } = parseArgs({
	options: {
		a: { type: 'string', default: 'examples/personas/robin.md' },
		b: { type: 'string', default: 'examples/personas/noa.md' },
		opener: { type: 'string', default: "hey! how's your day going?" },
		where: { type: 'string', default: 'a private chat app' },
		identity: { type: 'string' },
		adult: { type: 'boolean', default: false },
		settings: { type: 'string' },
		service: { type: 'string' },
		'base-url': { type: 'string' },
		model: { type: 'string' },
		'judge-model': { type: 'string' },
		canned: { type: 'boolean', default: false },
		start: { type: 'string', default: 'online' },
		messages: { type: 'string', default: '30' },
		hours: { type: 'string', default: '24' },
		out: { type: 'string' },
		'no-review': { type: 'boolean', default: false },
		'min-score': { type: 'string' },
		quiet: { type: 'boolean', default: false },
		help: { type: 'boolean', short: 'h', default: false },
	},
	strict: true,
});

if (args.help) {
	console.log(HELP);
	process.exit(0);
}

/** Stops with a message: a problem of the setup, not of the conversation. */
function fail(message: string): never {
	console.error(`persona-test: ${message}`);
	process.exit(2);
}

/** A whole number of at least `min` from an option. */
const count = (name: string, text: string, min: number) => {
	const value = Number(text);
	if (!Number.isFinite(value) || value < min) fail(`--${name} must be a number of at least ${min} (got ${JSON.stringify(text)})`);
	return value;
};

const fromRoot = (path: string) => resolve(ROOT, path);
const readYaml = (path: string): Record<string, unknown> => {
	let value: unknown;
	try {
		value = parse(readFileSync(fromRoot(path), 'utf8')) ?? {};
	} catch (error) {
		fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isPlainObject(value)) fail(`${path}: must be a mapping`);
	return value;
};

const live = !args.canned;
const maxMessages = count('messages', args.messages, 2);
const maxHours = count('hours', args.hours, 0.1);
const minScore = args['min-score'] ? count('min-score', args['min-score'], 1) : undefined;
const baseUrl = args['base-url'] ?? (process.env.LLM_BASE_URL || undefined);
const model = args.model ?? (process.env.LLM_MODEL || undefined);
const judgeModel = args['judge-model'] ?? (process.env.LLM_JUDGE_MODEL || undefined);
const apiKeyOf = (name: string) => process.env[name] ?? '';

// --- Settings ------------------------------------------------------------------------------------------------------

/** The settings as written, with --base-url and --model over models.default. */
const rawSettings = args.settings ? readYaml(args.settings) : {};
const rawModels = isPlainObject(rawSettings.models) ? rawSettings.models : {};
const withModels = (models: Record<string, unknown>) => ({ ...rawSettings, models });
const personaModels = {
	...rawModels,
	default: { ...(isPlainObject(rawModels.default) ? rawModels.default : {}), ...(baseUrl && { baseUrl }), ...(model && { model }) },
};

const settingsOf = (raw: unknown, source: string): Settings => {
	const { settings, issues } = parseSettings(raw, { source });
	if (!settings) fail(`the settings have problems:\n  ${issues.join('\n  ')}`);
	return settings;
};
const settings = settingsOf(live ? withModels(personaModels) : rawSettings, args.settings ?? 'settings');

// Without a service file, no daily limit: a test run should not wait for tomorrow's budget
const { service, issues: serviceIssues } = parseServiceSettings(args.service ? readYaml(args.service) : { text: { dailyTokens: 0 } }, { source: args.service ?? 'service settings' });
if (!service) fail(`the service settings have problems:\n  ${serviceIssues.join('\n  ')}`);

if (live) {
	const resolved = settings.models.default;
	if (!resolved.baseUrl || !resolved.model) fail('no model: set LLM_BASE_URL and LLM_MODEL (or --base-url, --model, or models.default in --settings), or run with --canned');
	const missing = [...modelKeys(settings).keys()].filter((name) => !process.env[name]);
	if (missing.length) fail(`no API key: set ${missing.join(', ')} (models.default.apiKeyEnv names the variable; '' for none)`);
}

// --- Personas ------------------------------------------------------------------------------------------------------

const CHANNEL_ID = 'chat';
const channel: Channel = { id: CHANNEL_ID, where: args.where, maxLength: 1000, ...(args.adult && { adult: true }) };

const personaFrom = (path: string): Persona => {
	let text: string;
	try {
		text = readFileSync(fromRoot(path), 'utf8');
	} catch (error) {
		fail(`can't read ${path} (${(error as { code?: string }).code ?? String(error)})`);
	}
	const { persona, issues } = parsePersonaMarkdown(text, { id: basename(path, '.md'), channels: [CHANNEL_ID], adult: args.adult, settings, source: path });
	if (!persona) fail(`the persona has problems:\n  ${issues.join('\n  ')}`);
	return persona;
};
const personas = [personaFrom(args.a), personaFrom(args.b)] as const;
if (personas[0].id === personas[1].id) fail(`the two personas have the same id ("${personas[0].id}"): use two files of different names`);

// --- The clock -----------------------------------------------------------------------------------------------------

const realStart = Date.now();

/** From `from`, the first time (in 5-minute steps, within 8 days) both are online here with at least 45 minutes left for each. */
const bothOnline = (from: number) => {
	for (let at = from; at < from + 8 * 24 * HOUR; at += 5 * MINUTE) {
		const spans = personas.map((persona) => spanAt(persona, at, CHANNEL_ID));
		if (spans.every((span) => span?.kind === 'online' && span.end - at >= 45 * MINUTE)) return at;
	}
	return null;
};

const startAt = (() => {
	if (args.start === 'now') return realStart;
	if (args.start === 'online') {
		const at = bothOnline(realStart);
		if (at === null) console.warn('persona-test: the two are never online together in the next 8 days: starting now');
		return at ?? realStart;
	}
	const at = Date.parse(args.start);
	if (Number.isNaN(at)) fail(`--start must be "now", "online" or an ISO time (got ${JSON.stringify(args.start)})`);
	return at;
})();

const clock = createStepClock({ start: startAt });

/** mulberry32: a canned run draws the same numbers each time. */
const seeded = (seed: number): Rng => () => {
	seed = (seed + 0x6d2b79f5) >>> 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rng: Rng = live ? Math.random : seeded(42);

// --- Output --------------------------------------------------------------------------------------------------------

const outDir = resolve(args.out ?? join(ROOT, 'persona-test-results', new Date(realStart).toISOString().replace(/[:.]/g, '-').slice(0, 19)));
mkdirSync(outDir, { recursive: true });
const say = (line: string) => {
	if (!args.quiet) console.log(line);
};

// --- The runtime, the models, the brains ---------------------------------------------------------------------------

const db = openDatabase(join(outDir, 'conversation.db'));
const store = createStore(db, clock.now);
const events: LoggedEvent[] = [];
const sent: Sent[] = [];
const calls: ModelCall[] = [];
const typing: { persona: string; on: boolean; at: number }[] = [];

/** Events worth a line while it runs: what a reader of the transcript would want to know happened between messages. */
const SHOWN: Record<string, (detail: Record<string, unknown>) => string> = {
	away: (detail) => `away until ${String(detail.until).slice(11, 16)} UTC`,
	reply_waiting: (detail) => `waits for its hours (${String(detail.reason)})${detail.nextOpenAt ? `, back ${String(detail.nextOpenAt).slice(0, 16).replace('T', ' ')} UTC` : ''}`,
	reply_skipped: () => 'left it on read',
	reply_restarted: () => 'started its draft over',
	reply_failed: (detail) => `the model failed (attempt ${String(detail.attempt)}): ${String(detail.error)}`,
	reply_waiting_provider: (detail) => `the provider is down, waiting: ${String(detail.error)}`,
	delivery_failed: (detail) => `delivery failed: ${String(detail.error)}`,
};
const nameOf = (id: string) => personas.find((persona) => persona.id === id)?.name ?? id;

const runtime: Runtime = {
	now: clock.now,
	rng,
	store,
	dryRun: false,
	halted: () => false,
	timers: clock.timers,
	log(persona, event, detail = {}) {
		const at = clock.now();
		events.push({ at, persona, event, detail });
		const shown = SHOWN[event];
		if (shown) say(`${new Date(at).toISOString().slice(11, 19)}            (${nameOf(persona)} ${shown(detail)})`);
	},
};

let tokens = 0;
const meter = createTokenMeter(store, service.text.dailyTokens, clock.now);
const countedMeter = { ...meter, add: (spent: number) => ((tokens += spent), meter.add(spent)) };

/** A model client whose calls the clock waits for (no wait is skipped while one is under way), each timed. */
const tracked = (persona: string, llm: Llm): Llm => ({
	complete(messages, options) {
		const began = performance.now();
		return clock.track(
			llm.complete(messages, options).then(
				(text) => {
					calls.push({ persona, task: options.task, ms: performance.now() - began });
					return text;
				},
				(error: unknown) => {
					calls.push({ persona, task: options.task, ms: performance.now() - began, error: String(error) });
					throw error;
				},
			),
		);
	},
});

const models = live
	? llmsFor(personas.map((persona) => ({ id: persona.id, settings })), { dryRun: false, apiKeyOf, meter: countedMeter, budget: service.text, rng })
	: new Map(personas.map((persona) => [persona.id, createCannedLlm(rng)]));

const configured = live
	? createConfiguredDecisions({ settings: service.decisions, apiKeyOf, meter: createTokenMeter(store, service.decisions.dailyTokens, clock.now, 'decisionTokens'), log: runtime.log, rng, now: clock.now })
	: DISABLED_DECISIONS;
const decisions: Decisions = configured.enabled ? { enabled: true, ask: (...asked) => clock.track(configured.ask(...asked)) } : configured;

const sides = personas.map((persona) => {
	const brain = createBrain({ persona, settings, identity: args.identity, runtime, llm: tracked(persona.id, models.get(persona.id)!), decisions });
	const queue = createReplyQueue({ brain, runtime, act: async () => undefined });
	return { persona, brain, queue };
});

let lastShownAt: number | undefined;
/** A message from side `from` reaches the other: in the transcript, then to the other's brain and queue, as an adapter would hand it on. */
const pass = (from: 0 | 1, text: string) => {
	const me = sides[from]!;
	const other = sides[from === 0 ? 1 : 0]!;
	const at = clock.now();
	sent.push({ from: me.persona.id, text, at });
	const gap = lastShownAt === undefined ? '' : `+${duration(at - lastShownAt)}`;
	lastShownAt = at;
	say(`${new Date(at).toISOString().slice(11, 19)} ${gap.padStart(10)}  ${me.persona.name}: ${text}`);
	const decision = other.brain.incoming(channel, me.persona.id, me.persona.name, text);
	other.queue.handle(decision, conversationOf(from === 0 ? 1 : 0), text).catch((error: unknown) => runtime.log(other.persona.id, 'handle_failed', { error: String(error) }));
};

/** Where side `i`'s replies go: to the other persona. */
const conversationOf = (i: 0 | 1): Conversation => ({
	channel,
	async typing(on) {
		typing.push({ persona: sides[i]!.persona.id, on, at: clock.now() });
	},
	async send(text) {
		pass(i, text);
	},
});

// --- The conversation ----------------------------------------------------------------------------------------------

/** Whether `side` still owes the other a turn: their newest message has not had one yet. */
const owes = (side: (typeof sides)[number], other: (typeof sides)[number]) => {
	const person = store.person(side.persona.id, CHANNEL_ID, other.persona.id);
	return !!person && person.state === 'active' && person.lastInAt > person.handledAt;
};
const [a, b] = sides as [(typeof sides)[0], (typeof sides)[1]];

say(`Persona test: ${a.persona.name} and ${b.persona.name}, ${live ? `live on ${settings.models.default.model}` : 'canned model'}`);
say(`Starting ${new Date(startAt).toISOString().replace('T', ' ').slice(0, 16)} UTC (${a.persona.name}: ${localTime(startAt, a.persona.timezone)}, ${b.persona.name}: ${localTime(startAt, b.persona.timezone)}); results in ${outDir}\n`);

for (const side of sides) side.queue.start();
// The opener goes out outside the queue, as one the app sent for it
a.brain.outgoing(channel, b.persona.id, b.persona.name, args.opener);
pass(0, args.opener);

const deadline = startAt + maxHours * HOUR;
const outcome = await clock.run({ until: deadline, done: () => sent.length >= maxMessages || (!owes(a, b) && !owes(b, a)) });
for (const side of sides) side.queue.stop();
// A model call under way finishes (its turn then finds the queue stopped and sends nothing more)
await clock.settle();
const end = Math.max(sent.at(-1)?.at ?? startAt, Math.min(clock.now(), deadline));

const ended =
	outcome === 'until' ? `the ${maxHours}-hour limit` : sent.length >= maxMessages ? `the ${maxMessages}-message limit` : outcome === 'done' ? 'neither owed the other a reply' : 'nothing left to do';

// --- What it measured ----------------------------------------------------------------------------------------------

const sideInfo: Side[] = personas.map(({ id, name, timezone, prompt }) => ({ id, name, timezone, prompt }));
const metrics = Object.fromEntries(personas.map((persona) => [persona.id, metricsOf(persona.id, { sent, events, calls, typing })]));
const endState: Record<string, EndState> = {};
for (const [side, other] of [[a, b], [b, a]] as const) {
	const person = store.person(side.persona.id, CHANNEL_ID, other.persona.id);
	if (!person) continue;
	endState[side.persona.id] = {
		state: person.state,
		notes: person.summary,
		self: store.get(side.persona.id, 'selfNotes') ?? '',
		familiarity: person.familiarity,
		affinity: person.affinity,
		importance: person.importance,
	};
}
const run: RunSummary = { start: startAt, end, realMs: Date.now() - realStart, skippedMs: clock.skipped(), tokens, ended, live, model: live ? settings.models.default.model ?? null : null };

// --- The review ----------------------------------------------------------------------------------------------------

let analysis: Analysis | undefined;
let analysisProblem: string | undefined;
let analysisRaw: string | undefined;
if (!live) analysisProblem = 'a canned run is not reviewed';
else if (args['no-review']) analysisProblem = 'skipped (--no-review)';
else if (sent.length < 2) analysisProblem = 'nothing to review: the other persona never answered';
else {
	say('\nReviewing the conversation...');
	// The reviewer: the personas' provider, its own model when given, room for a long answer and a long transcript
	const judgeSettings = settingsOf(
		withModels({
			...personaModels,
			directMessage: { ...(isPlainObject(rawModels.directMessage) ? rawModels.directMessage : {}), ...(judgeModel && { model: judgeModel }), maxTokens: 4000, temperature: 0.2, timeoutSeconds: 300 },
		}),
		'the reviewer settings',
	);
	const judge = llmsFor([{ id: 'reviewer', settings: judgeSettings }], { dryRun: false, apiKeyOf, budget: service.text, rng }).get('reviewer')!;
	const review = {
		personas: sideInfo,
		channel: args.where,
		ended,
		transcript: sent.map((message, i) => ({
			from: message.from,
			text: message.text,
			utc: new Date(message.at).toISOString(),
			senderLocal: localTime(message.at, personas.find((persona) => persona.id === message.from)!.timezone),
			gapSeconds: i ? Math.round((message.at - sent[i - 1]!.at) / 1000) : null,
		})),
		metrics,
		endState,
	};
	try {
		analysisRaw = await judge.complete(
			[
				{ role: 'system', content: readFileSync(join(HERE, 'analysis.md'), 'utf8') },
				{ role: 'user', content: JSON.stringify(review, null, '\t') },
			],
			{ task: 'directMessage', json: true },
		);
		({ analysis, problem: analysisProblem } = parseAnalysis(analysisRaw));
	} catch (error) {
		analysisProblem = `the review failed: ${error instanceof Error ? error.message : String(error)}`;
	}
}

// --- The results ---------------------------------------------------------------------------------------------------

const transcript = transcriptMarkdown(sideInfo, sent, run);
const report = reportMarkdown({ sides: sideInfo, run, sent, metrics, endState, analysis, analysisProblem, transcript });
writeFileSync(join(outDir, 'transcript.md'), transcript);
writeFileSync(join(outDir, 'report.md'), report);
writeFileSync(join(outDir, 'events.jsonl'), events.map((event) => JSON.stringify({ ...event, at: new Date(event.at).toISOString() })).join('\n') + '\n');
writeFileSync(
	join(outDir, 'run.json'),
	JSON.stringify({ run, personas: sideInfo, settings: { opener: args.opener, where: args.where, adult: args.adult, maxMessages, maxHours }, transcript: sent, metrics, endState, calls, analysis: analysis ?? null, analysisProblem: analysisProblem ?? null, analysisRaw: analysisRaw ?? null }, null, '\t'),
);
db.close();
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

// --- How it went ---------------------------------------------------------------------------------------------------

const broken = [
	...personas.flatMap((persona) => (metrics[persona.id]!.events.gaveUp ? [`${persona.name} gave up on a reply`] : [])),
	...(sent.every((message) => message.from === a.persona.id) ? [`${b.persona.name} never answered`] : []),
	...(minScore !== undefined && !analysis ? [`no review to hold to --min-score (${analysisProblem})`] : []),
	...(minScore !== undefined && analysis && analysis.overall < minScore ? [`the review scored it ${analysis.overall}/5, under --min-score ${minScore}`] : []),
];

console.log(`\n${sent.length} messages, ${duration(end - startAt)} of persona time in ${duration(run.realMs)}; ended: ${ended}.`);
if (analysis) console.log(`Review: ${analysis.overall}/5. ${analysis.summary}`);
else console.log(`No review: ${analysisProblem}.`);
console.log(`Report: ${join(outDir, 'report.md')}`);
if (broken.length) {
	console.error(`\nFailed: ${broken.join('; ')}.`);
	process.exitCode = 1;
}
