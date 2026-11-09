import { postModelJson, type TokenMeter } from './llm.js';
import { between, type Rng } from './rng.js';
import type { ServiceSettings } from './settings.js';

/**
 * The Decisions API (OpenAI's by default): a classifier that answers typed questions (yes/no, or a level on a
 * scale) with probabilities, and writes no text. The questions themselves are model text, so they
 * are in `prompts.ts`; this file only sends them and reads the answers.
 *
 * The service settings' `decisions` is the client's only configuration (one client for every persona), and this file
 * its only client (every check and the group-chat gate): nothing here reads `settings.models`. Which checks a brain
 * asks, and their thresholds, are that brain's `Settings.decisions` (brain.ts).
 *
 * It only ever adds strictness to the code's own checks (`safety.ts`): `ask` never throws, and every
 * failure, timeout, refusal or unreadable answer comes back as "no signal", which leaves the path exactly
 * as it is without it.
 */

type DecisionsSettings = ServiceSettings['decisions'];

/** A question as the API takes it; every text in it comes from prompts.ts. */
export type Question =
	| { type: 'predicate'; name: string; instructions: string }
	| { type: 'score'; name: string; instructions: string; levels: { label: string; description: string }[] };

/** One answer, normalised: a score's `probabilities` keyed by level label. */
export type Answer =
	| { type: 'predicate'; name: string; probability: number }
	| { type: 'score'; name: string; score: number; probabilities: Record<string, number>; confidence: number | null }
	/** Refused by the model, or this one answer was missing or unreadable: no signal. */
	| { type: 'refusal'; name: string; reason: string };

export type Answers = Map<string, Answer>;

/** What a request is for (logs only). */
export type DecisionsUse = 'dmCheck' | 'groupChatGate' | 'groupChatLine';

export interface DecisionsContext {
	use: DecisionsUse;
	personaId: string;
}

/**
 * A fast classifier (OpenAI's Decisions API) whose answers only ever add strictness to the code's own checks.
 * `ask` never throws: `null` means no answer (disabled, over its daily cap, failed, timed out, unreadable).
 */
export interface Decisions {
	readonly enabled: boolean;
	ask(input: string, questions: readonly Question[], context: DecisionsContext): Promise<Answers | null>;
}

/** The whole response could not be read (it is then treated as no answer at all). */
export class DecisionsParseError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * A score's probabilities, given as an array of `{ value?, label?, probability }` or as an object
 * `{ key: probability }` (sources disagree on the shape), keyed by level label. `null` when anything in it
 * is unreadable.
 */
function readProbabilities(raw: unknown, question: Extract<Question, { type: 'score' }>): Record<string, number> | null {
	// A level may be named by its label or by its 0-based index
	const keyOf = (key: unknown): string | null => {
		const index = typeof key === 'number' ? key : typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : null;
		if (index !== null) return question.levels[index]?.label ?? null;
		return typeof key === 'string' ? key : null;
	};
	const out: Record<string, number> = {};
	if (Array.isArray(raw)) {
		for (const item of raw) {
			if (!isObject(item) || !isProbability(item.probability)) return null;
			const key = typeof item.label === 'string' ? item.label : keyOf(item.value);
			if (key === null) return null;
			out[key] = item.probability;
		}
		return out;
	}
	if (isObject(raw)) {
		for (const [rawKey, probability] of Object.entries(raw)) {
			const key = keyOf(rawKey);
			if (key === null || !isProbability(probability)) return null;
			out[key] = probability;
		}
		return out;
	}
	return null;
}

/** One answer checked against its question; `null` when it does not fit. */
function readAnswer(raw: Record<string, unknown>, question: Question): Answer | null {
	const { name } = question;
	switch (question.type) {
		case 'predicate':
			return isProbability(raw.probability) ? { type: 'predicate', name, probability: raw.probability } : null;
		case 'score': {
			const probabilities = readProbabilities(raw.probabilities, question);
			const score = raw.score;
			if (!probabilities || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > question.levels.length - 1) return null;
			const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence) ? raw.confidence : null;
			return { type: 'score', name, score, probabilities, confidence };
		}
	}
}

/**
 * The response read leniently, one answer per question (matched by name, or by position when an answer
 * has no name). A bad or missing answer becomes a refusal for that question only; a body that is not a
 * response at all throws `DecisionsParseError`.
 */
export function parseAnswers(body: unknown, questions: readonly Question[]): Answers {
	if (!isObject(body) || !Array.isArray(body.answers)) throw new DecisionsParseError('The response holds no answers');
	const answers: unknown[] = body.answers;
	const result: Answers = new Map();
	questions.forEach((question, i) => {
		const { name } = question;
		const byName = answers.find((a) => isObject(a) && a.name === name);
		const atIndex = answers[i];
		const raw = byName ?? (isObject(atIndex) && atIndex.name === undefined ? atIndex : undefined);
		if (!isObject(raw)) return result.set(name, { type: 'refusal', name, reason: 'missing' });
		if (raw.type === 'refusal') {
			const reason = [raw.reason, raw.refusal, raw.message].find((r): r is string => typeof r === 'string') ?? 'refused';
			return result.set(name, { type: 'refusal', name, reason });
		}
		const answer = raw.type === question.type ? readAnswer(raw, question) : null;
		result.set(name, answer ?? { type: 'refusal', name, reason: 'unparseable' });
	});
	return result;
}

/** A predicate's probability; null for a refusal, a missing answer, the wrong type, or `answers === null`. */
export function probabilityOf(answers: Answers | null, name: string): number | null {
	const answer = answers?.get(name);
	return answer?.type === 'predicate' ? answer.probability : null;
}

/** A score's value (0-based level index, may be fractional); null as above. */
export function scoreOf(answers: Answers | null, name: string): number | null {
	const answer = answers?.get(name);
	return answer?.type === 'score' ? answer.score : null;
}

/** No checks at all: the default, and what runs while the service settings' `decisions.enabled` is off. */
export const DISABLED_DECISIONS: Decisions = { enabled: false, ask: async () => null };

/**
 * For tests and nothing else.
 * - `answer(question, input, context)` gives a predicate's probability or a score's value, or `null` for a refusal.
 * - A throw makes the whole call fail, so `ask` returns null.
 * - Every call is recorded in `calls`.
 */
export function createScriptedDecisions(
	answer: (question: Question, input: string, context: DecisionsContext) => number | null,
): Decisions & { calls: { context: DecisionsContext; input: string; names: string[] }[] } {
	const calls: { context: DecisionsContext; input: string; names: string[] }[] = [];
	return {
		enabled: true,
		calls,
		async ask(input, questions, context) {
			calls.push({ context, input, names: questions.map((q) => q.name) });
			try {
				const answers: Answers = new Map();
				for (const question of questions) {
					const { name } = question;
					const value = answer(question, input, context);
					if (value === null) answers.set(name, { type: 'refusal', name, reason: 'scripted' });
					else if (question.type === 'predicate') answers.set(name, { type: 'predicate', name, probability: value });
					else answers.set(name, { type: 'score', name, score: value, probabilities: {}, confidence: null });
				}
				return answers;
			} catch {
				return null;
			}
		},
	};
}

/** The client of the service settings' `decisions`: `DISABLED_DECISIONS` while it is off, so nothing is ever sent then. */
export function createConfiguredDecisions({
	settings,
	apiKeyOf,
	meter,
	log = () => undefined,
	rng = Math.random,
	now = Date.now,
}: {
	settings: DecisionsSettings;
	/** Reads a key from the environment by the variable's name. */
	apiKeyOf: (envName: string) => string;
	/** Its own meter (key prefix 'decisionTokens'), never the generative one. */
	meter?: TokenMeter;
	log?: (persona: string, event: string, detail?: Record<string, unknown>) => void;
	rng?: Rng;
	/** The clock of the day it logs a spent budget on: the runtime's (`runtime.now`), as its meter's should be. */
	now?: () => number;
}): Decisions {
	if (!settings.enabled) return DISABLED_DECISIONS;
	// The UTC day the spent budget was last logged, so it is logged once a day
	let budgetLoggedOn = '';
	return {
		enabled: true,
		async ask(input, questions, { use, personaId }) {
			if (meter?.exceeded()) {
				const day = new Date(now()).toISOString().slice(0, 10);
				if (budgetLoggedOn !== day) {
					budgetLoggedOn = day;
					log(personaId, 'decisions_budget_spent', { use });
				}
				return null;
			}
			try {
				// No key variable, no authentication (a gateway or a local mock), as for text generation
				const apiKey = settings.apiKeyEnv ? apiKeyOf(settings.apiKeyEnv) : '';
				const body = await postModelJson(`${settings.baseUrl.replace(/\/+$/, '')}/decisions`, apiKey,
					{ model: settings.model, input, questions }, settings.timeoutSeconds * 1000, () => between(rng, 300, 1_000), 'Decisions',
				) as { usage?: { input_tokens?: number; total_tokens?: number } } | null;
				// Only input tokens are charged; a response without usage is counted at about four characters a token
				const usage = body?.usage;
				meter?.add(usage?.input_tokens ?? usage?.total_tokens ?? Math.ceil((JSON.stringify(input).length + JSON.stringify(questions).length) / 4));
				const answers = parseAnswers(body, questions);
				for (const answer of answers.values()) {
					if (answer.type === 'refusal') log(personaId, 'decisions_refused', { use, name: answer.name, reason: answer.reason });
				}
				return answers;
			} catch (error) {
				// Never the message text: only what failed
				log(personaId, 'decisions_failed', { use, error: String(error) });
				return null;
			}
		},
	};
}
