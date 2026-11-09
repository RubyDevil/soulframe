import { POST_REQUEST } from './prompts.js';
import type { Rng } from './rng.js';
import { between, pick, sleep } from './rng.js';
import type { Settings } from './settings.js';
import type { Store } from './store.js';

export interface LlmMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
	/** Images for the model to look at with this message (URLs or `data:` URIs): only the `vision` task sends any. */
	images?: readonly string[];
}

/** The kinds of task, each with its own model settings (`settings.models`). */
export type LlmTask = keyof Settings['models'];

interface LlmOptions {
	task: LlmTask;
	/** The answer must be a JSON object (asked of the provider too when the task's jsonMode is on, see settings.ts). */
	json?: boolean;
}

/**
 * The model behind the personas, for text generation only (the Decisions API is decisions.ts). Any provider with
 * an OpenAI-compatible chat completions endpoint works; the provider and its model decide what content they allow.
 */
export interface Llm {
	complete(messages: LlmMessage[], options: LlmOptions): Promise<string>;
}

/** Thrown instead of calling the model once the day's tokens are spent. */
export class LlmBudgetError extends Error {
	constructor() {
		super("The model's daily token budget is spent");
	}
}

/** The provider failed its retry too (a timeout, a network error or a RETRYABLE status): down for now, worth waiting for. */
export class ProviderUnavailableError extends Error {}

/**
 * The task has no provider or no model to call (a config may leave a task it never uses without one): only a change
 * of the settings mends it, so trying again is no use.
 */
export class ModelNotConfiguredError extends Error {}

/**
 * Counts the tokens every persona spends (in the store, so a restart keeps the count) against a daily
 * limit, by UTC day. A limit of 0 means none. `prefix` keeps separate counts apart (the Decisions API's
 * checks count under 'decisionTokens', never against the model's budget).
 */
export function createTokenMeter(store: Store, dailyLimit: number, now: () => number = Date.now, prefix = 'tokens') {
	const key = () => `${prefix}:${new Date(now()).toISOString().slice(0, 10)}`;
	const spent = () => Number(store.get('*', key()) ?? 0);
	return {
		spent,
		/** Whether `share` of the day's limit is spent (all of it unless given). */
		exceeded: (share = 1) => dailyLimit > 0 && spent() >= dailyLimit * share,
		add(tokens: number) {
			store.set('*', key(), String(spent() + tokens));
		},
	};
}

export type TokenMeter = ReturnType<typeof createTokenMeter>;

/** A message as the provider takes it: its images, if any, as content parts after its text. */
const wireMessage = ({ role, content, images }: LlmMessage) =>
	images?.length ? { role, content: [{ type: 'text', text: content }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] } : { role, content };

/** Roughly what an image costs at a provider that reports no usage: its bytes would say nothing. */
const IMAGE_TOKENS = 800;

/** Statuses worth one more try: a timeout, a rate limit, a server error (here and in decisions.ts). */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * POSTs `body` and answers the JSON, retrying once after a timeout, a network error or a RETRYABLE status. Rejects with
 * ProviderUnavailableError when the retry fails that way too, else with a plain Error (a spent quota's 429 too).
 */
export async function postModelJson(url: string, apiKey: string, body: unknown, timeout: number, retryDelay: () => number, label: string): Promise<unknown> {
	const request = () => fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeout),
	});
	let response: Response;
	try {
		response = await request();
		if (RETRYABLE.has(response.status)) throw new Error(`${label} ${response.status}`);
	} catch {
		await sleep(retryDelay());
		try {
			response = await request();
		} catch (error) {
			throw new ProviderUnavailableError(error instanceof Error ? error.message : String(error), { cause: error });
		}
	}
	if (!response.ok) {
		const text = await response.text();
		const message = `${label} ${response.status}: ${text.slice(0, 300)}`;
		// A spent quota or an unpaid bill (OpenAI's 429 insufficient_quota) is no outage: waiting won't mend it
		throw RETRYABLE.has(response.status) && !text.includes('insufficient_quota') ? new ProviderUnavailableError(message) : new Error(message);
	}
	return response.json();
}

/** At most `size` calls in progress at once; the others wait their turn, in order. */
export function createLimiter(size: number) {
	let running = 0;
	const waiting: (() => void)[] = [];
	return async <T>(run: () => Promise<T>): Promise<T> => {
		if (running < size) running++;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await run();
		} finally {
			// The place passes straight to the next in line
			const next = waiting.shift();
			if (next) next();
			else running--;
		}
	};
}

type Limiter = ReturnType<typeof createLimiter>;

/** The variable holding a task's key: its own `apiKeyEnv`, else `llm.apiKeyEnv`; '' for none. */
export const keyEnvFor = (settings: Settings, task: LlmTask) => settings.models[task].apiKeyEnv ?? settings.llm.apiKeyEnv;

/** The key variables a persona's text model reads, each with the setting naming it: one per task with a provider, none for an empty key. */
export function modelKeys(settings: Settings): Map<string, string> {
	const keys = new Map<string, string>();
	for (const task of Object.keys(settings.models) as LlmTask[]) {
		// A task that is off needs no key
		if (task === 'vision' && !settings.models.vision.model) continue;
		const name = keyEnvFor(settings, task);
		if (!name || keys.has(name) || !(settings.models[task].baseUrl ?? settings.llm.baseUrl)) continue;
		keys.set(name, settings.models[task].apiKeyEnv === undefined ? 'settings.llm.apiKeyEnv' : `settings.models.${task}.apiKeyEnv`);
	}
	return keys;
}

/**
 * The configured text provider(s): each task uses its model from `settings.models`, falling back to
 * `settings.llm` for the provider, the key, the model name and (only with the provider) jsonMode. Past
 * `1 - llm.directMessageReserve` of the day's tokens, only direct messages are still generated.
 */
export function createConfiguredLlm({
	settings,
	apiKeyOf,
	meter,
	limit = createLimiter(settings.llm.concurrency),
	rng = Math.random,
}: {
	settings: Settings;
	/** Reads a key from the environment by the variable's name. */
	apiKeyOf: (envName: string) => string;
	meter?: TokenMeter;
	/** Shared by every persona's client (llmsFor): `llm.concurrency` requests in flight at most. */
	limit?: Limiter;
	rng?: Rng;
}): Llm {
	return {
		async complete(messages, { task, json = false }) {
			const taskModel = settings.models[task];
			const baseUrl = taskModel.baseUrl ?? settings.llm.baseUrl;
			const model = taskModel.model ?? settings.llm.model;
			if (!baseUrl || !model) throw new ModelNotConfiguredError(`No model set for ${task}: set settings.llm.baseUrl and a model`);
			const apiKeyEnv = keyEnvFor(settings, task);
			const apiKey = apiKeyEnv ? apiKeyOf(apiKeyEnv) : '';
			const openAi = new URL(baseUrl).hostname === 'api.openai.com';
			// llm.jsonMode is about llm's provider: a task on its own provider sets its own
			const jsonMode = taskModel.jsonMode ?? (taskModel.baseUrl ? false : settings.llm.jsonMode);
			// Checked and counted within its turn, so the calls waiting behind llm.concurrency never spend past their share
			const text = await limit(async () => {
				// A photo is looked at only in a DM, so it spends what is kept for them
				if (meter?.exceeded(task === 'directMessage' || task === 'vision' ? 1 : 1 - settings.llm.directMessageReserve)) throw new LlmBudgetError();
				const body = (await postModelJson(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, apiKey, {
					model,
					messages: messages.map(wireMessage),
					...(openAi ? { max_completion_tokens: taskModel.maxTokens } : { max_tokens: taskModel.maxTokens }),
					...(!(openAi && model.startsWith('gpt-5')) && { temperature: taskModel.temperature }),
					...(jsonMode && json && { response_format: { type: 'json_object' } }),
				}, settings.llm.timeoutSeconds * 1000, () => between(rng, 2_000, 6_000), 'LLM')) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
				const answer = body.choices?.[0]?.message?.content?.trim();
				// A provider that reports no usage is counted at about four characters a token
				const images = messages.reduce((sum, message) => sum + (message.images?.length ?? 0), 0);
				meter?.add(body.usage?.total_tokens ?? Math.ceil((JSON.stringify(messages, (key, value: unknown) => (key === 'images' ? undefined : value)).length + (answer?.length ?? 0)) / 4) + images * IMAGE_TOKENS);
				return answer;
			});
			if (!text) throw new Error('LLM answered no text');
			return text;
		},
	};
}

/** Canned lines, for dry runs without a model. */
export function createCannedLlm(rng: Rng): Llm {
	const lines = ['haha yeah, tell me more', 'oh nice, how did that go?', 'what are you up to today?', 'that sounds fun'];
	return {
		async complete(messages, options) {
			if (options.task === 'vision') return JSON.stringify({ seen: 'a slightly blurry photo of someone smiling' });
			const task = messages[messages.length - 1]?.content ?? '';
			if (task === POST_REQUEST) return 'around for a while today, say hi if you feel like a chat';
			return JSON.stringify({ reply: pick(rng, lines)!, notes: null, self: null, action: 'none' });
		},
	};
}

/** Whether a text provider is set: `llm.baseUrl`, or a text task's own `baseUrl` (never `models.vision`'s or `decisions.baseUrl`). */
export const providerSet = ({ llm, models: { vision: _vision, ...text } }: Settings) => !!(llm.baseUrl || Object.values(text).some((model) => model.baseUrl));

/**
 * One model client per persona, by id, so its own `settings.models` apply (the meter, `llm.dailyTokens`, and the
 * `concurrency` limit stay shared). Canned lines for a persona in `keyless`, and in a dry run for one without a
 * provider: otherwise that is an error, naming every such persona.
 */
export function llmsFor(
	personas: readonly { id: string; settings: Settings }[],
	{ dryRun, apiKeyOf, meter, concurrency, keyless = new Set(), rng = Math.random }: {
		dryRun: boolean;
		apiKeyOf: (envName: string) => string;
		meter?: TokenMeter;
		/** The most requests in flight at once, for every persona together (the global `llm.concurrency`). */
		concurrency: number;
		/** Personas whose model key is unset (the caller gives them in a dry run only). */
		keyless?: ReadonlySet<string>;
		rng?: Rng;
	},
): Map<string, Llm> {
	const noProvider = personas.filter((persona) => !providerSet(persona.settings)).map((persona) => persona.id);
	if (noProvider.length && !dryRun) {
		throw new Error(`Set settings.llm.baseUrl and a model in the config (a dry run uses canned lines); no provider for: ${noProvider.join(', ')}`);
	}
	const canned = createCannedLlm(rng);
	const limit = createLimiter(concurrency);
	return new Map(personas.map((persona) => [
		persona.id,
		providerSet(persona.settings) && !keyless.has(persona.id) ? createConfiguredLlm({ settings: persona.settings, apiKeyOf, meter, limit, rng }) : canned,
	]));
}
