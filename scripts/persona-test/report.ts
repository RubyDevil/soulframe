/**
 * What a persona test measured and how it reads: the metrics taken from the transcript and the runtime's events, the
 * model's review parsed, and the Markdown written for people (the transcript and the report).
 */
import { z } from 'zod';

/** A message one persona sent the other, as it went out. */
export interface Sent {
	from: string;
	text: string;
	at: number;
}

/** A runtime log line, with the time it was logged. */
export interface LoggedEvent {
	at: number;
	persona: string;
	event: string;
	detail: Record<string, unknown>;
}

/** One call to the model, timed in real time. */
export interface ModelCall {
	persona: string;
	task: string;
	ms: number;
	error?: string;
}

/** A side of the conversation as the report shows it. */
export interface Side {
	id: string;
	name: string;
	timezone: string;
	prompt: string;
}

/** What each persona kept about the other, and about itself, by the end. */
export interface EndState {
	state: string;
	notes: string;
	self: string;
	familiarity: number;
	affinity: number;
	importance: number;
}

const SCORE = z.object({ score: z.number().min(1).max(5), why: z.string() });

/** The review the model answers (scripts/persona-test/analysis.md). */
export const AnalysisSchema = z.object({
	summary: z.string(),
	overall: z.number().min(1).max(5),
	scores: z.record(z.string(), SCORE),
	issues: z
		.array(
			z.object({
				severity: z.enum(['high', 'medium', 'low']).catch('medium'),
				persona: z.string().default('both'),
				what: z.string(),
				evidence: z.string().default(''),
				suggestion: z.string().default(''),
			}),
		)
		.default([]),
	highlights: z.array(z.string()).default([]),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

/** The review in a model's answer: its JSON object, even inside a code fence or after a sentence; else why not. */
export function parseAnalysis(text: string): { analysis?: Analysis; problem?: string } {
	const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		return { problem: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = AnalysisSchema.safeParse(value);
	if (!parsed.success) return { problem: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ') };
	return { analysis: parsed.data };
}

/** A duration as people read it: "0.4s", "42s", "4m 31s", "1h 42m", "2d 3h". */
export function duration(ms: number): string {
	if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h ${m % 60}m`;
	return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The value at fraction `q` of sorted `values` (nearest rank), or null for none. */
const quantile = (values: readonly number[], q: number) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
};

/** Consecutive messages of one sender: a turn, and how long after the other's last message it began. */
export interface TurnOf {
	from: string;
	messages: Sent[];
	/** Since the other's last message; null for the first turn (the opener). */
	gap: number | null;
}

export function turnsOf(sent: readonly Sent[]): TurnOf[] {
	const turns: TurnOf[] = [];
	for (const message of sent) {
		const last = turns.at(-1);
		if (last?.from === message.from) last.messages.push(message);
		else turns.push({ from: message.from, messages: [message], gap: last ? message.at - last.messages.at(-1)!.at : null });
	}
	return turns;
}

/** Events that say something about how a persona behaved, by name in the report. */
const COUNTED = {
	leftOnRead: 'reply_skipped',
	restarts: 'reply_restarted',
	interruptions: 'away',
	waitedForHours: 'reply_waiting',
	failedTurns: 'reply_failed',
	gaveUp: 'reply_given_up',
	failedDeliveries: 'delivery_failed',
} as const;

export interface PersonaMetrics {
	messages: number;
	turns: number;
	messagesPerTurn: number;
	averageChars: number;
	/** How long it took to answer the other's last message: median, 90th percentile and longest, in ms. */
	replyGap: { median: number | null; p90: number | null; max: number | null };
	/** Time spent with the typing indicator on, in ms. */
	typingMs: number;
	events: Record<keyof typeof COUNTED, number>;
	model: { calls: number; failed: number; averageMs: number | null; maxMs: number | null };
}

/** The numbers of one persona's side of the run. */
export function metricsOf(id: string, { sent, events, calls, typing }: { sent: readonly Sent[]; events: readonly LoggedEvent[]; calls: readonly ModelCall[]; typing: readonly { persona: string; on: boolean; at: number }[] }): PersonaMetrics {
	const mine = sent.filter((message) => message.from === id);
	const turns = turnsOf(sent).filter((turn) => turn.from === id);
	const gaps = turns.flatMap((turn) => (turn.gap === null ? [] : [turn.gap]));
	const ownCalls = calls.filter((call) => call.persona === id);
	const okCalls = ownCalls.filter((call) => call.error === undefined);
	let typingMs = 0;
	let since: number | null = null;
	for (const { on, at } of typing.filter((entry) => entry.persona === id)) {
		if (on && since === null) since = at;
		else if (!on && since !== null) {
			typingMs += at - since;
			since = null;
		}
	}
	return {
		messages: mine.length,
		turns: turns.length,
		messagesPerTurn: turns.length ? Number((mine.length / turns.length).toFixed(2)) : 0,
		averageChars: mine.length ? Math.round(mine.reduce((sum, message) => sum + message.text.length, 0) / mine.length) : 0,
		replyGap: { median: quantile(gaps, 0.5), p90: quantile(gaps, 0.9), max: quantile(gaps, 1) },
		typingMs,
		events: Object.fromEntries(Object.entries(COUNTED).map(([key, event]) => [key, events.filter((entry) => entry.persona === id && entry.event === event).length])) as PersonaMetrics['events'],
		model: {
			calls: ownCalls.length,
			failed: ownCalls.length - okCalls.length,
			averageMs: okCalls.length ? Math.round(okCalls.reduce((sum, call) => sum + call.ms, 0) / okCalls.length) : null,
			maxMs: quantile(okCalls.map((call) => call.ms), 1),
		},
	};
}

/** The run as a whole: what it covered, how long it took, and why it ended. */
export interface RunSummary {
	start: number;
	end: number;
	realMs: number;
	skippedMs: number;
	tokens: number;
	ended: string;
	live: boolean;
	model: string | null;
}

/** Text for one cell of a Markdown table. */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** Time of day in UTC, with the date when it is not that of `previous`. */
const utcStamp = (at: number, previous?: number) => {
	const iso = new Date(at).toISOString();
	const sameDay = previous !== undefined && new Date(previous).toISOString().slice(0, 10) === iso.slice(0, 10);
	return sameDay ? iso.slice(11, 19) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
};

/** A local time for a persona: weekday, date and time in its own zone. */
export const localTime = (at: number, timezone: string) =>
	new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);

const headline = (sides: readonly Side[], run: RunSummary, messages: number) =>
	`${messages} messages over ${duration(run.end - run.start)} of persona time, run in ${duration(run.realMs)} (${duration(run.skippedMs)} of waiting skipped)` +
	` · started ${utcStamp(run.start)} UTC (${sides.map((side) => `${localTime(run.start, side.timezone)} for ${side.name}`).join(', ')}) · ended: ${run.ended}`;

/** The conversation as people read it: each message with its time and the wait before it. */
export function transcriptMarkdown(sides: readonly Side[], sent: readonly Sent[], run: RunSummary): string {
	const nameOf = new Map(sides.map((side) => [side.id, side.name]));
	const lines = [`# ${sides.map((side) => side.name).join(' and ')}`, '', headline(sides, run, sent.length), ''];
	for (const [i, message] of sent.entries()) {
		const before = sent[i - 1];
		const gap = before ? ` (+${duration(message.at - before.at)})` : '';
		lines.push(`**${utcStamp(message.at, before?.at)}**${gap} **${nameOf.get(message.from) ?? message.from}:** ${message.text.replace(/\r?\n/g, ' ')}`, '');
	}
	return lines.join('\n');
}

const gapText = (gap: PersonaMetrics['replyGap']) => (gap.median === null ? 'n/a' : `${duration(gap.median)} / ${duration(gap.p90!)} / ${duration(gap.max!)}`);

/** The report: the model's review (when there is one), the metrics side by side, and what each kept about the other. */
export function reportMarkdown({
	sides,
	run,
	sent,
	metrics,
	endState,
	analysis,
	analysisProblem,
	transcript,
}: {
	sides: readonly Side[];
	run: RunSummary;
	sent: readonly Sent[];
	metrics: Readonly<Record<string, PersonaMetrics>>;
	endState: Readonly<Record<string, EndState>>;
	analysis?: Analysis;
	analysisProblem?: string;
	transcript: string;
}): string {
	const [a, b] = sides as [Side, Side];
	const lines: string[] = [`# Persona test: ${a.name} and ${b.name}`, ''];
	lines.push(headline(sides, run, sent.length), '');
	lines.push(run.live ? `Live model: \`${run.model ?? 'from the settings'}\` · ${run.tokens.toLocaleString('en-US')} tokens` : 'Canned model: no network, no review.', '');
	if (analysis) {
		lines.push(`> ${cell(analysis.summary)}`, '', `**Overall: ${analysis.overall}/5**`, '', '## Scores', '', '| Aspect | Score | Why |', '| --- | --- | --- |');
		for (const [aspect, { score, why }] of Object.entries(analysis.scores)) lines.push(`| ${cell(aspect)} | ${score}/5 | ${cell(why)} |`);
		lines.push('', '## Issues', '');
		if (analysis.issues.length) {
			lines.push('| Severity | Persona | What | Evidence | Suggestion |', '| --- | --- | --- | --- | --- |');
			for (const issue of analysis.issues) lines.push(`| ${issue.severity} | ${cell(issue.persona)} | ${cell(issue.what)} | ${issue.evidence ? `"${cell(issue.evidence)}"` : ''} | ${cell(issue.suggestion)} |`);
		} else lines.push('None found.');
		if (analysis.highlights.length) lines.push('', '## Highlights', '', ...analysis.highlights.map((highlight) => `- ${highlight.replace(/\r?\n/g, ' ')}`));
		lines.push('');
	} else if (analysisProblem) lines.push(`**No review:** ${cell(analysisProblem)}`, '');
	const row = (label: string, value: (m: PersonaMetrics) => string) => `| ${label} | ${value(metrics[a.id]!)} | ${value(metrics[b.id]!)} |`;
	lines.push(
		'## Metrics',
		'',
		`| | ${a.name} | ${b.name} |`,
		'| --- | --- | --- |',
		row('Messages', (m) => String(m.messages)),
		row('Turns', (m) => String(m.turns)),
		row('Messages per turn', (m) => String(m.messagesPerTurn)),
		row('Average length (characters)', (m) => String(m.averageChars)),
		row('Reply gap (median / p90 / longest)', (m) => gapText(m.replyGap)),
		row('Typing time', (m) => duration(m.typingMs)),
		row('Left on read', (m) => String(m.events.leftOnRead)),
		row('Drafts started over', (m) => String(m.events.restarts)),
		row('Interruptions', (m) => String(m.events.interruptions)),
		row('Waited for its hours', (m) => String(m.events.waitedForHours)),
		row('Model calls (average / longest)', (m) => `${m.model.calls} (${m.model.averageMs === null ? 'n/a' : `${duration(m.model.averageMs)} / ${duration(m.model.maxMs!)}`})`),
		row('Failed model calls / turns given up', (m) => `${m.model.failed} / ${m.events.gaveUp}`),
		row('Failed deliveries', (m) => String(m.events.failedDeliveries)),
		'',
		'## What each kept by the end',
		'',
	);
	for (const [side, other] of [[a, b], [b, a]] as const) {
		const state = endState[side.id];
		if (!state) continue;
		lines.push(
			`### ${side.name} about ${other.name}`,
			'',
			`State ${state.state} · familiarity ${state.familiarity.toFixed(2)} · affinity ${state.affinity.toFixed(2)} · importance ${state.importance}`,
			'',
			state.notes ? `> ${state.notes.replace(/\r?\n/g, '\n> ')}` : '_No notes._',
			'',
			`### ${side.name} about itself`,
			'',
			state.self ? `> ${state.self.replace(/\r?\n/g, '\n> ')}` : '_No notes._',
			'',
		);
	}
	lines.push('<details><summary>Transcript</summary>', '', transcript.replace(/^# .*\n/, ''), '</details>', '');
	return lines.join('\n');
}
