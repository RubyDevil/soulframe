import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCannedLlm, createConfiguredLlm, createTokenMeter, LlmBudgetError, llmsFor, ModelNotConfiguredError, modelKeys, providerSet, ProviderUnavailableError } from '../src/llm.js';
import { DEFAULT_SERVICE_SETTINGS, DEFAULT_SETTINGS, ServiceSettingsSchema, SettingsSchema } from '../src/settings.js';
import { memoryStore } from './fixtures.js';

const answer = (content: string, totalTokens?: number) =>
	new Response(JSON.stringify({ choices: [{ message: { content } }], ...(totalTokens !== undefined && { usage: { total_tokens: totalTokens } }) }), { status: 200 });

const settings = SettingsSchema.parse({
	models: {
		default: { baseUrl: 'https://llm.example/v1/', model: 'mid-model', jsonMode: true },
		groupChat: { model: 'cheap-model', maxTokens: 50 },
		post: { baseUrl: 'https://other.example/v1', apiKeyEnv: 'OTHER_KEY', model: 'post-model' },
		vision: { model: 'eyes-model' },
	},
});

const setUp = (dailyLimit: number) => {
	const store = memoryStore();
	const meter = createTokenMeter(store, dailyLimit, () => Date.UTC(2026, 9, 14, 12));
	const llm = createConfiguredLlm({ settings, apiKeyOf: (name) => `key-of-${name}`, meter, rng: () => 0 });
	return { store, meter, llm };
};

const sent = (fetch: { mock: { calls: unknown[][] } }, index = 0) => {
	const [url, init] = fetch.mock.calls[index] as [string, RequestInit];
	return { url, body: JSON.parse(String(init.body)) as Record<string, unknown>, headers: init.headers as Record<string, string> };
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('images (models.vision)', () => {
	const look = { role: 'user' as const, content: 'what is this?', images: ['https://cdn.example/p.jpg'] };

	it('sends them as content parts after the text, and plain messages as they were', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"seen":"a cat"}', 10));
		const { llm } = setUp(0);
		await llm.complete([look, { role: 'user', content: 'plain' }], { task: 'vision', json: true });
		expect(sent(fetch).body.messages).toEqual([
			{ role: 'user', content: [{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: 'https://cdn.example/p.jpg' } }] },
			{ role: 'user', content: 'plain' },
		]);
		expect(sent(fetch).body).toMatchObject({ max_tokens: 200, temperature: 0.2 });
	});

	it("doesn't count an image's bytes as tokens at a provider that reports no usage", async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"seen":"a cat"}'));
		const { llm, meter } = setUp(0);
		await llm.complete([{ ...look, images: [`data:image/png;base64,${'A'.repeat(4_000_000)}`] }], { task: 'vision', json: true });
		expect(meter.spent()).toBeLessThan(1_000);
		expect(meter.spent()).toBeGreaterThan(800);
	});

	it("spends what is kept for DMs, where the other tasks can't", async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 1));
		const { llm, meter } = setUp(100);
		meter.add(80);
		await expect(llm.complete([look], { task: 'vision' })).resolves.toBe('ok');
		await expect(llm.complete([{ role: 'user', content: 'x' }], { task: 'post' })).rejects.toBeInstanceOf(LlmBudgetError);
	});

	it('is no text provider and needs no key while off', () => {
		const onlyVision = SettingsSchema.parse({ models: { vision: { baseUrl: 'https://eyes.example/v1', apiKeyEnv: 'EYES_KEY' } } });
		expect(providerSet(onlyVision)).toBe(false);
		expect(modelKeys(onlyVision).has('EYES_KEY')).toBe(false);
		expect(modelKeys(SettingsSchema.parse({ models: { vision: { model: 'eyes', baseUrl: 'https://eyes.example/v1', apiKeyEnv: 'EYES_KEY' } } })).get('EYES_KEY')).toBe('models.vision.apiKeyEnv');
	});

	it('is answered by the canned model too, as a description', async () => {
		const raw = await createCannedLlm(() => 0).complete([look], { task: 'vision', json: true });
		expect(JSON.parse(raw)).toHaveProperty('seen');
	});
});

describe('createConfiguredLlm', () => {
	it('counts the tokens the provider reports, and asks for JSON when told to', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"reply":"hi"}', 120));
		const { llm, meter } = setUp(0);
		expect(await llm.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage', json: true })).toBe('{"reply":"hi"}');
		expect(meter.spent()).toBe(120);
		const { url, body } = sent(fetch);
		expect(url).toBe('https://llm.example/v1/chat/completions');
		expect(body).toMatchObject({ model: 'mid-model', max_tokens: 400, response_format: { type: 'json_object' } });
	});

	it('uses OpenAI completion limits without sampling overrides for GPT-5', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('{"status":"ok"}', 10));
		const llm = createConfiguredLlm({
			settings: SettingsSchema.parse({ models: { default: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini-2026-03-17', jsonMode: true } } }),
			apiKeyOf: () => 'test-key',
		});
		await llm.complete([{ role: 'user', content: 'Return JSON' }], { task: 'directMessage', json: true });
		const { body } = sent(fetch);
		expect(body).toMatchObject({ max_completion_tokens: 400, response_format: { type: 'json_object' } });
		expect(body).not.toHaveProperty('max_tokens');
		expect(body).not.toHaveProperty('temperature');
	});

	it('uses each task\'s own model, and its own provider when it names one', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 1));
		const { llm } = setUp(0);
		await llm.complete([{ role: 'user', content: 'hey' }], { task: 'groupChat' });
		await llm.complete([{ role: 'user', content: 'hey' }], { task: 'post' });
		expect(sent(fetch, 0).body).toMatchObject({ model: 'cheap-model', max_tokens: 50 });
		expect(sent(fetch, 0).headers.authorization).toBe('Bearer key-of-LLM_API_KEY');
		expect(sent(fetch, 1).url).toBe('https://other.example/v1/chat/completions');
		expect(sent(fetch, 1).body).toMatchObject({ model: 'post-model' });
		expect(sent(fetch, 1).headers.authorization).toBe('Bearer key-of-OTHER_KEY');
	});

	it.each(['directMessage', 'groupChat', 'post', 'initiative'] as const)('uses a keyless local model for %s, and never the Decisions client', async (task) => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(answer('local reply', 5));
		const apiKeyOf = vi.fn(() => 'openai-key');
		const llm = createConfiguredLlm({ settings: SettingsSchema.parse({ models: { default: { baseUrl: 'http://localhost:11434/v1/', model: 'llama3.2', apiKeyEnv: '' } } }), apiKeyOf });
		expect(await llm.complete([{ role: 'user', content: 'Hello' }], { task, json: true })).toBe('local reply');
		expect(apiKeyOf).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sent(fetch).url).toBe('http://localhost:11434/v1/chat/completions');
		expect(sent(fetch).body).toMatchObject({ model: 'llama3.2', max_tokens: expect.any(Number), temperature: expect.any(Number) });
		expect(sent(fetch).body).not.toHaveProperty('response_format');
		expect(sent(fetch).headers).not.toHaveProperty('authorization');
	});

	it("inherits default.jsonMode only on the default provider; a task on its own provider sets its own", async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('{"reply":"hi"}', 1));
		const llm = createConfiguredLlm({
			settings: SettingsSchema.parse({
				models: {
					default: { baseUrl: 'https://llm.example/v1', model: 'mid-model', jsonMode: true },
					groupChat: { jsonMode: false },
					post: { baseUrl: 'https://other.example/v1', apiKeyEnv: 'OTHER_KEY', model: 'post-model', jsonMode: true },
				},
			}),
			apiKeyOf: () => 'key',
		});
		const json = { response_format: { type: 'json_object' } };
		// The setup's post model has its own provider and no jsonMode: default.jsonMode is not its provider's
		await setUp(0).llm.complete([], { task: 'post', json: true });
		expect(sent(fetch, 0).body).not.toHaveProperty('response_format');
		await llm.complete([], { task: 'directMessage', json: true });
		expect(sent(fetch, 1).body).toMatchObject(json);
		await llm.complete([], { task: 'groupChat', json: true });
		expect(sent(fetch, 2).body).not.toHaveProperty('response_format');
		await llm.complete([], { task: 'post', json: true });
		expect(sent(fetch, 3).url).toBe('https://other.example/v1/chat/completions');
		expect(sent(fetch, 3).body).toMatchObject(json);
		// Never without json asked
		await llm.complete([], { task: 'post' });
		expect(sent(fetch, 4).body).not.toHaveProperty('response_format');
	});

	it("gives up a request after the task's timeoutSeconds, else default.timeoutSeconds (60 by default)", async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 1));
		const timeout = vi.spyOn(AbortSignal, 'timeout');
		await setUp(0).llm.complete([], { task: 'directMessage' });
		expect(timeout).toHaveBeenLastCalledWith(60_000);
		const slow = createConfiguredLlm({ settings: SettingsSchema.parse({ models: { default: { baseUrl: 'https://llm.example/v1', model: 'm', timeoutSeconds: 120 }, post: { timeoutSeconds: 30 } } }), apiKeyOf: () => 'key' });
		await slow.complete([], { task: 'groupChat' });
		expect(timeout).toHaveBeenLastCalledWith(120_000);
		await slow.complete([], { task: 'post' });
		expect(timeout).toHaveBeenLastCalledWith(30_000);
		expect(SettingsSchema.safeParse({ models: { default: { timeoutSeconds: 1 } } }).success).toBe(false);
	});

	it("never sends the default provider's key, model or jsonMode to a task's own provider", async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('{"reply":"hi"}', 1));
		const apiKeyOf = vi.fn((name: string) => `key-of-${name}`);
		// Written by hand, as checkSettings would refuse it: its own provider, no key and no model named
		const leaky = SettingsSchema.parse({ models: { default: { baseUrl: 'https://llm.example/v1', model: 'mid-model', apiKeyEnv: 'MAIN_KEY', jsonMode: true }, groupChat: { baseUrl: 'https://other.example/v1' } } });
		const llm = createConfiguredLlm({ settings: leaky, apiKeyOf });
		await expect(llm.complete([], { task: 'groupChat' })).rejects.toBeInstanceOf(ModelNotConfiguredError);
		const named = SettingsSchema.parse({ models: { ...leaky.models, groupChat: { baseUrl: 'https://other.example/v1', model: 'other-model' } } });
		await expect(createConfiguredLlm({ settings: named, apiKeyOf }).complete([], { task: 'groupChat' })).rejects.toThrow("set models.groupChat.apiKeyEnv ('' for none)");
		expect(fetch).not.toHaveBeenCalled();
		expect(apiKeyOf).not.toHaveBeenCalled();
		// With its own key named, its request carries that key and no jsonMode
		const own = SettingsSchema.parse({ models: { ...leaky.models, groupChat: { baseUrl: 'https://other.example/v1', model: 'other-model', apiKeyEnv: 'OTHER_KEY' } } });
		await createConfiguredLlm({ settings: own, apiKeyOf }).complete([], { task: 'groupChat', json: true });
		expect(sent(fetch).headers.authorization).toBe('Bearer key-of-OTHER_KEY');
		expect(sent(fetch).body).toMatchObject({ model: 'other-model' });
		expect(sent(fetch).body).not.toHaveProperty('response_format');
		expect(apiKeyOf).not.toHaveBeenCalledWith('MAIN_KEY');
	});

	it('lets a task disable authentication on an otherwise authenticated provider', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer('ok'));
		const apiKeyOf = vi.fn(() => { throw new Error('Should not read a key'); });
		const llm = createConfiguredLlm({
			settings: SettingsSchema.parse({
				models: { default: { baseUrl: 'https://llm.example/v1', model: 'remote-model' }, groupChat: { baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', model: 'llama3.2' } },
			}),
			apiKeyOf,
		});
		await llm.complete([], { task: 'groupChat' });
		expect(sent(fetch).body.model).toBe('llama3.2');
		expect(sent(fetch).headers).not.toHaveProperty('authorization');
		expect(apiKeyOf).not.toHaveBeenCalled();
	});

	it('retries once after a rate limit', async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('slow down', { status: 429 }))
			.mockResolvedValueOnce(answer('ok', 10));
		const { llm } = setUp(0);
		const result = llm.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' });
		await vi.runAllTimersAsync();
		expect(await result).toBe('ok');
	});

	it('refuses to call the model once the day is spent', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 600));
		const { llm } = setUp(500);
		await llm.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' });
		await expect(llm.complete([{ role: 'user', content: 'again' }], { task: 'directMessage' })).rejects.toBeInstanceOf(LlmBudgetError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the budget.directMessageReserve (0.3) of the day for DMs: group chats and posts stop at 70%', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 1));
		const { llm, meter } = setUp(1000);
		meter.add(700);
		await expect(llm.complete([], { task: 'groupChat' })).rejects.toBeInstanceOf(LlmBudgetError);
		await expect(llm.complete([], { task: 'post' })).rejects.toBeInstanceOf(LlmBudgetError);
		expect(await llm.complete([], { task: 'directMessage' })).toBe('ok');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the DM reserve through a burst of group-chat lines waiting behind budget.concurrency (4) just under 70%', async () => {
		const answers: (() => void)[] = [];
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => answers.push(() => resolve(answer('{"reply": "hi all"}', 50)))));
		const { llm, meter } = setUp(1000);
		meter.add(690);
		const lines = Array.from({ length: 20 }, () => llm.complete([], { task: 'groupChat', json: true }).catch((error: unknown) => error));
		// Answered as they reach the provider
		let settled = false;
		void Promise.all(lines).then(() => (settled = true));
		while (!settled) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			for (const done of answers.splice(0)) done();
		}
		// Only the four in flight when 70% was crossed went on: each waiting one is checked once its turn comes
		expect(fetch).toHaveBeenCalledTimes(4);
		expect(meter.spent()).toBe(890);
		expect((await Promise.all(lines)).filter((line) => line instanceof LlmBudgetError)).toHaveLength(16);
	});

	it("rejects with ProviderUnavailableError when the retry fails too, with the provider's message", async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('overloaded', { status: 503 }));
		const result = setUp(0).llm.complete([], { task: 'directMessage' }).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await result;
		expect(error).toBeInstanceOf(ProviderUnavailableError);
		expect(error).toMatchObject({ message: 'LLM 503: overloaded' });
	});

	it('rejects with ProviderUnavailableError when the retry times out too', async () => {
		vi.useFakeTimers();
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
		const result = setUp(0).llm.complete([], { task: 'directMessage' }).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		expect(await result).toBeInstanceOf(ProviderUnavailableError);
		expect(await result).toMatchObject({ message: 'The operation was aborted due to timeout' });
	});

	it('rejects with a plain error on a spent quota (429 insufficient_quota): waiting would not mend it', async () => {
		vi.useFakeTimers();
		const message = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.';
		const body = JSON.stringify({ error: { message, type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }, null, 4);
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body, { status: 429 }));
		const result = setUp(0).llm.complete([], { task: 'directMessage' }).catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		const error = await result;
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ProviderUnavailableError);
		expect(error).toMatchObject({ message: expect.stringMatching(/^LLM 429: /) });
	});

	it('rejects with a plain error on a status not worth retrying', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad request', { status: 400 }));
		const error = await setUp(0).llm.complete([], { task: 'directMessage' }).catch((rejection: unknown) => rejection);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(ProviderUnavailableError);
		expect(error).toMatchObject({ message: 'LLM 400: bad request' });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('rejects with ModelNotConfiguredError, sending nothing, for a task with no provider or no model', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch');
		const postOnly = SettingsSchema.parse({ models: { post: { baseUrl: 'https://other.example/v1', apiKeyEnv: 'OTHER_KEY', model: 'post-model' } } });
		const noModel = SettingsSchema.parse({ models: { default: { baseUrl: 'https://llm.example/v1' } } });
		for (const unset of [postOnly, noModel]) {
			const llm = createConfiguredLlm({ settings: unset, apiKeyOf: () => 'key' });
			await expect(llm.complete([], { task: 'directMessage' })).rejects.toBeInstanceOf(ModelNotConfiguredError);
		}
		// vision never takes the default model, which may not take images
		const chatOnly = SettingsSchema.parse({ models: { default: { baseUrl: 'https://llm.example/v1', model: 'chat-model' } } });
		await expect(createConfiguredLlm({ settings: chatOnly, apiKeyOf: () => 'key' }).complete([], { task: 'vision' })).rejects.toBeInstanceOf(ModelNotConfiguredError);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('modelKeys', () => {
	it('names each key a task with a provider reads, once, with the setting naming it', () => {
		expect([...modelKeys(settings)]).toEqual([['LLM_API_KEY', 'models.default.apiKeyEnv'], ['OTHER_KEY', 'models.post.apiKeyEnv']]);
		expect(modelKeys(DEFAULT_SETTINGS).size).toBe(0);
	});
});

describe('providerSet', () => {
	it("is a text task's provider: default's, or one of its own, never vision's alone", () => {
		expect(providerSet(settings)).toBe(true);
		expect(providerSet(DEFAULT_SETTINGS)).toBe(false);
		expect(providerSet(SettingsSchema.parse({ models: { post: { baseUrl: 'https://other.example/v1', apiKeyEnv: '', model: 'p' } } }))).toBe(true);
		expect(providerSet(SettingsSchema.parse({ models: { vision: { baseUrl: 'https://eyes.example/v1', apiKeyEnv: '', model: 'eyes' } } }))).toBe(false);
	});
});

describe('SettingsSchema', () => {
	it('fills in every default, and keeps what is given', () => {
		const parsed = SettingsSchema.parse({ memory: { personNotes: 150 } });
		expect(parsed.memory).toEqual({ personNotes: 150, selfNotes: 800, historyMessages: 20, conversationGapHours: 6 });
		// The shipped levels unless replaced (prompts.ts)
		expect(parsed.relationship).toEqual({ familiarity: { growth: 0.012, fadeHalfLifeDays: 60 }, affinity: { enabled: true, step: 0.05, fadeHalfLifeDays: 0 }, hysteresis: 0.05 });
		expect(parsed.pacing.priority).toEqual({ weighted: true, agingMinutes: 2, importanceHalfLifeMinutes: 30 });
		expect(parsed.decisions.importance).toEqual({ enabled: true });
		expect(parsed.context).toEqual({ situation: true, upcoming: true, awayContext: true, relationship: true, timeSince: true });
		expect(parsed.pacing.watching).toEqual({ halfLifeSeconds: 90, chatHalfLifeSeconds: 90, medianSeconds: 4, p90Seconds: 8, delaySeconds: [2, 20] });
		expect(parsed.pacing.glance).toEqual({ medianSeconds: 40, p90Seconds: 150, delaySeconds: [4, 900] });
		expect(parsed.pacing.interruptions).toEqual({ meanMinutes: 40, minutes: { range: [2, 8], shape: 'lognormal' }, holdAtImportance: 2, calmMinutes: 5 });
		expect(parsed.pacing.returnOnlineReplyDelayMinutes).toEqual({ range: [0, 0], shape: 'lognormal' });
		expect(parsed.pacing.backlogGapSeconds).toEqual({ range: [30, 150], shape: 'lognormal' });
		expect(parsed.models.directMessage.maxTokens).toBe(400);
		expect(parsed.models.default).toEqual({ apiKeyEnv: 'LLM_API_KEY', jsonMode: false, timeoutSeconds: 60 });
		expect(DEFAULT_SERVICE_SETTINGS.text).toEqual({ dailyTokens: 200_000, directMessageReserve: 0.3, concurrency: 4 });
	});
	it('refuses a range that runs backwards', () => {
		expect(() => SettingsSchema.parse({ retries: { delayMinutes: [4, 1] } })).toThrow();
	});
	it('rejects obsolete or misspelled pacing settings', () => {
		expect(() => SettingsSchema.parse({ pacing: { quickShare: 1 } })).toThrow();
		// The per-message delay rolls are gone: watching, glance and interruptions time a reply now
		for (const key of ['quickReplyChance', 'slowReplyChance', 'quickReplyDelaySeconds', 'slowReplyDelaySeconds', 'busyReplyDelaySeconds']) {
			expect(() => SettingsSchema.parse({ pacing: { [key]: key.endsWith('Chance') ? 0.5 : [4, 15] } })).toThrow();
		}
		expect(() => SettingsSchema.parse({ pacing: { glance: { meanSeconds: 60 } } })).toThrow();
	});
	it('keeps the typed checks off unless turned on, and their minor tiers in order', () => {
		expect(DEFAULT_SERVICE_SETTINGS.decisions.enabled).toBe(false);
		expect(DEFAULT_SETTINGS.decisions.minor).toEqual({ enabled: true, denyAt: 0.9, cautionAt: 0.5, groupChats: true });
		expect(() => SettingsSchema.parse({ decisions: { minor: { cautionAt: 0.95, denyAt: 0.9 } } })).toThrow();
		expect(() => SettingsSchema.parse({ decisions: { minor: { denyAt: 0.3, cautionAt: 0.2 } } })).toThrow();
	});
	it.each(['https://gateway.example/v1', 'http://localhost:8080/v1'])('accepts any URL for the Decisions API: %s', (baseUrl) => {
		expect(ServiceSettingsSchema.parse({ decisions: { baseUrl } }).decisions.baseUrl).toBe(baseUrl);
	});
	it('refuses a Decisions baseUrl that is not a URL, and has no Decisions entry among the text models', () => {
		expect(ServiceSettingsSchema.safeParse({ decisions: { baseUrl: 'not a URL' } }).success).toBe(false);
		expect(Object.keys(DEFAULT_SETTINGS.models)).toEqual(['default', 'directMessage', 'groupChat', 'post', 'vision', 'initiative']);
	});
});

describe('createTokenMeter', () => {
	it('counts by UTC day', () => {
		const store = memoryStore();
		let now = Date.UTC(2026, 9, 14, 23, 59);
		const meter = createTokenMeter(store, 100, () => now);
		meter.add(100);
		expect(meter.exceeded()).toBe(true);
		now = Date.UTC(2026, 9, 15, 0, 1);
		expect(meter.exceeded()).toBe(false);
	});
	it('keeps counts with different prefixes apart', () => {
		const store = memoryStore();
		const tokens = createTokenMeter(store, 100, () => Date.UTC(2026, 9, 14));
		const decisionTokens = createTokenMeter(store, 100, () => Date.UTC(2026, 9, 14), 'decisionTokens');
		decisionTokens.add(100);
		expect(decisionTokens.exceeded()).toBe(true);
		expect(tokens.spent()).toBe(0);
		expect(tokens.exceeded()).toBe(false);
	});
});

describe('llmsFor', () => {
	const personas = [
		{ id: 'robin', settings: SettingsSchema.parse({ models: { default: { baseUrl: 'https://llm.example/v1', model: 'mini' }, directMessage: { model: 'robin-model' } } }) },
		{ id: 'sky', settings: SettingsSchema.parse({ models: { default: { baseUrl: 'https://llm.example/v1', model: 'mini' } } }) },
	];

	it("gives each persona a client with its own models", async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 1));
		const llms = llmsFor(personas, { dryRun: false, budget: DEFAULT_SERVICE_SETTINGS.text, apiKeyOf: (name) => `key-of-${name}`, rng: () => 0 });
		await llms.get('robin')!.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' });
		await llms.get('sky')!.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' });
		expect([sent(fetch, 0).body.model, sent(fetch, 1).body.model]).toEqual(['robin-model', 'mini']);
	});

	it('refuses a persona without a provider, naming it, except in a dry run (canned lines, no request)', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch');
		const all = [...personas, { id: 'jo', settings: DEFAULT_SETTINGS }];
		expect(() => llmsFor(all, { dryRun: false, budget: DEFAULT_SERVICE_SETTINGS.text, apiKeyOf: () => 'key' })).toThrow('no provider for: jo');
		const llms = llmsFor(all, { dryRun: true, budget: DEFAULT_SERVICE_SETTINGS.text, apiKeyOf: () => 'key', rng: () => 0 });
		expect(JSON.parse(await llms.get('jo')!.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' }))).toMatchObject({ action: 'none' });
		expect(fetch).not.toHaveBeenCalled();
	});
	it('gives canned lines to a persona in `keyless`, without a request', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => answer('ok', 1));
		const llms = llmsFor(personas, { dryRun: true, budget: DEFAULT_SERVICE_SETTINGS.text, apiKeyOf: () => 'key', keyless: new Set(['sky']), rng: () => 0 });
		expect(JSON.parse(await llms.get('sky')!.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' }))).toMatchObject({ action: 'none' });
		expect(fetch).not.toHaveBeenCalled();
		expect(await llms.get('robin')!.complete([{ role: 'user', content: 'hey' }], { task: 'directMessage' })).toBe('ok');
	});

	it('keeps `budget.concurrency` requests in flight at most, for every persona together', async () => {
		const answers: (() => void)[] = [];
		const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => answers.push(() => resolve(answer('ok', 1)))));
		const llms = llmsFor(personas, { dryRun: false, budget: DEFAULT_SERVICE_SETTINGS.text, apiKeyOf: () => 'key', rng: () => 0 });
		const calls = ['robin', 'robin', 'robin', 'sky', 'sky'].map((id) => llms.get(id)!.complete([], { task: 'directMessage' }));
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
		// The fifth waits for a place
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(fetch).toHaveBeenCalledTimes(4);
		answers[0]!();
		await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
		for (const done of answers.slice(1)) done();
		expect(await Promise.all(calls)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
	});

	it('does not mistake the Decisions API for a text provider', () => {
		const settings = SettingsSchema.parse({ decisions: { stop: { at: 0.95 } } });
		expect(() => llmsFor([{ id: 'jo', settings }], { dryRun: false, budget: DEFAULT_SERVICE_SETTINGS.text, apiKeyOf: () => 'key' })).toThrow('no provider for: jo');
	});
});
