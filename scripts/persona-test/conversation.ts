/**
 * One persona test conversation: two personas talk to each other through their own brains and reply queues on a step
 * clock (every wait skipped, every timestamp kept), then, on a live model, a model reviews it. Writes its transcript,
 * report, events, model calls and store to its own folder and answers what it measured.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
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
	llmsFor,
	MINUTE,
	openDatabase,
	parsePersonaMarkdown,
	spanAt,
	type Channel,
	type Conversation,
	type Decisions,
	type Llm,
	type LlmMessage,
	type Persona,
	type Rng,
	type Runtime,
	type ServiceSettings,
	type Settings,
} from 'soulframe';
import { duration, localTime, metricsOf, parseAnalysis, reportMarkdown, transcriptMarkdown, type Analysis, type EndState, type LoggedEvent, type ModelCall, type PersonaMetrics, type RunSummary, type Sent, type Side } from './report.js';

/** A problem of the setup (a file, a setting), not of the conversation: the CLI stops on it. */
export class SetupError extends Error {}

/** When a scenario starts (see suite.yaml). */
export type StartRule = 'now' | 'online' | 'closing' | 'away' | number;

/** One conversation to run, everything resolved. */
export interface Scenario {
	name: string;
	/** The persona files: `a` opens. */
	a: string;
	b: string;
	opener: string;
	start: StartRule;
	messages: number;
	hours: number;
	where: string;
	adult: boolean;
}

/** What every conversation of a run shares. */
export interface Setup {
	live: boolean;
	settings: Settings;
	service: ServiceSettings;
	/** The reviewer's settings: none, no review. */
	reviewer?: Settings;
	/** Why there is no review, when there is none. */
	noReview?: string;
	apiKeyOf: (name: string) => string;
	identity?: string;
	/** The review rubric, the reviewer's system prompt. */
	rubric: string;
	/** Reads a file, by a path from the repository's root. */
	read: (path: string) => string;
	say: (line: string) => void;
}

/** What one conversation measured and how it went. */
export interface ConversationResult {
	scenario: string;
	run: number;
	dir: string;
	personas: Side[];
	summary: RunSummary;
	messages: number;
	metrics: Record<string, PersonaMetrics>;
	analysis?: Analysis;
	analysisProblem?: string;
	/** What makes the run fail whatever the review says: a reply given up, a persona that never answered. */
	broken: string[];
}

const CHANNEL_ID = 'chat';

/** mulberry32: a canned run draws the same numbers each time. */
export const seeded = (seed: number): Rng => () => {
	seed = (seed + 0x6d2b79f5) >>> 0;
	let t = seed;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** From `from`, in 5-minute steps within 8 days, the first time `fits` holds for the two spans open then. */
const firstTime = (personas: readonly [Persona, Persona], from: number, fits: (at: number, a: ReturnType<typeof spanAt>, b: ReturnType<typeof spanAt>) => boolean) => {
	for (let at = from; at < from + 8 * 24 * HOUR; at += 5 * MINUTE) {
		if (fits(at, spanAt(personas[0], at, CHANNEL_ID), spanAt(personas[1], at, CHANNEL_ID))) return at;
	}
	return null;
};

const left = (span: ReturnType<typeof spanAt>, at: number) => (span?.kind === 'online' ? span.end - at : -1);

/** The time a scenario starts, from the real time `from`: null when its rule finds none within 8 days. */
export function startOf(rule: StartRule, personas: readonly [Persona, Persona], from: number): number | null {
	if (typeof rule === 'number') return rule;
	if (rule === 'now') return from;
	if (rule === 'online') return firstTime(personas, from, (at, a, b) => Math.min(left(a, at), left(b, at)) >= 45 * MINUTE);
	if (rule === 'closing') return firstTime(personas, from, (at, a, b) => Math.min(left(a, at), left(b, at)) >= 15 * MINUTE && Math.min(left(a, at), left(b, at)) <= 30 * MINUTE);
	return firstTime(personas, from, (at, a, b) => left(a, at) >= 45 * MINUTE && b === null);
}

/** One model call as the trace keeps it: everything it was sent and answered, to trace an issue to its prompt. */
interface TracedCall extends ModelCall {
	at: string;
	messages: readonly LlmMessage[];
	answer?: string;
}

/** Runs one conversation of `scenario` into `dir` (run number `run`), reviewed when the setup has a reviewer. */
export async function converse(setup: Setup, scenario: Scenario, { dir, run }: { dir: string; run: number }): Promise<ConversationResult> {
	const { live, settings, service, apiKeyOf, say } = setup;
	const channel: Channel = { id: CHANNEL_ID, where: scenario.where, maxLength: 1000, ...(scenario.adult && { adult: true }) };

	const personaFrom = (path: string): Persona => {
		let text: string;
		try {
			text = setup.read(path);
		} catch (error) {
			throw new SetupError(`can't read ${path} (${(error as { code?: string }).code ?? String(error)})`);
		}
		const { persona, issues } = parsePersonaMarkdown(text, { id: basename(path, '.md'), channels: [CHANNEL_ID], adult: scenario.adult, settings, source: path });
		if (!persona) throw new SetupError(`the persona has problems:\n  ${issues.join('\n  ')}`);
		return persona;
	};
	const personas = [personaFrom(scenario.a), personaFrom(scenario.b)] as const;
	if (personas[0].id === personas[1].id) throw new SetupError(`the two personas have the same id ("${personas[0].id}"): use two files of different names`);

	const realStart = Date.now();
	const found = startOf(scenario.start, personas, realStart);
	if (found === null) say(`(no time within 8 days fits start: ${String(scenario.start)}: starting now)`);
	const startAt = found ?? realStart;
	const clock = createStepClock({ start: startAt });
	const rng: Rng = live ? Math.random : seeded(42 + run);

	const db = openDatabase(join(dir, 'conversation.db'));
	const store = createStore(db, clock.now);
	const events: LoggedEvent[] = [];
	const sent: Sent[] = [];
	const calls: TracedCall[] = [];
	const typing: { persona: string; on: boolean; at: number }[] = [];
	const nameOf = (id: string) => personas.find((persona) => persona.id === id)?.name ?? id;

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

	/** A model client whose calls the clock waits for (no wait is skipped while one is under way), each traced. */
	const tracked = (persona: string, llm: Llm): Llm => ({
		complete(messages, options) {
			const began = performance.now();
			const at = new Date(clock.now()).toISOString();
			const trace = (fields: { answer?: string; error?: string }) => calls.push({ persona, task: options.task, at, ms: performance.now() - began, messages, ...fields });
			return clock.track(
				llm.complete(messages, options).then(
					(answer) => (trace({ answer }), answer),
					(error: unknown) => {
						trace({ error: String(error) });
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
		const brain = createBrain({ persona, settings, identity: setup.identity, runtime, llm: tracked(persona.id, models.get(persona.id)!), decisions });
		return { persona, brain, queue: createReplyQueue({ brain, runtime, act: async () => undefined }) };
	});
	const [a, b] = sides as [(typeof sides)[0], (typeof sides)[1]];

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
	/** Whether `side` still owes the other a turn: their newest message has not had one yet. */
	const owes = (side: typeof a, other: typeof a) => {
		const person = store.person(side.persona.id, CHANNEL_ID, other.persona.id);
		return !!person && person.state === 'active' && person.lastInAt > person.handledAt;
	};

	say(`${scenario.name} #${run}: ${a.persona.name} and ${b.persona.name}, from ${new Date(startAt).toISOString().replace('T', ' ').slice(0, 16)} UTC (${a.persona.name}: ${localTime(startAt, a.persona.timezone)}, ${b.persona.name}: ${localTime(startAt, b.persona.timezone)})`);
	for (const side of sides) side.queue.start();
	// The opener goes out outside the queue, as one the app sent for it
	a.brain.outgoing(channel, b.persona.id, b.persona.name, scenario.opener);
	pass(0, scenario.opener);

	const deadline = startAt + scenario.hours * HOUR;
	const outcome = await clock.run({ until: deadline, done: () => sent.length >= scenario.messages || (!owes(a, b) && !owes(b, a)) });
	for (const side of sides) side.queue.stop();
	// A model call under way finishes (its turn then finds the queue stopped and sends nothing more)
	await clock.settle();
	const end = Math.max(sent.at(-1)?.at ?? startAt, Math.min(clock.now(), deadline));
	const ended =
		outcome === 'until' ? `the ${scenario.hours}-hour limit` : sent.length >= scenario.messages ? `the ${scenario.messages}-message limit` : outcome === 'done' ? 'neither owed the other a reply' : 'nothing left to do';

	const sideInfo: Side[] = personas.map(({ id, name, timezone, prompt }) => ({ id, name, timezone, prompt }));
	const metrics = Object.fromEntries(personas.map((persona) => [persona.id, metricsOf(persona.id, { sent, events, calls, typing })]));
	const endState: Record<string, EndState> = {};
	for (const [side, other] of [[a, b], [b, a]] as const) {
		const person = store.person(side.persona.id, CHANNEL_ID, other.persona.id);
		if (!person) continue;
		endState[side.persona.id] = { state: person.state, notes: person.summary, self: store.get(side.persona.id, 'selfNotes') ?? '', familiarity: person.familiarity, affinity: person.affinity, importance: person.importance };
	}
	const summary: RunSummary = { start: startAt, end, realMs: Date.now() - realStart, skippedMs: clock.skipped(), tokens, ended, live, model: live ? (settings.models.default.model ?? null) : null };

	// --- The review ------------------------------------------------------------------------------------------------
	let analysis: Analysis | undefined;
	let analysisProblem = setup.noReview;
	let analysisRaw: string | undefined;
	if (!setup.reviewer) analysisProblem ??= 'no reviewer';
	else if (sent.length < 2) analysisProblem = 'nothing to review: the other persona never answered';
	else {
		say('Reviewing...');
		const judge = llmsFor([{ id: 'reviewer', settings: setup.reviewer }], { dryRun: false, apiKeyOf, budget: service.text, rng }).get('reviewer')!;
		/** The system prompt each persona's model was last sent for a DM turn: the framework's instructions as they were. */
		const lastPrompt = (id: string) => calls.findLast((call) => call.persona === id && call.task === 'directMessage')?.messages[0]?.content ?? null;
		const review = {
			personas: sideInfo.map((side) => ({ ...side, lastSystemPrompt: lastPrompt(side.id) })),
			channel: scenario.where,
			scenario: scenario.name,
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
					{ role: 'system', content: setup.rubric },
					{ role: 'user', content: JSON.stringify(review, null, '\t') },
				],
				{ task: 'directMessage', json: true },
			);
			({ analysis, problem: analysisProblem } = parseAnalysis(analysisRaw));
		} catch (error) {
			analysisProblem = `the review failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	// --- The results -----------------------------------------------------------------------------------------------
	const transcript = transcriptMarkdown(sideInfo, sent, summary);
	writeFileSync(join(dir, 'transcript.md'), transcript);
	writeFileSync(join(dir, 'report.md'), reportMarkdown({ sides: sideInfo, run: summary, sent, metrics, endState, analysis, analysisProblem, transcript }));
	writeFileSync(join(dir, 'events.jsonl'), events.map((event) => `${JSON.stringify({ ...event, at: new Date(event.at).toISOString() })}\n`).join(''));
	// Every prompt and answer, to trace an issue to what the model was told
	writeFileSync(join(dir, 'calls.jsonl'), calls.map((call) => `${JSON.stringify(call)}\n`).join(''));
	writeFileSync(
		join(dir, 'run.json'),
		JSON.stringify({ scenario, run, summary, personas: sideInfo, transcript: sent, metrics, endState, analysis: analysis ?? null, analysisProblem: analysisProblem ?? null, analysisRaw: analysisRaw ?? null }, null, '\t'),
	);
	db.close();

	const broken = [
		...personas.flatMap((persona) => (metrics[persona.id]!.events.gaveUp ? [`${persona.name} gave up on a reply`] : [])),
		...(sent.every((message) => message.from === a.persona.id) ? [`${b.persona.name} never answered`] : []),
	];
	say(`${sent.length} messages, ${duration(end - startAt)} of persona time in ${duration(summary.realMs)}; ended: ${ended}.${analysis ? ` Review: ${analysis.overall}/5.` : ''}\n`);
	return { scenario: scenario.name, run, dir, personas: sideInfo, summary, messages: sent.length, metrics, ...(analysis && { analysis }), ...(analysisProblem && { analysisProblem }), broken };
}

/** Reads a file at `path` from the repository's root. */
export const reader = (root: string) => (path: string) => readFileSync(resolve(root, path), 'utf8');
