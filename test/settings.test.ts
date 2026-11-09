import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVICE_SETTINGS, DEFAULT_SETTINGS, parseServiceSettings, parseSettings, settingsFor, SettingsSchema, taskModel } from '../src/settings.js';
import { settingsOf } from './fixtures.js';

describe('parseSettings', () => {
	it('fills in every default: nothing at all, null (an empty YAML file) and {} are the defaults', () => {
		for (const raw of [undefined, null, {}]) expect(parseSettings(raw)).toEqual({ settings: DEFAULT_SETTINGS, issues: [] });
	});

	it('keeps what it is given, key by key, over the defaults', () => {
		const { settings } = parseSettings({ pacing: { glance: { medianSeconds: 90, p90Seconds: 300 } }, memory: { personNotes: 100 } });
		expect(settings?.pacing.glance).toEqual({ ...DEFAULT_SETTINGS.pacing.glance, medianSeconds: 90, p90Seconds: 300 });
		expect(settings?.memory).toEqual({ ...DEFAULT_SETTINGS.memory, personNotes: 100 });
	});

	it('reads a drawn range either way, with its own shape or one it is given', () => {
		const { settings } = parseSettings({ pacing: { backlogGapSeconds: [20, 90], typingCharsPerSecond: { range: [4, 8], shape: 'uniform' } } });
		expect(settings?.pacing.backlogGapSeconds).toEqual({ range: [20, 90], shape: 'lognormal' });
		expect(settings?.pacing.typingCharsPerSecond).toEqual({ range: [4, 8], shape: 'uniform' });
	});

	it('answers every problem with its path and the value it got, after its source when given, and no settings', () => {
		expect(parseSettings({ pacing: { replySplitChance: 1.5 }, memory: { personNotes: -1 } }, { source: 'settings.yaml' })).toEqual({
			issues: [
				'settings.yaml › memory.personNotes: Number must be greater than or equal to 0 (got -1)',
				'settings.yaml › pacing.replySplitChance: Number must be less than or equal to 1 (got 1.5)',
			],
		});
		expect(parseSettings({ memory: { personNotes: 5000 } }).issues).toEqual(['memory.personNotes: Number must be less than or equal to 2000 (got 5000)']);
	});

	it('refuses a key it does not know, with the nearest one, and the settings with it', () => {
		expect(parseSettings({ pacng: {}, pacing: { glanse: { medianSeconds: 30 } } })).toEqual({
			issues: ['pacng: unknown key (did you mean "pacing"?)', 'pacing.glanse: unknown key (did you mean "glance"?)'],
		});
	});

	it('refuses a removed setting as unknown', () => {
		expect(parseSettings({ pacing: { singlePresence: false } }).issues).toEqual(['pacing.singlePresence: unknown key']);
	});

	it('wants a model for every text task once a provider is set (vision aside)', () => {
		expect(parseSettings({ models: { default: { baseUrl: 'https://llm.example/v1' } } }).issues).toEqual(
			['directMessage', 'groupChat', 'post'].map((task) => `models.${task}: no model named (set it, or models.default.model)`),
		);
		expect(parseSettings({ models: { default: { baseUrl: 'https://llm.example/v1', model: 'chat' } } }).issues).toEqual([]);
		expect(parseSettings({ models: { default: { baseUrl: 'https://llm.example/v1' }, directMessage: { model: 'a' }, groupChat: { model: 'b' }, post: { model: 'c' } } }).issues).toEqual([]);
	});

	it("wants a task on a provider of its own to name its own key and model: the default provider's never reach another host", () => {
		const main = { baseUrl: 'https://llm.example/v1', model: 'chat', apiKeyEnv: 'MAIN_KEY' };
		expect(parseSettings({ models: { default: main, groupChat: { baseUrl: 'https://other.example/v1' } } }).issues).toEqual([
			"models.groupChat.apiKeyEnv: on a provider of its own (its baseUrl), it names its own key variable ('' for none): the default one is never sent to another host",
			'models.groupChat.model: on a provider of its own (its baseUrl), it names its own model',
		]);
		expect(parseSettings({ models: { default: main, groupChat: { baseUrl: 'https://other.example/v1', apiKeyEnv: '', model: 'small' } } }).issues).toEqual([]);
		// vision too, once it is on a provider of its own
		expect(parseSettings({ models: { default: main, vision: { baseUrl: 'https://eyes.example/v1', model: 'eyes' } } }).issues).toEqual([
			"models.vision.apiKeyEnv: on a provider of its own (its baseUrl), it names its own key variable ('' for none): the default one is never sent to another host",
		]);
	});

	it('says where each setting of the 0.1 betas went: llm to models.default and the service settings, the Decisions client to the service settings', () => {
		expect(parseSettings({ llm: { baseUrl: 'https://llm.example/v1' }, decisions: { enabled: true, model: 'x', stop: { at: 0.95 } } }).issues).toEqual([
			"llm: moved: its baseUrl, apiKeyEnv, model, jsonMode and timeoutSeconds to models.default; dailyTokens, directMessageReserve and concurrency to the service settings' text (parseServiceSettings)",
			"decisions.enabled: moved to the service settings' decisions (parseServiceSettings): one Decisions client serves every persona",
			"decisions.model: moved to the service settings' decisions (parseServiceSettings): one Decisions client serves every persona",
		]);
	});

	it('takes one threshold for the group-chat gate, and says so to the per-chattiness ones of the 0.1 betas', () => {
		expect(parseSettings({ decisions: { groupChatGate: { chimeInAt: 2.2 } } }).settings?.decisions.groupChatGate.chimeInAt).toBe(2.2);
		expect(DEFAULT_SETTINGS.decisions.groupChatGate.chimeInAt).toBe(1.7);
		expect(parseSettings({ decisions: { groupChatGate: { chimeInAt: { quiet: 2.2 } } } }).issues).toEqual([
			'decisions.groupChatGate.chimeInAt: one number: a threshold per chattiness is gone (give a brain its own) (got {"quiet":2.2})',
		]);
		// Any other wrong value is only that
		expect(parseSettings({ decisions: { groupChatGate: { chimeInAt: '2' } } }).issues).toEqual(['decisions.groupChatGate.chimeInAt: Expected number, received string (got "2")']);
		expect(parseSettings({ decisions: { groupChatGate: { chimeInAt: 4 } } }).issues).toEqual(['decisions.groupChatGate.chimeInAt: Number must be less than or equal to 3 (got 4)']);
	});

	it('refuses settings that are not a mapping, "<source>:" before it as before any problem of the whole', () => {
		expect(parseSettings(['a list']).issues).toEqual(['Expected object, received array (got ["a list"])']);
		expect(parseSettings('oops', { source: 'settings.yaml' }).issues).toEqual(['settings.yaml: Expected object, received string (got "oops")']);
	});
});

describe('the example settings files', () => {
	const example = (name: string) => parse(readFileSync(new URL(`../examples/${name}`, import.meta.url), 'utf8'));

	it("load as written, a brain's and the service's (examples/settings.yaml and service.yaml, shown in docs/configuration.md)", () => {
		const { settings, issues } = parseSettings(example('settings.yaml'), { source: 'settings.yaml' });
		expect(issues).toEqual([]);
		expect(taskModel(settings!, 'groupChat')).toMatchObject({ baseUrl: 'https://api.provider.example/v1', model: 'provider-chat-small', apiKeyEnv: 'LLM_API_KEY' });
		expect(parseServiceSettings(example('service.yaml'), { source: 'service.yaml' })).toEqual({ service: { ...DEFAULT_SERVICE_SETTINGS, text: { ...DEFAULT_SERVICE_SETTINGS.text, dailyTokens: 400_000 }, decisions: { ...DEFAULT_SERVICE_SETTINGS.decisions, enabled: true } }, issues: [] });
	});
});

describe('settingsFor', () => {
	const app = settingsOf({ pacing: { glance: { medianSeconds: 40, p90Seconds: 600 }, typingCharsPerSecond: { range: [4, 8], shape: 'uniform' } }, memory: { personNotes: 120 } });

	it('is the settings it is given, the very object, for a persona that sets none of its own', () => {
		expect(settingsFor({}, app)).toEqual({ settings: app, issues: [] });
		expect(settingsFor({}, app).settings).toBe(app);
	});

	it("merges the persona's own pacing and relationship over them, key by key; a range replaces, and a bare one takes the setting's own shape", () => {
		const { settings } = settingsFor({ pacing: { glance: { medianSeconds: 90 }, typingCharsPerSecond: [2, 3] }, relationship: { affinity: { enabled: false } } }, app);
		expect(settings?.pacing.glance).toEqual({ ...app.pacing.glance, medianSeconds: 90, p90Seconds: 600 });
		expect(settings?.pacing.typingCharsPerSecond).toEqual({ range: [2, 3], shape: DEFAULT_SETTINGS.pacing.typingCharsPerSecond.shape });
		expect(settings?.relationship.affinity).toEqual({ ...app.relationship.affinity, enabled: false });
		expect(settings?.memory).toEqual(app.memory);
		// Its own shape, when it gives one
		expect(settingsFor({ pacing: { typingCharsPerSecond: { range: [2, 3], shape: 'uniform' } } }, app).settings?.pacing.typingCharsPerSecond.shape).toBe('uniform');
	});

	it('checks them merged, a rule across keys too, and answers every problem after its source when given, and no settings', () => {
		// Fine over the app's p90 of 600, not over the default's 150
		expect(settingsFor({ pacing: { glance: { medianSeconds: 400 } } }, app).issues).toEqual([]);
		expect(settingsFor({ pacing: { glance: { medianSeconds: 400 } } }, DEFAULT_SETTINGS, { source: 'robin.md' })).toEqual({
			issues: ['robin.md › pacing.glance: p90Seconds must be above medianSeconds (got {"medianSeconds":400,"p90Seconds":150,"…)'],
		});
		expect(settingsFor({ pacing: { glanse: { medianSeconds: 1 }, replySplitChance: 2 } as never }, app).issues).toEqual([
			'pacing.replySplitChance: Number must be less than or equal to 1 (got 2)',
			'pacing.glanse: unknown key (did you mean "glance"?)',
		]);
	});
});

describe('taskModel', () => {
	const settings = SettingsSchema.parse({
		models: {
			default: { baseUrl: 'https://llm.example/v1', model: 'chat', apiKeyEnv: 'MAIN_KEY', jsonMode: true, timeoutSeconds: 90 },
			groupChat: { model: 'small', maxTokens: 60 },
			post: { baseUrl: 'https://other.example/v1', apiKeyEnv: 'OTHER_KEY', model: 'poster' },
			vision: { model: 'eyes' },
		},
	});

	it("takes what a task names, else the default provider's", () => {
		expect(taskModel(settings, 'directMessage')).toEqual({ baseUrl: 'https://llm.example/v1', apiKeyEnv: 'MAIN_KEY', model: 'chat', jsonMode: true, timeoutSeconds: 90, maxTokens: 400, temperature: 0.9, ownProvider: false });
		expect(taskModel(settings, 'groupChat')).toMatchObject({ model: 'small', maxTokens: 60, apiKeyEnv: 'MAIN_KEY' });
	});

	it("on a provider of its own takes nothing of the default provider but its timeout", () => {
		expect(taskModel(settings, 'post')).toEqual({ baseUrl: 'https://other.example/v1', apiKeyEnv: 'OTHER_KEY', model: 'poster', jsonMode: false, timeoutSeconds: 90, maxTokens: 160, temperature: 1, ownProvider: true });
		const bare = SettingsSchema.parse({ models: { ...settings.models, post: { baseUrl: 'https://other.example/v1' } } });
		expect(taskModel(bare, 'post')).toMatchObject({ apiKeyEnv: undefined, model: undefined, jsonMode: false });
	});

	it('never gives vision the default model, which may not take images', () => {
		expect(taskModel(settings, 'vision')).toMatchObject({ model: 'eyes', baseUrl: 'https://llm.example/v1', apiKeyEnv: 'MAIN_KEY' });
		expect(taskModel(SettingsSchema.parse({ models: { default: settings.models.default } }), 'vision').model).toBeUndefined();
	});
});

describe('parseServiceSettings', () => {
	it('fills in every default: nothing at all, null and {} are the defaults', () => {
		for (const raw of [undefined, null, {}]) expect(parseServiceSettings(raw)).toEqual({ service: DEFAULT_SERVICE_SETTINGS, issues: [] });
		expect(DEFAULT_SERVICE_SETTINGS).toEqual({
			text: { dailyTokens: 200_000, directMessageReserve: 0.3, concurrency: 4 },
			decisions: { enabled: false, baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', model: 'gpt-6-luna', timeoutSeconds: 5, dailyTokens: 2_000_000 },
		});
	});

	it('answers every problem with its path after its source, an unknown key with the nearest one, and no service settings', () => {
		expect(parseServiceSettings({ text: { directMessageReserve: 0.95, concurency: 2 }, decisions: { baseUrl: 'nope' } }, { source: 'service.yaml' })).toEqual({
			issues: [
				'service.yaml › text.directMessageReserve: Number must be less than or equal to 0.9 (got 0.95)',
				'service.yaml › decisions.baseUrl: Invalid url (got "nope")',
				'service.yaml › text.concurency: unknown key (did you mean "concurrency"?)',
			],
		});
	});

	it("holds none of a brain's settings", () => {
		expect(parseServiceSettings({ pacing: {} }).issues).toEqual(['pacing: unknown key']);
	});
});
