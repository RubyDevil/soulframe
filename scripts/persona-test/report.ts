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

/** Where an issue's fix belongs, as the rubric names them (analysis.md), and `unsorted` for an answer that named none of them. */
export const AREAS = ['persona', 'framework', 'pacing', 'memory', 'model', 'unsorted'] as const;
export type Area = (typeof AREAS)[number];

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
				/** Where its fix belongs (analysis.md); one the reviewer left out or made up is unsorted. */
				area: z.enum(AREAS).catch('unsorted'),
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
			lines.push('| Severity | Area | Persona | What | Evidence | Suggestion |', '| --- | --- | --- | --- | --- | --- |');
			for (const issue of analysis.issues) lines.push(`| ${issue.severity} | ${issue.area} | ${cell(issue.persona)} | ${cell(issue.what)} | ${issue.evidence ? `"${cell(issue.evidence)}"` : ''} | ${cell(issue.suggestion)} |`);
		} else lines.push('None found.');
		if (analysis.highlights.length) lines.push('', '## Highlights', '', ...analysis.highlights.map((highlight) => `- ${highlight.replace(/\r?\n/g, ' ')}`));
		lines.push('');
	} else if (analysisProblem) lines.push(`**No review:** ${cell(analysisProblem)}`, '');
	const row = (label: string, value: (m: PersonaMetrics) => string) => `| ${label} | ${value(metrics[a.id]!)} | ${value(metrics[b.id]!)} |`;
	lines.push(
		'## Metrics',
		'',
		'Every prompt and answer of the run is in `calls.jsonl`, to trace an issue to what the model was told.',
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

// --- A suite: every conversation of a run, and how it compares with a baseline ----------------------------------------

/** One conversation as the suite's summary keeps it: enough to compare two runs, without the transcripts. */
export interface SummaryRun {
	scenario: string;
	run: number;
	/** Its folder, from the summary's. */
	dir: string;
	messages: number;
	personaMs: number;
	realMs: number;
	tokens: number;
	overall: number | null;
	scores: Record<string, number>;
	issues: (Analysis['issues'][number] & { scenario: string; run: number })[];
	analysisProblem: string | null;
	broken: string[];
}

/** What `summary.json` holds: a run of the suite, to read back as a later run's baseline (`--baseline`). */
export interface SuiteSummary {
	version: 1;
	createdAt: string;
	/** The commit it ran on, when known: what a comparison is about. */
	commit: string | null;
	model: string | null;
	reviewer: string | null;
	runs: SummaryRun[];
}

/** Mean, lowest and highest of `values`, or null for none. */
const spread = (values: readonly number[]) =>
	values.length ? { mean: values.reduce((sum, value) => sum + value, 0) / values.length, min: Math.min(...values), max: Math.max(...values), n: values.length } : null;

type Spread = NonNullable<ReturnType<typeof spread>>;

/** By scenario (and `*` for all of them), the spread of the overall score and of each aspect over the reviewed runs. */
export function aggregate(summary: SuiteSummary) {
	const groups = new Map<string, SummaryRun[]>();
	for (const run of summary.runs) groups.set(run.scenario, [...(groups.get(run.scenario) ?? []), run]);
	groups.set('*', summary.runs);
	const aspects = [...new Set(summary.runs.flatMap((run) => Object.keys(run.scores)))];
	return {
		aspects,
		groups: new Map(
			[...groups].map(([name, runs]) => [
				name,
				{
					runs: runs.length,
					overall: spread(runs.flatMap((run) => (run.overall === null ? [] : [run.overall]))),
					scores: Object.fromEntries(aspects.map((aspect) => [aspect, spread(runs.flatMap((run) => (aspect in run.scores ? [run.scores[aspect]!] : [])))])) as Record<string, Spread | null>,
				},
			]),
		),
	};
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * The suite's summary: by scenario, the mean score (lowest to highest) over its runs, each with its change since the
 * baseline when given; the issues by where their fix belongs; and every conversation, linked to its report.
 */
export function summaryMarkdown(summary: SuiteSummary, baseline?: SuiteSummary): string {
	const now = aggregate(summary);
	const before = baseline ? aggregate(baseline) : undefined;
	const delta = (value: Spread | null | undefined, then: Spread | null | undefined) => {
		if (!value || !then) return '';
		const change = value.mean - then.mean;
		return Math.abs(change) < 0.05 ? ' (=)' : ` (${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)})`;
	};
	const shown = (value: Spread | null | undefined, then?: Spread | null) =>
		value ? `${value.mean.toFixed(1)}${value.min !== value.max ? ` (${value.min}–${value.max})` : ''}${delta(value, then)}` : '–';
	const reviewed = summary.runs.filter((run) => run.overall !== null).length;
	const lines = [
		'# Persona test',
		'',
		`${summary.runs.length} conversations (${reviewed} reviewed) · commit ${summary.commit ?? 'unknown'} · model ${summary.model ?? 'canned'} · reviewer ${summary.reviewer ?? 'none'}`,
		'',
	];
	if (baseline) lines.push(`Compared with the baseline of commit ${baseline.commit ?? 'unknown'} (${baseline.createdAt.slice(0, 16).replace('T', ' ')} UTC, ${baseline.runs.length} conversations): changes of the mean in brackets.`, '');
	if (reviewed) {
		lines.push(
			'Scores are means over the reviewed runs (lowest–highest); a review varies from run to run, so read a change of a few tenths over a few runs as noise.',
			'',
			`| Scenario | Overall | ${now.aspects.join(' | ')} |`,
			`| --- | --- | ${now.aspects.map(() => '---').join(' | ')} |`,
		);
		for (const [name, group] of now.groups) {
			const then = before?.groups.get(name);
			lines.push(`| ${name === '*' ? '**all**' : cell(name)} | ${shown(group.overall, then?.overall)} | ${now.aspects.map((aspect) => shown(group.scores[aspect], then?.scores[aspect])).join(' | ')} |`);
		}
		lines.push('');
	}
	const issues = summary.runs.flatMap((run) => run.issues);
	if (issues.length) {
		lines.push('## Issues by area', '', 'Where each fix belongs, as the reviewer saw it: `framework` is soulframe\'s prompts and code, `persona` the persona files.', '', '| Area | High | Medium | Low |', '| --- | --- | --- | --- |');
		const byArea = AREAS.map((area) => ({ area, issues: issues.filter((issue) => issue.area === area) })).filter((entry) => entry.issues.length);
		for (const { area, issues: found } of byArea) lines.push(`| ${area} | ${(['high', 'medium', 'low'] as const).map((severity) => found.filter((issue) => issue.severity === severity).length).join(' | ')} |`);
		lines.push('');
		for (const { area, issues: found } of byArea) {
			lines.push(`### ${area}`, '');
			for (const issue of [...found].sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity])) {
				lines.push(`- **${issue.severity}** (${cell(issue.scenario)} #${issue.run}, ${cell(issue.persona)}) ${issue.what.replace(/\r?\n/g, ' ')}${issue.evidence ? ` — "${issue.evidence.replace(/\r?\n/g, ' ')}"` : ''}${issue.suggestion ? ` → ${issue.suggestion.replace(/\r?\n/g, ' ')}` : ''}`);
			}
			lines.push('');
		}
	}
	const broken = summary.runs.filter((run) => run.broken.length);
	if (broken.length) lines.push('## Broken runs', '', ...broken.map((run) => `- ${run.scenario} #${run.run}: ${run.broken.join('; ')}`), '');
	lines.push('## Conversations', '', '| Scenario | Run | Messages | Persona time | Real time | Tokens | Overall | Report |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const run of summary.runs) {
		lines.push(`| ${cell(run.scenario)} | ${run.run} | ${run.messages} | ${duration(run.personaMs)} | ${duration(run.realMs)} | ${run.tokens.toLocaleString('en-US')} | ${run.overall ?? (run.analysisProblem ? cell(run.analysisProblem) : '–')} | [report](${run.dir}/report.md) |`);
	}
	lines.push('');
	return lines.join('\n');
}
