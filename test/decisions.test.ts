import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredDecisions, DISABLED_DECISIONS, parseAnswers, probabilityOf, scoreOf, DecisionsParseError, type Question } from '../src/decisions.js';
import { createTokenMeter } from '../src/llm.js';
import { SettingsSchema } from '../src/settings.js';
import { memoryStore } from './fixtures.js';

const predicate: Question = { type: 'predicate', name: 'p', instructions: 'P?' };
const score: Question = {
	type: 'score',
	name: 's',
	instructions: 'S?',
	levels: [
		{ label: 'low', description: 'L' },
		{ label: 'mid', description: 'M' },
		{ label: 'high', description: 'H' },
	],
};
const QUESTIONS = [predicate, score];

const DAY = Date.UTC(2026, 9, 14, 12);
const respond = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const good = {
	answers: [
		{ type: 'predicate', name: 'p', probability: 0.7 },
		{ type: 'score', name: 's', score: 1.4, probabilities: [{ value: 0, label: 'low', probability: 0.1 }, { value: 1, label: 'mid', probability: 0.4 }, { value: 2, label: 'high', probability: 0.5 }], confidence: 0.5 },
	],
	usage: { input_tokens: 321, output_tokens: 3, total_tokens: 324 },
};

const setUp = ({ dailyTokens = 0, baseUrl = 'https://api.openai.com/v1/', apiKeyEnv = 'OPENAI_API_KEY', apiKeyOf = (name: string) => `key-of-${name}` } = {}) => {
	const store = memoryStore();
	const settings = SettingsSchema.parse({ decisions: { enabled: true, baseUrl, apiKeyEnv, dailyTokens } }).decisions;
	const meter = createTokenMeter(store, dailyTokens, () => DAY, 'decisionTokens');
	const logs: { persona: string; event: string; detail?: Record<string, unknown> }[] = [];
	const decisions = createConfiguredDecisions({ settings, apiKeyOf, meter, log: (persona, event, detail) => logs.push({ persona, event, detail }), rng: () => 0 });
	return { store, meter, logs, decisions };
};
const context = { use: 'dmCheck' as const, personaId: 'robin' };

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('createConfiguredDecisions', () => {
	it('posts the model, the input and the questions to {baseUrl}/decisions with the key', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(good));
		const { decisions } = setUp();
		const answers = await decisions.ask('hello', QUESTIONS, context);
		const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('https://api.openai.com/v1/decisions');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer key-of-OPENAI_API_KEY');
		expect(JSON.parse(String(init.body))).toEqual({ model: 'gpt-6-luna', input: 'hello', questions: QUESTIONS });
		expect(probabilityOf(answers, 'p')).toBe(0.7);
		expect(scoreOf(answers, 's')).toBe(1.4);
		// Given up after timeoutSeconds
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it('sends no key with an empty apiKeyEnv, to any URL (a gateway or a local mock)', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(good));
		const apiKeyOf = vi.fn((name: string) => `key-of-${name}`);
		const { decisions } = setUp({ baseUrl: 'http://localhost:8080/v1', apiKeyEnv: '', apiKeyOf });
		expect(probabilityOf(await decisions.ask('hello', QUESTIONS, context), 'p')).toBe(0.7);
		const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
		expect(url).toBe('http://localhost:8080/v1/decisions');
		expect(init.headers).not.toHaveProperty('authorization');
		expect(apiKeyOf).not.toHaveBeenCalled();
	});

	it('counts input tokens on its own meter, never the model\'s', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(good));
		const { decisions, store } = setUp();
		await decisions.ask('hello', QUESTIONS, context);
		expect(store.get('*', 'decisionTokens:2026-10-14')).toBe('321');
		expect(store.get('*', 'tokens:2026-10-14')).toBeNull();
	});

	it('counts total tokens without input tokens, and estimates them without usage', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ answers: good.answers, usage: { total_tokens: 50 } }));
		const total = setUp();
		await total.decisions.ask('hello', QUESTIONS, context);
		expect(total.store.get('*', 'decisionTokens:2026-10-14')).toBe('50');

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ answers: good.answers }));
		const estimated = setUp();
		await estimated.decisions.ask('hello', QUESTIONS, context);
		expect(Number(estimated.store.get('*', 'decisionTokens:2026-10-14'))).toBeGreaterThan(0);
	});

	it('past its daily cap: no request, no answer, logged once a day, nothing thrown', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(good));
		const { decisions, meter, logs } = setUp({ dailyTokens: 100 });
		meter.add(100);
		expect(await decisions.ask('a', QUESTIONS, context)).toBeNull();
		expect(await decisions.ask('b', QUESTIONS, context)).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
		expect(logs.filter((l) => l.event === 'decisions_budget_spent')).toHaveLength(1);
	});

	it('logs a spent cap once per day of its own clock', async () => {
		let at = DAY;
		const settings = SettingsSchema.parse({ decisions: { enabled: true, dailyTokens: 100 } }).decisions;
		const meter = createTokenMeter(memoryStore(), 100, () => at, 'decisionTokens');
		const logged: string[] = [];
		const decisions = createConfiguredDecisions({ settings, apiKeyOf: () => 'key', meter, log: (_persona, event) => logged.push(event), now: () => at });
		for (const day of [0, 0, 1, 1]) {
			at = DAY + day * 24 * 60 * 60_000;
			meter.add(100);
			expect(await decisions.ask('a', QUESTIONS, context)).toBeNull();
		}
		expect(logged).toEqual(['decisions_budget_spent', 'decisions_budget_spent']);
	});

	it('retries once after a server error', async () => {
		vi.useFakeTimers();
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(respond('busy', 503)).mockResolvedValueOnce(respond(good));
		const { decisions } = setUp();
		const result = decisions.ask('hello', QUESTIONS, context);
		await vi.runAllTimersAsync();
		expect(probabilityOf(await result, 'p')).toBe(0.7);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('retries once after a network failure', async () => {
		vi.useFakeTimers();
		const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(respond(good));
		const { decisions } = setUp();
		const result = decisions.ask('hello', QUESTIONS, context);
		await vi.runAllTimersAsync();
		expect(probabilityOf(await result, 'p')).toBe(0.7);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('does not retry an error that would happen again', async () => {
		for (const status of [400, 401]) {
			const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('no', status));
			const { decisions, logs } = setUp();
			expect(await decisions.ask('hello', QUESTIONS, context)).toBeNull();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(logs.at(-1)?.event).toBe('decisions_failed');
			vi.restoreAllMocks();
		}
	});

	it('gives no answer after two server errors, or two timeouts', async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => respond('down', 500));
		const { decisions, logs } = setUp();
		let result = decisions.ask('hello', QUESTIONS, context);
		await vi.runAllTimersAsync();
		expect(await result).toBeNull();
		expect(logs.at(-1)?.event).toBe('decisions_failed');

		const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
		result = decisions.ask('hello', QUESTIONS, context);
		await vi.runAllTimersAsync();
		expect(await result).toBeNull();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it('gives no answer when the key is missing, or the body is not a response', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(good));
		const noKey = setUp({ apiKeyOf: () => { throw new Error('not set'); } });
		expect(await noKey.decisions.ask('hello', QUESTIONS, context)).toBeNull();

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ result: 'yes' }));
		const { decisions, logs } = setUp();
		expect(await decisions.ask('hello', QUESTIONS, context)).toBeNull();
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond('not json'));
		expect(await decisions.ask('hello', QUESTIONS, context)).toBeNull();
		expect(logs.map((l) => l.event)).toEqual(['decisions_failed', 'decisions_failed']);
		// Never the text it was asked about
		expect(JSON.stringify(logs)).not.toContain('hello');
	});

	it('logs a refusal by name, and keeps the other answers', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ answers: [{ type: 'refusal', name: 'p', refusal: 'policy' }, good.answers[1]] }));
		const { decisions, logs } = setUp();
		const answers = await decisions.ask('hello', QUESTIONS, context);
		expect(probabilityOf(answers, 'p')).toBeNull();
		expect(scoreOf(answers, 's')).toBe(1.4);
		expect(logs).toEqual([{ persona: 'robin', event: 'decisions_refused', detail: { use: 'dmCheck', name: 'p', reason: 'policy' } }]);
	});

	it('the disabled client never answers', async () => {
		expect(DISABLED_DECISIONS.enabled).toBe(false);
		expect(await DISABLED_DECISIONS.ask('hello', QUESTIONS, context)).toBeNull();
	});
});

describe('parseAnswers', () => {
	it('reads probabilities given as an array or as an object, the same way', () => {
		const asArray = parseAnswers(good, QUESTIONS);
		const asObject = parseAnswers(
			{
				answers: [
					good.answers[0],
					{ type: 'score', name: 's', score: 1.4, probabilities: { low: 0.1, mid: 0.4, high: 0.5 }, confidence: 0.5 },
				],
			},
			QUESTIONS,
		);
		expect(asObject).toEqual(asArray);
		expect(asArray.get('s')).toEqual({ type: 'score', name: 's', score: 1.4, probabilities: { low: 0.1, mid: 0.4, high: 0.5 }, confidence: 0.5 });
	});

	it('maps score levels given by index to their labels', () => {
		const byIndex = parseAnswers({ answers: [{ type: 'score', name: 's', score: 2, probabilities: [{ value: 0, probability: 0.2 }, { value: 2, probability: 0.8 }] }] }, [score]);
		expect(byIndex.get('s')).toMatchObject({ probabilities: { low: 0.2, high: 0.8 }, confidence: null });
		const byKey = parseAnswers({ answers: [{ type: 'score', name: 's', score: 0.5, probabilities: { 0: 0.5, 1: 0.5 } }] }, [score]);
		expect(byKey.get('s')).toMatchObject({ score: 0.5, probabilities: { low: 0.5, mid: 0.5 } });
	});

	it.each([
		['the wrong type', { type: 'score', name: 'p', score: 1, probabilities: {} }, predicate],
		['a probability above 1', { type: 'predicate', name: 'p', probability: 1.3 }, predicate],
		['a score past the last level', { type: 'score', name: 's', score: 2.5, probabilities: { high: 1 } }, score],
	])('makes %s a refusal, not an answer', (_what, answer, question) => {
		const answers = parseAnswers({ answers: [answer] }, [question]);
		expect(answers.get(question.name)).toEqual({ type: 'refusal', name: question.name, reason: 'unparseable' });
		expect(probabilityOf(answers, question.name)).toBeNull();
		expect(scoreOf(answers, question.name)).toBeNull();
	});

	it('makes a missing answer a refusal, and matches an unnamed one by position', () => {
		const answers = parseAnswers({ answers: [{ type: 'predicate', probability: 0.4 }] }, [predicate, score]);
		expect(probabilityOf(answers, 'p')).toBe(0.4);
		expect(answers.get('s')).toEqual({ type: 'refusal', name: 's', reason: 'missing' });
	});

	it('throws on a body that is not a response', () => {
		expect(() => parseAnswers({ answer: [] }, QUESTIONS)).toThrow(DecisionsParseError);
		expect(() => parseAnswers(null, QUESTIONS)).toThrow(DecisionsParseError);
	});

	it('gives no signal for no answers at all', () => {
		expect(probabilityOf(null, 'p')).toBeNull();
		expect(scoreOf(null, 's')).toBeNull();
	});
});
