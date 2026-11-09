/**
 * The persona test, for improving the personas and the framework: two personas talk to each other through their real
 * brains and reply queues, on a live model, at the pace the settings give (seconds to minutes between messages,
 * their hours, their interruptions), then a model reviews each conversation. The queues run on a step clock
 * (`createStepClock`): every wait is skipped, while every timestamp is what it would have been live, from the real
 * time on. A suite of scenarios, each run several times, gives scores to compare with a baseline run.
 *
 *   npx tsx scripts/persona-test/run.ts --help
 *
 * See docs/testing.md ("Two personas, live").
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { z } from 'zod';
import { isPlainObject, modelKeys, parseServiceSettings, parseSettings, type Settings } from 'soulframe';
import { converse, reader, SetupError, type ConversationResult, type Scenario, type Setup, type StartRule } from './conversation.js';
import { summaryMarkdown, type SuiteSummary } from './report.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const HELP = `Two personas talk to each other on a live model, their waits skipped, then a model reviews it.

  npx tsx scripts/persona-test/run.ts [options]

What to run
  --suite <file.yaml>    run its scenarios (scripts/persona-test/suite.yaml is the default suite); without it,
                         one scenario from the options below
  --only <names>         only these scenarios of the suite, comma-separated
  --runs <n>             run each scenario n times (default 1): the scores are averaged
  --baseline <path>      compare with an earlier run: its summary.json, or the folder holding it

One scenario (each also overrides the suite's, but --opener, --start and --where)
  --a <file.md>          the persona who opens (default examples/personas/robin.md)
  --b <file.md>          the other persona (default examples/personas/noa.md)
  --opener <text>        the first message, from --a (default "hey! how's your day going?")
  --start <when>         online (default: both online, 45 min or more left), closing (one of them has 15 to 30
                         min left), away (--a online, --b not), now, or an ISO time
  --messages <n>         stop after n messages, the opener included (default 30)
  --hours <h>            stop after h hours of persona time (default 24)
  --where <text>         the channel, as the brain is told it (default "a private chat app")
  --adult                mark the channel 18+ (the minors safeguard runs on every message)
  --identity <text>      the app's phrase after each persona's name in its identity line (default none)

Models (OpenAI-compatible)
  --settings <file.yaml> the brains' settings (models, pacing, memory...); default every default
  --service <file.yaml>  the service settings (budget, Decisions client); default no token limit
  --base-url <url>       models.default.baseUrl (or LLM_BASE_URL)
  --model <name>         models.default.model (or LLM_MODEL)
  --judge-model <name>   the reviewer's model (or LLM_JUDGE_MODEL; default the personas')
                         The key is read from models.default.apiKeyEnv: LLM_API_KEY by default.
  --canned               no network: canned lines and no review (a smoke test of the harness)

Output
  --out <dir>            where to write the results (default persona-test-results/<time>)
  --no-review            skip the reviews
  --min-score <n>        exit 1 when the mean overall score is under n (1 to 5)
  --quiet                print only the summary
`;

const { values: args } = parseArgs({
	options: {
		suite: { type: 'string' },
		only: { type: 'string' },
		runs: { type: 'string', default: '1' },
		baseline: { type: 'string' },
		a: { type: 'string' },
		b: { type: 'string' },
		opener: { type: 'string' },
		start: { type: 'string' },
		messages: { type: 'string' },
		hours: { type: 'string' },
		where: { type: 'string' },
		adult: { type: 'boolean' },
		identity: { type: 'string' },
		settings: { type: 'string' },
		service: { type: 'string' },
		'base-url': { type: 'string' },
		model: { type: 'string' },
		'judge-model': { type: 'string' },
		canned: { type: 'boolean', default: false },
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

/** Stops with a message: a problem of the setup, not of a conversation. */
function fail(message: string): never {
	console.error(`persona-test: ${message}`);
	process.exit(2);
}

/** A number of at least `min` from an option. */
const numberOf = (name: string, text: string, min: number) => {
	const value = Number(text);
	if (!Number.isFinite(value) || value < min) fail(`--${name} must be a number of at least ${min} (got ${JSON.stringify(text)})`);
	return value;
};

const read = reader(ROOT);
const readYaml = (path: string): Record<string, unknown> => {
	let value: unknown;
	try {
		value = parse(read(path)) ?? {};
	} catch (error) {
		fail(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isPlainObject(value)) fail(`${path}: must be a mapping`);
	return value;
};

const live = !args.canned;
const runs = numberOf('runs', args.runs, 1);
const minScore = args['min-score'] ? numberOf('min-score', args['min-score'], 1) : undefined;
const baseUrl = args['base-url'] ?? (process.env.LLM_BASE_URL || undefined);
const model = args.model ?? (process.env.LLM_MODEL || undefined);
const judgeModel = args['judge-model'] ?? (process.env.LLM_JUDGE_MODEL || undefined);
const apiKeyOf = (name: string) => process.env[name] ?? '';

// --- Settings ------------------------------------------------------------------------------------------------------

/** The settings as written, with --base-url and --model over models.default. */
const rawSettings = args.settings ? readYaml(args.settings) : {};
const rawModels = isPlainObject(rawSettings.models) ? rawSettings.models : {};
const personaModels = { ...rawModels, default: { ...(isPlainObject(rawModels.default) ? rawModels.default : {}), ...(baseUrl && { baseUrl }), ...(model && { model }) } };
const settingsOf = (raw: unknown, source: string): Settings => {
	const { settings, issues } = parseSettings(raw, { source });
	if (!settings) fail(`the settings have problems:\n  ${issues.join('\n  ')}`);
	return settings;
};
const settings = settingsOf(live ? { ...rawSettings, models: personaModels } : rawSettings, args.settings ?? 'settings');

// Without a service file, no daily limit: a test run should not wait for tomorrow's budget
const { service, issues: serviceIssues } = parseServiceSettings(args.service ? readYaml(args.service) : { text: { dailyTokens: 0 } }, { source: args.service ?? 'service settings' });
if (!service) fail(`the service settings have problems:\n  ${serviceIssues.join('\n  ')}`);

if (live) {
	const resolved = settings.models.default;
	if (!resolved.baseUrl || !resolved.model) fail('no model: set LLM_BASE_URL and LLM_MODEL (or --base-url, --model, or models.default in --settings), or run with --canned');
	const missing = [...modelKeys(settings).keys()].filter((name) => !process.env[name]);
	if (missing.length) fail(`no API key: set ${missing.join(', ')} (models.default.apiKeyEnv names the variable; '' for none)`);
}

// The reviewer: the personas' provider, its own model when given, room for a long answer and a long transcript
const reviewed = live && !args['no-review'];
const reviewer = reviewed
	? settingsOf(
			{
				...rawSettings,
				models: {
					...personaModels,
					directMessage: { ...(isPlainObject(rawModels.directMessage) ? rawModels.directMessage : {}), ...(judgeModel && { model: judgeModel }), maxTokens: 4000, temperature: 0.2, timeoutSeconds: 300 },
				},
			},
			'the reviewer settings',
		)
	: undefined;

// --- Scenarios -----------------------------------------------------------------------------------------------------

const START = z.union([z.enum(['now', 'online', 'closing', 'away']), z.string().refine((text) => !Number.isNaN(Date.parse(text)), 'an ISO time, or now, online, closing or away')]);
const ScenarioSchema = z
	.object({
		name: z.string().regex(/^[a-z0-9-]{1,40}$/, 'a-z, 0-9 and -: it names the scenario\'s folder'),
		a: z.string().optional(),
		b: z.string().optional(),
		/** null: no first message; nobody writes until one texts first (settings.initiative on). */
		opener: z.string().min(1).nullable().optional(),
		start: START.optional(),
		messages: z.number().int().min(2).optional(),
		hours: z.number().min(0.1).optional(),
		where: z.string().min(1).optional(),
		adult: z.boolean().optional(),
		/** Settings for both brains over the run's (texting first, say), checked as a brain's settings are. */
		settings: z.record(z.string(), z.unknown()).optional(),
		/** What the two had before: an earlier conversation, how well they know each other, what each noted. */
		past: z
			.object({
				daysAgo: z.number().min(0),
				familiarity: z.number().min(0).max(1).default(0.5),
				affinity: z.number().min(-1).max(1).default(0.3),
				conversations: z.number().int().min(1).default(3),
				notes: z.object({ a: z.string().optional(), b: z.string().optional() }).strict().default({}),
				messages: z.array(z.union([z.object({ a: z.string().min(1) }).strict(), z.object({ b: z.string().min(1) }).strict()])).min(1),
			})
			.strict()
			.optional(),
	})
	.strict();

/** `over` written key by key over `base`: a mapping merged, anything else replacing. */
const deepMerge = (base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(
		[...new Set([...Object.keys(base), ...Object.keys(over)])].map((key) => {
			const [a, b] = [base[key], over[key]];
			return [key, isPlainObject(a) && isPlainObject(b) ? deepMerge(a, b) : key in over ? b : a];
		}),
	);
const SuiteSchema = z.object({ scenarios: z.array(ScenarioSchema).min(1) }).strict();

const startRule = (text: string): StartRule => (['now', 'online', 'closing', 'away'].includes(text) ? (text as StartRule) : Date.parse(text));
const asWritten = (() => {
	if (!args.suite) return [{ name: 'conversation' }];
	const parsed = SuiteSchema.safeParse(readYaml(args.suite));
	if (!parsed.success) fail(`${args.suite}:\n  ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n  ')}`);
	const names = parsed.data.scenarios.map((scenario) => scenario.name);
	if (new Set(names).size !== names.length) fail(`${args.suite}: two scenarios have the same name`);
	const only = args.only?.split(',').map((name) => name.trim()).filter(Boolean);
	const unknown = only?.filter((name) => !names.includes(name)) ?? [];
	if (unknown.length) fail(`--only: no scenario ${unknown.join(', ')} in ${args.suite} (${names.join(', ')})`);
	return parsed.data.scenarios.filter((scenario) => !only || only.includes(scenario.name));
})();
if (args.start !== undefined && !START.safeParse(args.start).success) fail(`--start must be now, online, closing, away or an ISO time (got ${JSON.stringify(args.start)})`);

// The options override the suite where they make sense for every scenario (the personas, the limits, the channel's 18+ mark)
const scenarios: Scenario[] = asWritten.map((scenario) => ({
	name: scenario.name,
	a: args.a ?? scenario.a ?? 'examples/personas/robin.md',
	b: args.b ?? scenario.b ?? 'examples/personas/noa.md',
	opener: args.suite && scenario.opener !== undefined ? scenario.opener : (args.opener ?? "hey! how's your day going?"),
	start: startRule((args.suite ? scenario.start : args.start) ?? args.start ?? 'online'),
	messages: args.messages ? numberOf('messages', args.messages, 2) : (scenario.messages ?? 30),
	hours: args.hours ? numberOf('hours', args.hours, 0.1) : (scenario.hours ?? 24),
	where: (args.suite ? scenario.where : args.where) ?? args.where ?? 'a private chat app',
	adult: args.adult ?? scenario.adult ?? false,
	settings: scenario.settings ? settingsOf(deepMerge(live ? { ...rawSettings, models: personaModels } : rawSettings, scenario.settings), `${args.suite} › ${scenario.name}.settings`) : settings,
	...(scenario.past && {
		past: { ...scenario.past, messages: scenario.past.messages.map((message) => ('a' in message ? { from: 'a' as const, text: message.a } : { from: 'b' as const, text: message.b })) },
	}),
}));

// --- The baseline --------------------------------------------------------------------------------------------------

const baseline = (() => {
	if (!args.baseline) return undefined;
	const path = resolve(args.baseline);
	const file = existsSync(path) && statSync(path).isDirectory() ? join(path, 'summary.json') : path;
	try {
		const value = JSON.parse(readFileSync(file, 'utf8')) as SuiteSummary;
		if (value.version !== 1 || !Array.isArray(value.runs)) fail(`${file}: not a persona test summary`);
		return value;
	} catch (error) {
		fail(`--baseline: can't read ${file} (${error instanceof Error ? error.message : String(error)})`);
	}
})();

// --- The runs ------------------------------------------------------------------------------------------------------

const createdAt = new Date();
const outDir = resolve(args.out ?? join(ROOT, 'persona-test-results', createdAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)));
const say = (line: string) => {
	if (!args.quiet) console.log(line);
};
const setup: Setup = {
	live,
	service,
	...(reviewer && { reviewer }),
	...(!reviewer && { noReview: live ? 'skipped (--no-review)' : 'a canned run is not reviewed' }),
	apiKeyOf,
	...(args.identity !== undefined && { identity: args.identity }),
	rubric: readFileSync(join(HERE, 'analysis.md'), 'utf8'),
	read,
	say,
};

const commit = (() => {
	if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
	try {
		return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
	} catch {
		return null;
	}
})();

say(`Persona test: ${scenarios.length} scenario${scenarios.length > 1 ? 's' : ''} × ${runs} run${runs > 1 ? 's' : ''}, ${live ? `live on ${settings.models.default.model}` : 'canned model'}; results in ${outDir}\n`);
const results: ConversationResult[] = [];
for (const scenario of scenarios) {
	for (let run = 1; run <= runs; run++) {
		// One scenario run once writes straight into --out, as a single conversation always did
		const dir = scenarios.length === 1 && runs === 1 ? outDir : join(outDir, scenario.name, String(run));
		mkdirSync(dir, { recursive: true });
		try {
			results.push(await converse(setup, scenario, { dir, run }));
		} catch (error) {
			if (error instanceof SetupError) fail(error.message);
			throw error;
		}
	}
}

// --- The summary ---------------------------------------------------------------------------------------------------

const summary: SuiteSummary = {
	version: 1,
	createdAt: createdAt.toISOString(),
	commit,
	model: live ? (settings.models.default.model ?? null) : null,
	reviewer: reviewer ? (reviewer.models.directMessage.model ?? reviewer.models.default.model ?? null) : null,
	runs: results.map((result) => ({
		scenario: result.scenario,
		run: result.run,
		dir: relative(outDir, result.dir) || '.',
		messages: result.messages,
		textedFirst: result.textedFirst,
		personaMs: result.summary.end - result.summary.start,
		realMs: result.summary.realMs,
		tokens: result.summary.tokens,
		overall: result.analysis?.overall ?? null,
		scores: Object.fromEntries(Object.entries(result.analysis?.scores ?? {}).map(([aspect, { score }]) => [aspect, score])),
		issues: (result.analysis?.issues ?? []).map((issue) => ({ ...issue, scenario: result.scenario, run: result.run })),
		analysisProblem: result.analysisProblem ?? null,
		broken: result.broken,
	})),
};
const summaryText = summaryMarkdown(summary, baseline);
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, '\t'));
writeFileSync(join(outDir, 'summary.md'), summaryText);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summaryText}\n`);

// --- How it went ---------------------------------------------------------------------------------------------------

const scored = summary.runs.flatMap((run) => (run.overall === null ? [] : [run.overall]));
const mean = scored.length ? scored.reduce((sum, value) => sum + value, 0) / scored.length : null;
const failures = [
	...summary.runs.flatMap((run) => run.broken.map((problem) => `${run.scenario} #${run.run}: ${problem}`)),
	...(minScore !== undefined && mean === null ? ['no review to hold to --min-score'] : []),
	...(minScore !== undefined && mean !== null && mean < minScore ? [`the mean overall score is ${mean.toFixed(2)}, under --min-score ${minScore}`] : []),
];
console.log(`${summary.runs.length} conversation${summary.runs.length === 1 ? "" : "s"}${mean !== null ? `, mean overall ${mean.toFixed(2)}/5 over ${scored.length} review${scored.length === 1 ? "" : "s"}` : ''}. Summary: ${join(outDir, 'summary.md')}`);
if (failures.length) {
	console.error(`\nFailed: ${failures.join('; ')}.`);
	process.exitCode = 1;
}
