import { describe, expect, it } from 'vitest';
import { AWARE_PROMPT } from '../src/prompts.js';
import { personaReport, personaWarnings, samplePrompt } from '../src/report.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { NOTED_DM, personasOf, TEST_IDENTITY, TEST_POLICY, TEST_STYLE, testPersona } from './fixtures.js';

// Thursday, November 5, 12:00 UTC
const now = Date.UTC(2026, 10, 5, 12);
const TEXT = { settings: { llm: { baseUrl: 'https://llm.example/v1', model: 'chat-model' } } };
const WINDOW = { start: ['19:00', '19:30'], end: ['23:00', '23:30'] };
const evening = { start: ['19:00', '19:00'], end: ['23:00', '23:00'] };

/** The test persona with these fields of its own (its hours replace the window), with a text provider unless `shared` says otherwise. */
const persona = (fields: Record<string, unknown>, shared: unknown = TEXT) => personasOf({ test: testPersona({ window: undefined, ...fields }) }, { shared })[0]!;
/** check-config's lines on it, now. */
const reportOf = (fields: Record<string, unknown>, status?: string) => {
	const own = persona(fields);
	return personaReport(own, { shared: own.settings, now, ...(status && { status }) });
};
const nowOf = (fields: Record<string, unknown>) => reportOf(fields).find((line) => line.startsWith('  now: '));
const agendaOf = (fields: Record<string, unknown>) => reportOf(fields).filter((line) => /^ {2}(today|tomorrow) /.test(line));

describe('the report on a persona', () => {
	it("shows today's and tomorrow's agenda", () => {
		expect(agendaOf({ window: { start: ['19:00', '19:00'], end: ['01:30', '01:30'] } })).toEqual(['  today (thu, UTC, UTC): online 7:00 PM to 1:30 AM', '  tomorrow (fri): online 7:00 PM to 1:30 AM']);
		expect(agendaOf({ window: { ...evening, skipDayChance: 0.9 } })).toEqual(['  today (thu, UTC, UTC): skipped', '  tomorrow (fri): skipped']);
	});

	it('heads today with the zone and its offset now', () => {
		const todayOf = (timezone: string) => agendaOf({ window: evening, timezone })[0];
		expect(todayOf('America/Toronto')).toBe('  today (thu, America/Toronto, UTC-5): online 7:00 PM to 11:00 PM');
		expect(todayOf('Asia/Kolkata')).toBe('  today (thu, Asia/Kolkata, UTC+5:30): online 7:00 PM to 11:00 PM');
		expect(todayOf('Europe/London')).toBe('  today (thu, Europe/London, UTC): online 7:00 PM to 11:00 PM');
	});

	it('says what the persona is doing now, or what comes next, or what the app says instead', () => {
		expect(nowOf({ window: { start: ['11:00', '11:00'], end: ['01:00', '01:00'] } })).toBe('  now: online until 1:00 AM');
		expect(nowOf({ schedule: { days: { 'mon-sun': { breaks: [{ start: ['11:50', '11:50'], minutes: [15, 15] }], online: [evening] } } } })).toBe('  now: on a break until 12:05 PM');
		expect(nowOf({ timezone: 'America/Toronto', window: { start: ['21:32', '21:32'], end: ['01:00', '01:00'] } })).toBe('  now: offline; next: online thu 9:32 PM (02:32 UTC)');
		expect(nowOf({ schedule: { days: { 'mon-sun': { breaks: [{ start: ['13:00', '13:00'], minutes: [10, 10] }], online: [evening] } } } })).toBe('  now: offline; next: break thu 1:00 PM (13:00 UTC)');
		expect(nowOf({ schedule: { days: { 'mon-sun': {} } } })).toBe('  now: offline; nothing in the next week');
		expect(reportOf({ window: { start: ['11:00', '11:00'], end: ['13:00', '13:00'] } }, 'paused')).toContain('  now: paused');
	});

	it('lists its prompt, its overrides of the shared settings, its models and its character', () => {
		const own = persona({ window: evening, settings: { memory: { personNotes: 100 } }, character: { facts: ["you're 30"], moods: ['chill'] } });
		const lines = personaReport(own, { shared: DEFAULT_SETTINGS, now });
		expect(lines[0]).toMatch(/^ {2}prompt: .*test\.md \(8 characters\)$/);
		expect(lines).toContain('  overrides:');
		expect(lines).toContain('    memory.personNotes: 280 → 100');
		expect(lines).toContain('    llm.baseUrl: undefined → "https://llm.example/v1"');
		expect(lines).toContain('  models: directMessage chat-model, groupChat chat-model, post chat-model');
		expect(lines.at(-1)).toBe('  character: 1 facts, 0 interests, 0 boundaries, 1 moods; today: chill');
		const canned = persona({ window: evening }, {});
		expect(personaReport(canned, { shared: canned.settings, now })).toContain('  models: directMessage (canned), groupChat (canned), post (canned)');
		expect(personaReport(canned, { shared: canned.settings, now })).toContain('  overrides: none');
	});
});

describe('the warnings on a persona', () => {
	const warningsOf = (fields: Record<string, unknown>, channels = ['forum']) => personaWarnings(persona(fields), channels);

	it("warns about a zone that is no city's (UTC aside: the other tests use it)", () => {
		const zoneWarning = (timezone: string) => `"test" has timezone "${timezone}": not a city's zone (an abbreviation or a fixed offset): use the city's own, e.g. America/New_York`;
		expect(warningsOf({ window: WINDOW, timezone: 'EST' })).toEqual([zoneWarning('EST')]);
		expect(warningsOf({ window: WINDOW, timezone: 'Etc/GMT+5' })).toEqual([zoneWarning('Etc/GMT+5')]);
		expect(warningsOf({ window: WINDOW, timezone: 'UTC' })).toEqual([]);
	});

	it('warns about under an hour a day online and more than every other day off', () => {
		expect(warningsOf({ window: { start: ['19:00', '19:00'], end: ['19:30', '19:30'] } })).toEqual(['"test" is online about 0.5 hours a day on average']);
		expect(warningsOf({ window: { ...evening, skipDayChance: 0.6 } })).toEqual(['"test" takes more than every other day off (skipDayChance 0.6)']);
		expect(warningsOf({ window: evening })).toEqual([]);
	});

	it('warns about one of its channels that no span includes', () => {
		const days = { 'mon-sun': { online: [{ ...evening, on: ['forum'] }] } };
		expect(warningsOf({ schedule: { days } }, ['forum', 'chat'])).toEqual(['"test" is never online on chat: its DMs there would wait forever']);
		expect(warningsOf({ schedule: { days } })).toEqual([]);
	});

	it('warns of a persona without a text provider, whose every model is canned', () => {
		expect(personaWarnings(persona({ window: evening }, { settings: { llm: { model: 'chat-model' } } }), ['forum'])).toEqual([
			'"test" has no text provider (settings.llm.baseUrl): the app refuses to start without it; a dry run uses canned lines',
		]);
	});

	it('warns when it answers several people at once, which can lose self notes', () => {
		expect(personaWarnings(persona({ window: evening, settings: { pacing: { singlePresence: false } } }), ['forum'])).toEqual([
			`"test" has pacing.singlePresence off: replies to different people run at once and can overwrite each other's self notes`,
		]);
		expect(warningsOf({ window: evening })).toEqual([]);
	});
});

describe('the sample prompt', () => {
	/** The time line of its system prompt on a DM channel. */
	const timeLineOf = async (window: Record<string, unknown>) => (await samplePrompt({ persona: persona({ window }), identity: TEST_IDENTITY, channel: NOTED_DM, now })).split('\n\n').at(-1);
	const rest = "Their last message was just now. You haven't written to them before. Right now you're free and online";

	it('is built at its next span on the channel when it is offline, so the lines on its day show', async () => {
		// Offline at noon on Thursday: a minute after 7 PM
		expect(await timeLineOf(evening)).toBe(`It is Thursday, November 5, 7:01 PM for you. ${rest}, until about 11:00 PM. You'll be online again tomorrow around 7:00 PM. ${AWARE_PROMPT}`);
		// Online then: at that time
		expect(await timeLineOf({ start: ['11:00', '11:00'], end: ['13:00', '13:00'] })).toBe(
			`It is Thursday, November 5, 12:00 PM for you. ${rest}, until about 1:00 PM. You'll be online again tomorrow around 11:00 AM. ${AWARE_PROMPT}`,
		);
	});

	it("gives the app's identity phrase and style, where, the channel's note and the app's lines", async () => {
		const system = await samplePrompt({ persona: persona({ window: evening }), identity: TEST_IDENTITY, style: TEST_STYLE, channel: NOTED_DM, extraLines: () => ['A line the app adds.'], now });
		expect(system).toContain(`You are Test, a guide made by Forum (https://forum.example), chatting by text in Forum direct messages. Forum shows everyone your name marked [bot].\n\n${TEST_STYLE}`);
		expect(system).toContain('A line the app adds.');
	});

	it("follows the app's policy, and has no app rules without one", async () => {
		const sample = (policy?: typeof TEST_POLICY) => samplePrompt({ persona: persona({ window: evening }), identity: TEST_IDENTITY, channel: NOTED_DM, now, ...(policy && { policy }) });
		expect(await sample(TEST_POLICY)).toContain('- Respect a no at once.');
		expect(await sample()).not.toContain('Respect a no at once.');
	});
});
