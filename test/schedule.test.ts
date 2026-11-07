import { describe, expect, it } from 'vitest';
import { ScheduleSchema } from '../src/config/hours.js';
import {
	addDays,
	agendaOn,
	boundsIssues,
	busyAt,
	daysOf,
	fullyOnline,
	nextSpan,
	onlineMinutesByWeekday,
	scheduleOfWindow,
	situationAt,
	spanAt,
	zonedToUtc,
	type Hours,
	type LocalDate,
} from '../src/schedule.js';
import { MINUTE } from '../src/settings.js';

const TZ = 'America/Toronto';

describe('zonedToUtc', () => {
	it('converts a local time in winter and in summer', () => {
		// Toronto is UTC-5 in January and UTC-4 in July
		expect(zonedToUtc({ year: 2026, month: 1, day: 15 }, 9 * 60, TZ)).toBe(Date.UTC(2026, 0, 15, 14, 0));
		expect(zonedToUtc({ year: 2026, month: 7, day: 15 }, 9 * 60, TZ)).toBe(Date.UTC(2026, 6, 15, 13, 0));
	});
	it('rolls minutes past midnight into the next day', () => {
		expect(zonedToUtc({ year: 2026, month: 1, day: 15 }, 25 * 60, TZ)).toBe(Date.UTC(2026, 0, 16, 6, 0));
	});
	it('maps a time the clocks skip to the moment they jump, in every zone', () => {
		// London jumps from 01:00 to 02:00 at 01:00 UTC on 29 March, New York from 02:00 to 03:00 at 07:00 UTC on 8 March
		for (const clock of [60, 90, 119]) expect(zonedToUtc({ year: 2026, month: 3, day: 29 }, clock, 'Europe/London')).toBe(Date.UTC(2026, 2, 29, 1));
		for (const clock of [120, 150, 179]) expect(zonedToUtc({ year: 2026, month: 3, day: 8 }, clock, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7));
		expect(zonedToUtc({ year: 2026, month: 3, day: 29 }, 59, 'Europe/London')).toBe(Date.UTC(2026, 2, 29, 0, 59));
		expect(zonedToUtc({ year: 2026, month: 3, day: 29 }, 120, 'Europe/London')).toBe(Date.UTC(2026, 2, 29, 1));
		expect(zonedToUtc({ year: 2026, month: 3, day: 8 }, 180, 'America/New_York')).toBe(Date.UTC(2026, 2, 8, 7));
	});
});

const W = (start: [string, string], end: [string, string], skipDayChance = 0) => ({ start, end, skipDayChance });
const LEGACY_DATES = [
	{ year: 2026, month: 1, day: 15 },
	{ year: 2026, month: 3, day: 8 },
	{ year: 2026, month: 3, day: 29 },
	{ year: 2026, month: 7, day: 4 },
	{ year: 2026, month: 11, day: 1 },
];
/**
 * Every window configured when the agenda replaced windowOn, with the instants windowOn gave them (captured then): camille to
 * theo and aisha as their persona files had them (most use schedule: now), and the test fixtures' (test/fixtures.ts testPersona and the windows in the other tests).
 */
const LEGACY = [
	{ id: 'camille', timezone: 'America/Toronto', window: W(['21:00', '21:45'], ['01:00', '01:45'], 0.15), pins: [['2026-01-16T02:30Z', '2026-01-16T06:42Z'], ['2026-03-09T01:17Z', '2026-03-09T05:06Z'], ['2026-03-30T01:15Z', '2026-03-30T05:10Z'], ['2026-07-05T01:30Z', '2026-07-05T05:05Z'], ['2026-11-02T02:09Z', '2026-11-02T06:30Z']] },
	{ id: 'jade', timezone: 'America/Los_Angeles', window: W(['19:45', '20:30'], ['00:15', '01:00'], 0.1), pins: [['2026-01-16T03:52Z', '2026-01-16T08:35Z'], ['2026-03-09T02:55Z', '2026-03-09T07:19Z'], ['2026-03-30T03:15Z', '2026-03-30T07:34Z'], ['2026-07-05T03:07Z', '2026-07-05T07:26Z'], ['2026-11-02T04:28Z', '2026-11-02T08:30Z']] },
	{ id: 'marcus', timezone: 'America/New_York', window: W(['18:30', '19:15'], ['22:30', '23:15'], 0.1), pins: [['2026-01-15T23:31Z', '2026-01-16T03:41Z'], ['2026-03-08T22:55Z', '2026-03-09T02:30Z'], ['2026-03-29T22:35Z', '2026-03-30T02:36Z'], ['2026-07-04T23:06Z', '2026-07-05T02:43Z'], ['2026-11-01T23:52Z', '2026-11-02T03:45Z']] },
	{ id: 'nadia', timezone: 'America/Chicago', window: W(['22:45', '23:30'], ['04:00', '05:00'], 0.3), pins: [['2026-01-16T05:15Z', '2026-01-16T10:12Z'], ['2026-03-09T03:57Z', '2026-03-09T09:06Z'], ['2026-03-30T04:24Z', '2026-03-30T09:40Z'], null, null] },
	{ id: 'rin', timezone: 'America/Denver', window: W(['20:00', '20:45'], ['02:30', '03:15'], 0.05), pins: [['2026-01-16T03:17Z', '2026-01-16T09:32Z'], ['2026-03-09T02:24Z', '2026-03-09T09:05Z'], ['2026-03-30T02:21Z', '2026-03-30T08:48Z'], ['2026-07-05T02:07Z', '2026-07-05T08:58Z'], ['2026-11-02T03:25Z', '2026-11-02T10:08Z']] },
	{ id: 'theo', timezone: 'Europe/London', window: W(['19:45', '20:30'], ['00:00', '00:45'], 0.1), pins: [['2026-01-15T19:59Z', '2026-01-16T00:31Z'], ['2026-03-08T19:46Z', '2026-03-09T00:20Z'], ['2026-03-29T18:54Z', '2026-03-29T23:00Z'], ['2026-07-04T19:12Z', '2026-07-04T23:23Z'], ['2026-11-01T20:10Z', '2026-11-02T00:03Z']] },
	{ id: 'aisha', timezone: 'America/New_York', window: W(['19:00', '20:00'], ['01:00', '02:00']), pins: [['2026-01-16T00:57Z', '2026-01-16T06:41Z'], ['2026-03-08T23:21Z', '2026-03-09T05:30Z'], ['2026-03-29T23:26Z', '2026-03-30T05:29Z'], ['2026-07-04T23:10Z', '2026-07-05T05:55Z'], ['2026-11-02T00:38Z', '2026-11-02T06:32Z']] },
	{ id: 'aisha', timezone: 'America/New_York', window: W(['19:00', '21:00'], ['01:00', '03:00']), pins: [['2026-01-16T01:55Z', '2026-01-16T07:23Z'], ['2026-03-08T23:42Z', '2026-03-09T06:01Z'], ['2026-03-29T23:51Z', '2026-03-30T05:58Z'], ['2026-07-04T23:21Z', '2026-07-05T06:50Z'], ['2026-11-02T01:17Z', '2026-11-02T07:04Z']] },
	{ id: 'robin', timezone: TZ, window: W(['18:00', '20:00'], ['00:30', '02:00']), pins: [['2026-01-15T23:03Z', '2026-01-16T05:58Z'], ['2026-03-08T23:03Z', '2026-03-09T05:54Z'], ['2026-03-29T22:37Z', '2026-03-30T05:28Z'], ['2026-07-04T22:49Z', '2026-07-05T05:26Z'], ['2026-11-01T23:10Z', '2026-11-02T05:36Z']] },
	{ id: 'sky', timezone: TZ, window: W(['18:00', '20:00'], ['00:30', '02:00']), pins: [['2026-01-16T00:20Z', '2026-01-16T06:06Z'], ['2026-03-08T22:58Z', '2026-03-09T05:16Z'], ['2026-03-29T23:56Z', '2026-03-30T04:44Z'], ['2026-07-04T22:25Z', '2026-07-05T05:12Z'], ['2026-11-02T00:17Z', '2026-11-02T05:38Z']] },
	{ id: 'robin', timezone: TZ, window: W(['20:00', '20:00'], ['02:00', '02:00']), pins: [['2026-01-16T01:00Z', '2026-01-16T07:00Z'], ['2026-03-09T00:00Z', '2026-03-09T06:00Z'], ['2026-03-30T00:00Z', '2026-03-30T06:00Z'], ['2026-07-05T00:00Z', '2026-07-05T06:00Z'], ['2026-11-02T01:00Z', '2026-11-02T07:00Z']] },
	{ id: 'test', timezone: 'UTC', window: W(['19:00', '19:00'], ['23:00', '23:00']), pins: [['2026-01-15T19:00Z', '2026-01-15T23:00Z'], ['2026-03-08T19:00Z', '2026-03-08T23:00Z'], ['2026-03-29T19:00Z', '2026-03-29T23:00Z'], ['2026-07-04T19:00Z', '2026-07-04T23:00Z'], ['2026-11-01T19:00Z', '2026-11-01T23:00Z']] },
	{ id: 'robin', timezone: 'UTC', window: W(['08:00', '08:00'], ['23:00', '23:00']), pins: [['2026-01-15T08:00Z', '2026-01-15T23:00Z'], ['2026-03-08T08:00Z', '2026-03-08T23:00Z'], ['2026-03-29T08:00Z', '2026-03-29T23:00Z'], ['2026-07-04T08:00Z', '2026-07-04T23:00Z'], ['2026-11-01T08:00Z', '2026-11-01T23:00Z']] },
];


describe('legacy hours', () => {
	it.each(LEGACY)('$id ($timezone, $window.start to $window.end) keeps the instants the old windowOn gave', ({ id, timezone, window, pins }) => {
		const hours = { id, timezone, schedule: scheduleOfWindow(window) };
		for (const [index, date] of LEGACY_DATES.entries()) {
			const pin = pins[index];
			const agenda = agendaOn(hours, date);
			expect(agenda.skipped).toBe(!pin);
			expect(agenda.spans.map((span) => [span.start, span.end])).toEqual(pin ? [pin.map((iso) => Date.parse(iso))] : []);
		}
	});

	it('passes the bounds check for every one of them', () => {
		for (const { window } of LEGACY) expect(boundsIssues(window)).toEqual([]);
	});
});

/** Hours of a hand-built schedule (its defaults filled in by the schema). */
const hoursOf = (schedule: unknown, id = 'lena', timezone = 'UTC'): Hours => ({ id, timezone, schedule: ScheduleSchema.parse(schedule) });
const date = (day: number, month = 11): LocalDate => ({ year: 2026, month, day });
/** Minutes after the midnight of `on`, for a persona in UTC. */
const minutesOf = (ms: number, on: LocalDate) => (ms - Date.UTC(on.year, on.month - 1, on.day)) / MINUTE;
/** An instant in November 2026, UTC: the 2nd is a Monday. */
const at = (day: number, hours: number, minutes = 0) => Date.UTC(2026, 10, day, hours, minutes);
/** `count` dates from January 1st. */
const days = (count: number) => Array.from({ length: count }, (_, index) => addDays(date(1, 1), index));

// Weekdays: at work 09:00 to 17:30 with a 15-minute break at 12:30 on Forum only, then online 20:00 to 00:15; nothing at the weekend
const LENA = hoursOf({
	days: {
		'mon-fri': {
			busy: [{ reason: 'at work', start: ['09:00', '09:00'], end: ['17:30', '17:30'] }],
			breaks: [{ start: ['12:30', '12:30'], minutes: [15, 15], on: ['forum'] }],
			online: [{ start: ['20:00', '20:00'], end: ['00:15', '00:15'] }],
		},
		'sat,sun': {},
	},
});

describe('agendaOn', () => {
	const evenings = { days: { 'mon-sun': { online: [{ start: ['18:00', '20:00'], end: ['00:30', '02:00'] }] } } };

	it('is the same for the same persona and date, after a restart too, and differs between personas', () => {
		const robin = hoursOf(evenings, 'robin');
		expect(agendaOn(robin, date(12))).toEqual(agendaOn(robin, date(12)));
		// A restart parses the config again: a new schedule object
		expect(agendaOn(hoursOf(evenings, 'robin'), date(12))).toEqual(agendaOn(robin, date(12)));
		expect(agendaOn(hoursOf(evenings, 'sam'), date(12))).not.toEqual(agendaOn(robin, date(12)));
	});

	it('keeps each persona\'s own agenda when they share one schedule', () => {
		const schedule = ScheduleSchema.parse(evenings);
		expect(agendaOn({ id: 'robin', timezone: TZ, schedule }, date(1))).toEqual(agendaOn(hoursOf(evenings, 'robin', TZ), date(1)));
		expect(agendaOn({ id: 'sam', timezone: TZ, schedule }, date(1))).toEqual(agendaOn(hoursOf(evenings, 'sam', TZ), date(1)));
	});

	it('draws a day once and keeps the newest 16 days of a schedule', () => {
		const robin = hoursOf(evenings, 'robin');
		const first = agendaOn(robin, date(1));
		for (let day = 2; day <= 16; day++) agendaOn(robin, date(day));
		expect(agendaOn(robin, date(1))).toBe(first);
		agendaOn(robin, date(17));
		expect(agendaOn(robin, date(1))).not.toBe(first);
		expect(agendaOn(robin, date(1))).toEqual(first);
	});

	it('keeps a start range across midnight to those hours, on the earlier day', () => {
		const late = hoursOf({ days: { 'mon-sun': { online: [{ start: ['23:30', '00:30'], end: ['02:30', '03:30'] }] } } });
		for (const day of days(300)) {
			const [span] = agendaOn(late, day).spans;
			expect(span!.day).toEqual(day);
			expect(minutesOf(span!.start, day)).toBeGreaterThanOrEqual(23.5 * 60);
			expect(minutesOf(span!.start, day)).toBeLessThanOrEqual(24.5 * 60);
		}
	});

	it('puts an end at its first time after the start: the same night, or the next day', () => {
		const ending = (end: [string, string]) => hoursOf({ days: { 'mon-sun': { online: [{ start: ['19:45', '19:45'], end }] } } });
		for (const day of days(30)) {
			const sameNight = minutesOf(agendaOn(ending(['23:30', '00:30']), day).spans[0]!.end, day);
			expect(sameNight).toBeGreaterThanOrEqual(23.5 * 60);
			expect(sameNight).toBeLessThanOrEqual(24.5 * 60);
			const nextDay = minutesOf(agendaOn(ending(['01:00', '02:00']), day).spans[0]!.end, day);
			expect(nextDay).toBeGreaterThanOrEqual(25 * 60);
			expect(nextDay).toBeLessThanOrEqual(26 * 60);
		}
	});

	it('draws each block on its own: adding or editing one moves no other', () => {
		const online = [{ start: ['19:00', '21:00'], end: ['23:00', '01:00'] }];
		const work = { reason: 'at work', start: ['08:00', '09:00'], end: ['17:00', '18:00'] };
		const coffee = { start: ['10:00', '11:00'], minutes: [5, 10] };
		const lunch = { start: ['12:00', '13:00'], minutes: [5, 10] };
		for (const day of days(20)) {
			const alone = agendaOn(hoursOf({ days: { 'mon-sun': { online } } }), day);
			const full = agendaOn(hoursOf({ days: { 'mon-sun': { online, breaks: [coffee, lunch], busy: [work] } } }), day);
			const edited = agendaOn(hoursOf({ days: { 'mon-sun': { online, breaks: [{ ...coffee, minutes: [20, 30] }, lunch], busy: [work] } } }), day);
			expect(full.spans.filter((span) => span.kind === 'online')).toEqual(alone.spans);
			// In order: coffee, lunch, the evening
			expect(edited.spans[0]!.start).toBe(full.spans[0]!.start);
			expect(edited.spans[0]!.end).not.toBe(full.spans[0]!.end);
			expect(edited.spans.slice(1)).toEqual(full.spans.slice(1));
			expect(edited.busy).toEqual(full.busy);
		}
	});

	it('skips days at the configured rate, keeping their busy blocks; a day plan\'s chance replaces the schedule\'s', () => {
		const plan = {
			online: [{ start: ['20:00', '20:00'], end: ['23:00', '23:00'] }],
			breaks: [{ start: ['12:00', '12:00'], minutes: [10, 10] }],
			busy: [{ reason: 'at work', start: ['09:00', '09:00'], end: ['17:00', '17:00'] }],
		};
		const often = hoursOf({ skipDayChance: 0.5, days: { 'mon-sun': plan } });
		const agendas = days(200).map((day) => agendaOn(often, day));
		const skipped = agendas.filter((agenda) => agenda.skipped);
		expect(skipped.length).toBeGreaterThan(70);
		expect(skipped.length).toBeLessThan(130);
		for (const agenda of agendas) {
			expect(agenda.spans).toHaveLength(agenda.skipped ? 0 : 2);
			expect(agenda.busy).toHaveLength(1);
		}
		const never = hoursOf({ skipDayChance: 0.9, days: { 'mon-sun': { ...plan, skipDayChance: 0 } } });
		expect(days(50).filter((day) => agendaOn(never, day).skipped)).toEqual([]);
	});

	it('keeps a block on about its chance of days', () => {
		const gym = hoursOf({ days: { 'mon-sun': { busy: [{ reason: 'at the gym', start: ['18:00', '18:15'], end: ['19:00', '19:15'], chance: 0.4 }] } } });
		const kept = days(400).filter((day) => agendaOn(gym, day).busy.length).length;
		expect(kept / 400).toBeGreaterThan(0.32);
		expect(kept / 400).toBeLessThan(0.48);
	});

	it('starts a break in its range and keeps it to its minutes', () => {
		const breaks = hoursOf({ days: { 'mon-sun': { breaks: [{ start: ['12:30', '12:45'], minutes: [10, 20] }] } } });
		for (const day of days(100)) {
			const [span] = agendaOn(breaks, day).spans;
			expect(span!.kind).toBe('break');
			expect(minutesOf(span!.start, day)).toBeGreaterThanOrEqual(12.5 * 60);
			expect(minutesOf(span!.start, day)).toBeLessThanOrEqual(12.75 * 60);
			expect((span!.end - span!.start) / MINUTE).toBeGreaterThanOrEqual(10);
			expect((span!.end - span!.start) / MINUTE).toBeLessThanOrEqual(20);
		}
	});

	it('is offline all day on a day with nothing planned', () => {
		expect(agendaOn(LENA, date(7))).toEqual({ day: date(7), skipped: false, spans: [], busy: [] });
	});
});

describe('daylight saving', () => {
	// Touching blocks around the hour that is skipped or repeated (01:00 in London, 02:00 in Toronto)
	const nightly = {
		'mon-sun': {
			online: [
				{ start: ['00:15', '00:15'], end: ['01:30', '01:30'] },
				{ start: ['02:00', '02:00'], end: ['04:00', '04:00'] },
			],
			breaks: [{ start: ['01:40', '01:40'], minutes: [15, 15] }],
		},
	};
	it.each([
		{ timezone: 'Europe/London', day: date(29, 3) },
		{ timezone: 'Europe/London', day: date(25, 10) },
		{ timezone: TZ, day: date(8, 3) },
		{ timezone: TZ, day: date(1, 11) },
	])('keeps the spans of $timezone in order on $day.month/$day.day, each ending after it starts', ({ timezone, day }) => {
		const { spans } = agendaOn(hoursOf({ days: nightly }, 'robin', timezone), day);
		expect(spans.length).toBeGreaterThan(1);
		for (const [index, span] of spans.entries()) {
			expect(span.end).toBeGreaterThan(span.start);
			if (index) expect(span.start).toBeGreaterThanOrEqual(spans[index - 1]!.end);
		}
	});

	it('shortens a span across the skipped hour by that hour', () => {
		const across = hoursOf({ days: { 'mon-sun': { online: [{ start: ['00:30', '00:30'], end: ['04:00', '04:00'] }] } } }, 'robin', TZ);
		const [span] = agendaOn(across, date(8, 3)).spans;
		expect((span!.end - span!.start) / MINUTE).toBe(150);
	});

	it('starts a span from the skipped hour when the clocks jump, keeping the time after it', () => {
		const late = hoursOf({ days: { 'mon-sun': { online: [{ start: ['01:30', '01:30'], end: ['02:15', '02:15'] }] } } }, 'robin', 'Europe/London');
		expect(agendaOn(late, date(29, 3)).spans).toMatchObject([{ start: Date.UTC(2026, 2, 29, 1), end: Date.UTC(2026, 2, 29, 1, 15) }]);
	});

	it.each([
		{ timezone: 'Europe/London', day: date(29, 3) },
		{ timezone: 'America/New_York', day: date(8, 3) },
		{ timezone: TZ, day: date(8, 3) },
	])('keeps the blocks of $timezone apart across days on $day.month/$day.day, as scheduleIssues promises', ({ timezone, day }) => {
		// A late span of the day before ending in the skipped hour, a span starting in it; a busy block ending in it, a span after it
		const plans = [
			{ online: [{ start: ['02:15', '02:15'], end: ['04:00', '04:00'] }, { start: ['21:00', '21:00'], end: ['01:50', '01:50'] }] },
			{ busy: [{ reason: 'out with friends', start: ['00:30', '00:30'], end: ['01:50', '01:50'] }], online: [{ start: ['02:10', '02:10'], end: ['04:00', '04:00'] }] },
		];
		for (const plan of plans) {
			const hours = hoursOf({ days: { 'mon-sun': plan } }, 'robin', timezone);
			const blocks = [addDays(day, -1), day].flatMap((on) => [...agendaOn(hours, on).spans, ...agendaOn(hours, on).busy]).sort((a, b) => a.start - b.start);
			for (const [index, block] of blocks.entries()) {
				expect(block.end).toBeGreaterThan(block.start);
				if (index) expect(block.start).toBeGreaterThanOrEqual(blocks[index - 1]!.end);
			}
		}
	});
});

describe('queries', () => {
	it('finds yesterday\'s span after midnight', () => {
		expect(spanAt(LENA, at(4, 0, 5))).toMatchObject({ kind: 'online', start: at(3, 20), end: at(4, 0, 15), day: date(3) });
		expect(spanAt(LENA, at(4, 0, 15))).toBeNull();
	});

	it('sees a span only on its platforms; a break is never fully online', () => {
		const lunch = at(3, 12, 35);
		expect(spanAt(LENA, lunch)).toMatchObject({ kind: 'break', on: ['forum'] });
		expect(spanAt(LENA, lunch, 'forum')).toMatchObject({ kind: 'break' });
		expect(spanAt(LENA, lunch, 'chat')).toBeNull();
		expect(fullyOnline(LENA, 'forum', lunch)).toBe(false);
		expect(fullyOnline(LENA, 'forum', at(3, 21))).toBe(true);
		expect(fullyOnline(LENA, 'chat', at(3, 21))).toBe(true);
	});

	it('gives the next span, of a kind and on a platform when asked', () => {
		const morning = at(3, 10);
		expect(nextSpan(LENA, morning)).toMatchObject({ kind: 'break', start: at(3, 12, 30) });
		expect(nextSpan(LENA, morning, { kind: 'online' })).toMatchObject({ kind: 'online', start: at(3, 20) });
		expect(nextSpan(LENA, morning, { channel: 'chat' })).toMatchObject({ kind: 'online', start: at(3, 20) });
		// From Saturday, over an empty weekend, to Monday's break
		expect(nextSpan(LENA, at(7, 1))).toMatchObject({ kind: 'break', start: at(9, 12, 30), day: date(9) });
		expect(nextSpan(hoursOf({ days: { 'mon-sun': {} } }), morning)).toBeNull();
	});

	it('looks past skipped days, up to two weeks ahead', () => {
		const rare = hoursOf({ skipDayChance: 0.9, days: { 'mon-sun': { online: [{ start: ['20:00', '20:00'], end: ['23:00', '23:00'] }] } } }, 'rare');
		const open = (day: LocalDate, ahead: number) => !agendaOn(rare, addDays(day, ahead)).skipped;
		const week = [1, 2, 3, 4, 5, 6, 7];
		const nextWeek = [8, 9, 10, 11, 12, 13, 14];
		// A day whose next day online is more than a week away
		const from = days(200).find((day) => week.every((ahead) => !open(day, ahead)) && nextWeek.some((ahead) => open(day, ahead)))!;
		const ahead = nextWeek.find((count) => open(from, count))!;
		expect(nextSpan(rare, Date.UTC(from.year, from.month - 1, from.day, 23, 30))!.day).toEqual(addDays(from, ahead));
	});

	it('knows the busy block at a time', () => {
		expect(busyAt(LENA, at(3, 12, 35))).toMatchObject({ reason: 'at work', start: at(3, 9), end: at(3, 17, 30), day: date(3) });
		expect(busyAt(LENA, at(3, 18))).toBeNull();
	});
});

describe('situationAt', () => {
	it('on a break from work: the work block, no next busy block, and the evening span', () => {
		const situation = situationAt(LENA, at(3, 12, 35), 'forum')!;
		expect(situation.span).toMatchObject({ kind: 'break', start: at(3, 12, 30), end: at(3, 12, 45) });
		expect(situation.busy).toMatchObject({ reason: 'at work', end: at(3, 17, 30) });
		expect(situation.nextBusy).toBeNull();
		expect(situation.nextOnline).toMatchObject({ kind: 'online', start: at(3, 20), day: date(3) });
	});

	it('in a full span: tomorrow\'s work, within 36 hours, and tomorrow\'s span on that platform', () => {
		const situation = situationAt(LENA, at(3, 21), 'chat')!;
		expect(situation.span).toMatchObject({ kind: 'online', day: date(3) });
		expect(situation.busy).toBeNull();
		expect(situation.nextBusy).toMatchObject({ reason: 'at work', start: at(4, 9), day: date(4) });
		expect(situation.nextOnline).toMatchObject({ kind: 'online', start: at(4, 20) });
	});

	it('names no busy block more than 36 hours away', () => {
		expect(situationAt(LENA, at(6, 21), 'forum')!.nextBusy).toBeNull();
	});

	it('is null when no span is open on that platform', () => {
		expect(situationAt(LENA, at(3, 15), 'forum')).toBeNull();
		expect(situationAt(LENA, at(3, 12, 35), 'chat')).toBeNull();
	});
});

describe('daysOf', () => {
	it('reads days, ranges (wrapping too) and lists', () => {
		expect(daysOf('wed')).toEqual([2]);
		expect(daysOf('mon-fri')).toEqual([0, 1, 2, 3, 4]);
		expect(daysOf('sat,sun')).toEqual([5, 6]);
		expect(daysOf('fri-mon')).toEqual([4, 5, 6, 0]);
		expect(daysOf('mon-wed,fri')).toEqual([0, 1, 2, 4]);
	});

	it('is null for anything else', () => {
		for (const key of ['mon-fir', 'funday', 'Mon', 'mon-', 'mon-wed-fri', '']) expect(daysOf(key)).toBeNull();
	});
});

describe('boundsIssues', () => {
	it('refuses a range over 12 hours, at that bound', () => {
		expect(boundsIssues({ start: ['20:30', '19:30'], end: ['23:00', '23:30'] })).toEqual([
			{ path: ['start'], message: 'a range of 23:00 hours: are earliest and latest swapped? (a latest before the earliest is the next day)' },
		]);
	});

	it('refuses an end that can come before the start, as an end range across the start range does', () => {
		expect(boundsIssues({ start: ['19:45', '20:30'], end: ['20:00', '21:00'] })).toEqual([{ path: ['end'], message: 'can end before it starts (start up to 20:30, end from 20:00)' }]);
		expect(boundsIssues({ start: ['19:00', '20:00'], end: ['19:30', '20:30'] })).toEqual([{ path: ['end'], message: 'can end before it starts (start up to 20:00, end from 19:30)' }]);
	});

	it('refuses a block that can last over 20 hours', () => {
		expect(boundsIssues({ start: ['04:00', '05:00'], end: ['23:00', '01:15'] })).toEqual([{ path: ['end'], message: 'lasts up to 21:15 hours (at most 20)' }]);
	});

	it('accepts a start range across midnight and 20 hours exactly, and leaves malformed clocks to the schema', () => {
		expect(boundsIssues({ start: ['23:30', '00:30'], end: ['02:30', '03:30'] })).toEqual([]);
		expect(boundsIssues({ start: ['04:00', '05:00'], end: ['23:00', '00:00'] })).toEqual([]);
		expect(boundsIssues({ start: ['25:00', '19:00'], end: ['01:00', '02:00'] })).toEqual([]);
	});
});

describe('scheduleIssues', () => {
	/** The schema's problems with a schedule of these days, as path and message. */
	const problems = (days: Record<string, unknown>) => {
		const result = ScheduleSchema.safeParse({ days });
		return result.success ? [] : result.error.issues.map(({ path, message }) => ({ path, message }));
	};
	const every = (plan: unknown) => problems({ 'mon-sun': plan });
	const work = { reason: 'at work', start: ['08:45', '09:00'], end: ['17:15', '17:45'] };
	const evening = { start: ['19:45', '20:30'], end: ['23:30', '00:30'] };

	it('wants every weekday in exactly one key that reads as days', () => {
		expect(problems({ 'mon-fri': {}, wed: {}, 'sat,sun': {} })).toEqual([{ path: ['days', 'wed'], message: 'wed is also in "mon-fri"' }]);
		expect(problems({ 'mon-thu': {}, 'wed-sun': {} })).toEqual([{ path: ['days', 'wed-sun'], message: 'wed, thu are also in "mon-thu"' }]);
		expect(problems({ 'mon-fri': {} })).toEqual([{ path: ['days'], message: 'no plan for sat, sun (add them, or "sat,sun: {}" for days with nothing)' }]);
		// The bad key may be meant for the missing days: only that is said
		expect(problems({ 'mon-fir': {}, 'sat,sun': {} })).toEqual([{ path: ['days', 'mon-fir'], message: 'not a day or day group (mon tue wed thu fri sat sun, "mon-fri", "sat,sun")' }]);
	});

	it('refuses blocks that can overlap on one day, at the later one, naming the other\'s widest times', () => {
		const gym = { reason: 'at the gym', start: ['18:00', '18:15'], end: ['19:00', '19:15'] };
		expect(every({ busy: [work, gym], online: [{ ...evening, start: ['19:00', '19:30'] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'online', 0], message: 'can overlap busy.1 "at the gym" (18:00 to 19:15)' },
		]);
		expect(every({ online: [{ start: ['19:00', '19:30'], end: ['22:00', '23:00'] }, { start: ['22:30', '23:00'], end: ['01:00', '01:30'] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'online', 1], message: 'can overlap online.0 (19:00 to 23:00)' },
		]);
		expect(every({ breaks: [{ start: ['10:30', '11:00'], minutes: [5, 10] }, { start: ['11:05', '11:15'], minutes: [5, 10] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'breaks', 1], message: 'can overlap breaks.0 (10:30 to 11:10)' },
		]);
		expect(every({ breaks: [{ start: ['19:30', '19:40'], minutes: [10, 20] }], online: [evening] })).toEqual([
			{ path: ['days', 'mon-sun', 'online', 0], message: 'can overlap breaks.0 (19:30 to 20:00)' },
		]);
	});

	it('refuses a break that can cross a busy block\'s start or end, at the break', () => {
		expect(every({ busy: [work], breaks: [{ start: ['08:40', '08:50'], minutes: [10, 15] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'breaks', 0], message: 'can cross busy.0 "at work" (08:45 to 17:45); a break is inside one busy block (09:00 to 17:15 here) or clear of it' },
		]);
	});

	it('refuses a block that can run past midnight into the next day\'s, at that block, once', () => {
		expect(problems({
			'mon-thu': {},
			fri: { online: [{ start: ['20:30', '21:00'], end: ['01:30', '02:00'] }] },
			'sat,sun': { online: [{ start: ['01:30', '02:00'], end: ['03:00', '04:00'] }] },
		})).toEqual([{ path: ['days', 'fri', 'online', 0], message: 'runs until 02:00 sat, into days.sat,sun.online.0 (from 01:30)' }]);
		const shift = { reason: 'on a night shift', start: ['00:30', '00:30'], end: ['08:00', '08:00'] };
		const late = { start: ['20:00', '20:00'], end: ['01:00', '01:00'] };
		expect(problems({ 'mon-sat': { busy: [shift] }, sun: { online: [late] } })).toEqual([
			{ path: ['days', 'sun', 'online', 0], message: 'runs until 01:00 mon, into days.mon-sat.busy.0 "on a night shift" (from 00:30)' },
		]);
		// Every night of one key into the next: said once, for the first
		expect(every({ busy: [shift], online: [late] })).toEqual([
			{ path: ['days', 'mon-sun', 'online', 0], message: 'runs until 01:00 tue, into days.mon-sun.busy.0 "on a night shift" (from 00:30)' },
		]);
	});

	it('refuses bad bounds, at the bound, and leaves those blocks out of the overlap checks', () => {
		expect(every({ online: [{ start: ['19:45', '20:30'], end: ['20:00', '21:00'] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'online', 0, 'end'], message: 'can end before it starts (start up to 20:30, end from 20:00)' },
		]);
		expect(every({ online: [{ start: ['20:30', '19:30'], end: ['23:00', '23:30'] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'online', 0, 'start'], message: 'a range of 23:00 hours: are earliest and latest swapped? (a latest before the earliest is the next day)' },
		]);
		expect(every({ busy: [{ ...work, start: ['04:00', '05:00'], end: ['23:00', '01:15'] }], online: [evening] })).toEqual([
			{ path: ['days', 'mon-sun', 'busy', 0, 'end'], message: 'lasts up to 21:15 hours (at most 20)' },
		]);
		expect(every({ breaks: [{ start: ['12:30', '12:30'], minutes: [20, 10] }] })).toEqual([
			{ path: ['days', 'mon-sun', 'breaks', 0, 'minutes'], message: 'the first number must not be above the second' },
		]);
	});

	it('accepts a break inside a busy block\'s core, blocks that touch, and a day with nothing', () => {
		expect(every({ busy: [work], breaks: [{ start: ['09:00', '12:00'], minutes: [10, 30] }], online: [{ start: ['17:45', '18:00'], end: ['23:00', '23:30'] }] })).toEqual([]);
		expect(problems({ 'mon-sat': { online: [evening] }, sun: {} })).toEqual([]);
		// The design's example: day groups, breaks with on and chance, several ranges a day, both midnight crossings
		expect(problems({
			'mon-thu': {
				busy: [work, { reason: 'at the gym', start: ['18:00', '18:15'], end: ['19:00', '19:15'], chance: 0.4 }],
				breaks: [{ start: ['10:30', '11:00'], minutes: [5, 10], chance: 0.6 }, { start: ['12:30', '12:45'], minutes: [10, 20], chance: 0.9, on: ['forum'] }],
				online: [evening],
			},
			fri: {
				busy: [{ ...work, end: ['16:00', '16:30'] }, { reason: 'at an evening class', start: ['18:00', '18:00'], end: ['19:30', '19:30'], chance: 0.5 }],
				breaks: [{ start: ['12:30', '12:45'], minutes: [10, 20] }],
				online: [{ start: ['20:30', '21:00'], end: ['01:30', '02:00'] }],
			},
			'sat,sun': {
				skipDayChance: 0.2,
				busy: [
					{ reason: 'running errands', start: ['13:30', '14:00'], end: ['15:00', '16:00'], chance: 0.7 },
					{ reason: 'out with friends', start: ['18:00', '19:00'], end: ['21:30', '22:00'], chance: 0.5 },
				],
				online: [
					{ start: ['10:30', '11:30'], end: ['12:30', '13:15'] },
					{ start: ['16:15', '16:45'], end: ['17:30', '17:50'], on: ['chat'] },
					{ start: ['23:30', '00:30'], end: ['02:30', '03:30'] },
				],
			},
		})).toEqual([]);
	});
});

describe('onlineMinutesByWeekday', () => {
	it('adds the middle of every online range and break of each weekday', () => {
		expect(onlineMinutesByWeekday(scheduleOfWindow({ start: ['19:00', '20:00'], end: ['01:00', '02:00'], skipDayChance: 0 }))).toEqual(Array(7).fill(360));
		// 20:00 to 00:15 and the 15-minute break on weekdays
		expect(onlineMinutesByWeekday(LENA.schedule)).toEqual([270, 270, 270, 270, 270, 0, 0]);
	});
});
