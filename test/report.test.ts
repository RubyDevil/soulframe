import { describe, expect, it } from 'vitest';
import { interruptionsOn } from '../src/pacing.js';
import { AWARE_PROMPT, clockText } from '../src/prompts.js';
import { personaReport, personaWarnings, samplePrompt, settingsWarnings } from '../src/report.js';
import { everyDay, NOTED_DM, personaOf, settingsOf, TEST_IDENTITY, TEST_POLICY, TEST_STYLE, testPersona } from './fixtures.js';

// Thursday, November 5, 12:00 UTC
const now = Date.UTC(2026, 10, 5, 12);
/** Settings with a text provider, as most apps run with. */
const TEXT = settingsOf({ llm: { baseUrl: 'https://llm.example/v1', model: 'chat-model' } });
const WINDOW = everyDay(['19:00', '19:30'], ['23:00', '23:30']);
const evening = { start: ['19:00', '19:00'], end: ['23:00', '23:00'] } as { start: [string, string]; end: [string, string] };
/** The same hours every day: online from `start` to `end`, with a chance of a day off. */
const daily = ({ start, end }: { start: [string, string]; end: [string, string] }, skipDayChance?: number) => everyDay(start, end, skipDayChance);

/** The test persona with these fields of its own (its hours replace the test persona's). */
const persona = (fields: Record<string, unknown>) => personaOf(testPersona(fields));
/** check-config's lines on it, now, with these settings (a text provider unless given). */
const reportOf = (fields: Record<string, unknown>, status?: string, settings = TEXT) => personaReport(persona(fields), { settings, now, ...(status && { status }) });
const nowOf = (fields: Record<string, unknown>) => reportOf(fields).find((line) => line.startsWith('  now: '));
const agendaOf = (fields: Record<string, unknown>) => reportOf(fields).filter((line) => /^ {2}(today|tomorrow) /.test(line));

describe('the report on a persona', () => {
	it("lists today's interruptions, as the queue meets them", () => {
		const lineOf = (settings = TEXT) => reportOf({ schedule: daily(evening) }, undefined, settings).find((line) => line.startsWith('  interruptions today: '));
		const today = interruptionsOn(persona({ schedule: daily(evening) }), { year: 2026, month: 11, day: 5 }, TEXT.pacing);
		expect(today.length).toBeGreaterThan(0);
		expect(lineOf()).toBe(`  interruptions today: ${today.map((away) => `${clockText(away.start, 'UTC')} to ${clockText(away.end, 'UTC')}`).join(', ')}`);
		expect(lineOf(settingsOf({ pacing: { interruptions: { meanMinutes: 0 } } }))).toBe('  interruptions today: none');
	});

	it("shows today's and tomorrow's agenda", () => {
		expect(agendaOf({ schedule: daily({ start: ['19:00', '19:00'], end: ['01:30', '01:30'] }) })).toEqual(['  today (thu, UTC, UTC): online 7:00 PM to 1:30 AM', '  tomorrow (fri): online 7:00 PM to 1:30 AM']);
		expect(agendaOf({ schedule: daily(evening, 0.9) })).toEqual(['  today (thu, UTC, UTC): skipped', '  tomorrow (fri): skipped']);
	});

	it('heads today with the zone and its offset now', () => {
		const todayOf = (timezone: string) => agendaOf({ schedule: daily(evening), timezone })[0];
		expect(todayOf('America/Toronto')).toBe('  today (thu, America/Toronto, UTC-5): online 7:00 PM to 11:00 PM');
		expect(todayOf('Asia/Kolkata')).toBe('  today (thu, Asia/Kolkata, UTC+5:30): online 7:00 PM to 11:00 PM');
		expect(todayOf('Europe/London')).toBe('  today (thu, Europe/London, UTC): online 7:00 PM to 11:00 PM');
	});

	it('says what the persona is doing now, or what comes next, or what the app says instead', () => {
		expect(nowOf({ schedule: daily({ start: ['11:00', '11:00'], end: ['01:00', '01:00'] }) })).toBe('  now: online until 1:00 AM');
		expect(nowOf({ schedule: { days: { 'mon-sun': { breaks: [{ start: ['11:50', '11:50'], minutes: [15, 15] }], online: [evening] } } } })).toBe('  now: on a break until 12:05 PM');
		expect(nowOf({ timezone: 'America/Toronto', schedule: daily({ start: ['21:32', '21:32'], end: ['01:00', '01:00'] }) })).toBe('  now: offline; next: online thu 9:32 PM (02:32 UTC)');
		expect(nowOf({ schedule: { days: { 'mon-sun': { breaks: [{ start: ['13:00', '13:00'], minutes: [10, 10] }], online: [evening] } } } })).toBe('  now: offline; next: break thu 1:00 PM (13:00 UTC)');
		expect(nowOf({ schedule: { days: { 'mon-sun': {} } } })).toBe('  now: offline; nothing in the next week');
		expect(reportOf({ schedule: daily({ start: ['11:00', '11:00'], end: ['13:00', '13:00'] }) }, 'paused')).toContain('  now: paused');
	});

	it('lists its prompt, its models and its moods', () => {
		const lines = reportOf({ schedule: daily(evening), moods: ['chill'] });
		expect(lines[0]).toBe('  prompt: 8 characters');
		expect(lines).toContain('  models: directMessage chat-model, groupChat chat-model, post chat-model');
		expect(lines.at(-1)).toBe('  moods: 1; today: chill');
		expect(reportOf({ schedule: daily(evening) }, undefined, settingsOf())).toContain('  models: directMessage (canned), groupChat (canned), post (canned)');
		expect(reportOf({ schedule: daily(evening) }).at(-1)).toBe('  moods: 0; today: no mood');
	});
});

describe('the warnings on a persona', () => {
	const warningsOf = (fields: Record<string, unknown>, channels = ['forum']) => personaWarnings(persona(fields), channels);

	it("warns about a zone that is no city's (UTC aside: the other tests use it)", () => {
		const zoneWarning = (timezone: string) => `"test" has timezone "${timezone}": not a city's zone (an abbreviation or a fixed offset): use the city's own, e.g. America/New_York`;
		expect(warningsOf({ schedule: WINDOW, timezone: 'EST' })).toEqual([zoneWarning('EST')]);
		expect(warningsOf({ schedule: WINDOW, timezone: 'Etc/GMT+5' })).toEqual([zoneWarning('Etc/GMT+5')]);
		expect(warningsOf({ schedule: WINDOW, timezone: 'UTC' })).toEqual([]);
	});

	it('warns about under an hour a day online and more than every other day off', () => {
		expect(warningsOf({ schedule: daily({ start: ['19:00', '19:00'], end: ['19:30', '19:30'] }) })).toEqual(['"test" is online about 0.5 hours a day on average']);
		expect(warningsOf({ schedule: daily(evening, 0.6) })).toEqual(['"test" takes more than every other day off (skipDayChance 0.6)']);
		expect(warningsOf({ schedule: daily(evening) })).toEqual([]);
	});

	it('warns about one of its channels that no span includes', () => {
		const days = { 'mon-sun': { online: [{ ...evening, on: ['forum'] }] } };
		expect(warningsOf({ schedule: { days } }, ['forum', 'chat'])).toEqual(['"test" is never online on chat: its DMs there would wait forever']);
		expect(warningsOf({ schedule: { days } })).toEqual([]);
	});
});

describe('the warnings on settings', () => {
	it('warn of no text provider, whose every model is canned', () => {
		expect(settingsWarnings(settingsOf({ llm: { model: 'chat-model' } }))).toEqual(['no text provider (llm.baseUrl): llmsFor refuses to make its model outside a dry run, which uses canned lines']);
		expect(settingsWarnings(TEXT)).toEqual([]);
	});

	it('warn when a reply may be written again more than once, each time paid for', () => {
		expect(settingsWarnings(settingsOf({ ...TEXT, pacing: { burst: { maxRestarts: 3 } } }))).toEqual([
			'pacing.burst.maxRestarts 3: each restart drops a draft already paid for, so one reply may cost up to 4 DM turns of tokens',
		]);
		// Not when it never starts over
		expect(settingsWarnings(settingsOf({ llm: TEXT.llm, pacing: { burst: { maxRestarts: 3, restartOnNewMessage: false } } }))).toEqual([]);
	});
});

describe('the sample prompt', () => {
	/** The time line of its system prompt on a DM channel. */
	const timeLineOf = async (hours: typeof evening) => (await samplePrompt({ settings: TEXT, persona: persona({ schedule: daily(hours) }), identity: TEST_IDENTITY, channel: NOTED_DM, now })).split('\n\n').at(-1);
	const rest = "Their last message was just now. You haven't written to them before. Right now you're free and online";

	it('is built at its next span on the channel when it is offline, so the lines on its day show', async () => {
		// Offline at noon on Thursday: a minute after 7 PM
		expect(await timeLineOf(evening)).toBe(`It is Thursday, November 5, 7:01 PM for you. ${rest}, until about 11:00 PM. You'll be online again tomorrow around 7:00 PM. ${AWARE_PROMPT}`);
		// Online then: at that time
		expect(await timeLineOf({ start: ['11:00', '11:00'], end: ['13:00', '13:00'] })).toBe(
			`It is Thursday, November 5, 12:00 PM for you. ${rest}, until about 1:00 PM. You'll be online again tomorrow around 11:00 AM. ${AWARE_PROMPT}`,
		);
	});

	it("gives the persona's prompt, the app's identity phrase and style, where, the channel's note and the app's lines", async () => {
		const system = await samplePrompt({ settings: TEXT, persona: persona({ schedule: daily(evening) }), identity: TEST_IDENTITY, style: TEST_STYLE, channel: NOTED_DM, extraLines: () => ['A line the app adds.'], now });
		expect(system).toContain(`A voice.\n\nYou are Test, a guide made by Forum (https://forum.example), chatting by text in Forum direct messages. Forum shows everyone your name marked [bot].\n\n${TEST_STYLE}`);
		expect(system).toContain('A line the app adds.');
	});

	it("follows the app's policy, and has no app rules without one", async () => {
		const sample = (policy?: typeof TEST_POLICY) => samplePrompt({ settings: TEXT, persona: persona({ schedule: daily(evening) }), identity: TEST_IDENTITY, channel: NOTED_DM, now, ...(policy && { policy }) });
		expect(await sample(TEST_POLICY)).toContain('- Respect a no at once.');
		expect(await sample()).not.toContain('Respect a no at once.');
	});

	it("runs with the settings it is given: the brain's own", async () => {
		const sample = (settings?: ReturnType<typeof settingsOf>) => samplePrompt({ persona: persona({ schedule: daily(evening) }), settings: settings ?? TEXT, channel: NOTED_DM, now });
		expect(await sample()).toContain('at most 280 characters');
		expect(await sample(settingsOf({ memory: { personNotes: 120 } }))).toContain('at most 120 characters');
	});
});
