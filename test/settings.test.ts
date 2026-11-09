import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings.js';

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
		expect(parseSettings({ llm: { baseUrl: 'https://llm.example/v1' } }).issues).toEqual(
			['directMessage', 'groupChat', 'post'].map((task) => `models.${task}: no model named (set it, or llm.model)`),
		);
		expect(parseSettings({ llm: { baseUrl: 'https://llm.example/v1', model: 'chat' } }).issues).toEqual([]);
		expect(parseSettings({ llm: { baseUrl: 'https://llm.example/v1' }, models: { directMessage: { model: 'a' }, groupChat: { model: 'b' }, post: { model: 'c' } } }).issues).toEqual([]);
	});

	it('takes one threshold for the group-chat gate, and says so to the per-chattiness ones of the 0.1 betas', () => {
		expect(parseSettings({ decisions: { groupChatGate: { chimeInAt: 2.2 } } }).settings?.decisions.groupChatGate.chimeInAt).toBe(2.2);
		expect(DEFAULT_SETTINGS.decisions.groupChatGate.chimeInAt).toBe(1.7);
		expect(parseSettings({ decisions: { groupChatGate: { chimeInAt: { quiet: 2.2 } } } }).issues).toEqual([
			'decisions.groupChatGate.chimeInAt: one number: a threshold per chattiness is gone (give a brain its own) (got {"quiet":2.2})',
		]);
	});

	it('refuses settings that are not a mapping', () => {
		expect(parseSettings(['a list']).issues).toEqual(['Expected object, received array (got ["a list"])']);
	});
});
