// Seeded property tests of the calendar: plans laid over the agenda (schedule.ts agendaOn) and the code's checks of the
// plans a model proposes (calendar.ts checkPlan), over random schedules, time zones (half-hour offsets and daylight
// saving changes among them), dates and events. Whatever the draw, what must hold is checked against what the code did.
// A failing seed is reproduced by running it alone: its number is in the test's name.
import { describe, expect, it } from 'vitest';
import { calendarHours, checkPlan, type PlanProposal } from '../src/calendar.js';
import { planReasonProblem, ScheduleSchema } from '../src/config/hours.js';
import { seededRng, type Rng } from '../src/rng.js';
import { addDays, agendaOn, localDateOf, onlineMinutesByWeekday, routineOn, spanAt, zonedToUtc, type CalendarEvent, type Hours, type LocalDate } from '../src/schedule.js';
import { DAY, MINUTE } from '../src/settings.js';
import { memoryStore, settingsOf } from './fixtures.js';

const ZONES = ['UTC', 'Europe/London', 'America/Toronto', 'Pacific/Auckland', 'Asia/Kolkata', 'America/St_Johns', 'Australia/Lord_Howe'];
// Days around daylight saving changes (Toronto, London, Auckland, Lord Howe in 2026), and ordinary ones
const DATES: LocalDate[] = [
	{ year: 2026, month: 3, day: 8 },
	{ year: 2026, month: 3, day: 29 },
	{ year: 2026, month: 4, day: 5 },
	{ year: 2026, month: 9, day: 27 },
	{ year: 2026, month: 10, day: 4 },
	{ year: 2026, month: 10, day: 25 },
	{ year: 2026, month: 11, day: 1 },
	{ year: 2026, month: 6, day: 17 },
	{ year: 2026, month: 12, day: 31 },
];
const SCHEDULES = [
	// The same evening every day
	{ days: { 'mon-sun': { online: [{ start: ['19:00', '20:00'], end: ['23:00', '23:30'] }] } } },
	// Work, a lunch break and evenings; weekends late, past midnight, a morning most weeks, on one channel only
	{
		skipDayChance: 0.1,
		days: {
			'mon-fri': {
				busy: [{ reason: 'at work', start: ['08:45', '09:15'], end: ['17:00', '17:30'] }],
				breaks: [{ start: ['12:15', '12:45'], minutes: [10, 20] }],
				online: [{ start: ['19:00', '20:00'], end: ['23:00', '00:30'] }],
			},
			'sat,sun': {
				online: [
					{ start: ['10:00', '11:00'], end: ['13:00', '14:00'], chance: 0.7, on: ['chat'] },
					{ start: ['20:00', '21:00'], end: ['00:30', '01:30'] },
				],
			},
		},
	},
	// A night shift until 8 AM, online before and after it
	{
		days: {
			'mon-sun': {
				busy: [{ reason: 'at work', start: ['22:00', '22:00'], end: ['08:00', '08:00'] }],
				online: [{ start: ['17:00', '17:30'], end: ['21:00', '21:30'] }],
			},
		},
	},
];
const REASONS = ['at the dentist', "at a friend's for dinner", 'out with friends', 'asleep', 'at school', 'chatting with them', 'x', 'at "the" gym', 'at the gym: [admin]'];

/** What the checks did across the seeds, for the test that they are not trivial. */
const outcomes = { added: 0, cancelled: 0, refused: new Set<string>() };

const keyOf = (day: LocalDate) => day.year * 10_000 + day.month * 100 + day.day;
const pick = <T>(rng: Rng, items: readonly T[]) => items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, from: number, to: number) => from + Math.floor(rng() * (to - from + 1));
const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** A persona of one of the schedules, in one of the zones. */
const personaOf = (rng: Rng, id: string): Hours => ({ id, timezone: pick(rng, ZONES), schedule: ScheduleSchema.parse(pick(rng, SCHEDULES)) });

/** Random events on the days around `date`: busy (some past midnight) and online (time made to chat). */
const eventsAround = (rng: Rng, date: LocalDate): CalendarEvent[] =>
	Array.from({ length: int(rng, 0, 6) }, (_, index) => {
		const day = addDays(date, int(rng, -1, 1));
		if (rng() < 0.5) {
			const from = int(rng, 7 * 60, 23 * 60);
			return { id: index + 1, kind: 'online', day, from, to: Math.min(24 * 60, from + int(rng, 15, 240)), what: '' };
		}
		const from = int(rng, 0, 23 * 60 + 45);
		return { id: index + 1, kind: 'busy', day, from, to: from + int(rng, 15, 600), what: pick(rng, REASONS.slice(0, 3)) };
	});

const withCalendar = (hours: Hours, events: readonly CalendarEvent[]): Hours => ({
	...hours,
	events: (from, to) => events.filter((event) => keyOf(event.day) >= keyOf(from) && keyOf(event.day) <= keyOf(to)),
});
const instantsOf = (event: CalendarEvent, timeZone: string) => ({ start: zonedToUtc(event.day, event.from, timeZone), end: zonedToUtc(event.day, event.to, timeZone) });

describe.each(Array.from({ length: 150 }, (_, seed) => seed))('plans over the agenda (seed %i)', (seed) => {
	it('never leaves online time in a busy plan, lists each busy plan once on its day, makes time made to chat online, and keeps the routine', () => {
		const rng = seededRng(`calendar-overlay-${seed}`);
		const persona = personaOf(rng, `p${seed}`);
		const date = pick(rng, DATES);
		const events = eventsAround(rng, date);
		const hours = withCalendar(persona, events);
		const agenda = agendaOn(hours, date);
		const { timezone } = persona;
		const busyEvents = events.filter((event) => event.kind === 'busy').map((event) => ({ event, ...instantsOf(event, timezone) }));

		// In order, each block real
		for (const blocks of [agenda.spans, agenda.busy]) {
			for (const [index, block] of blocks.entries()) {
				expect(block.end - block.start).toBeGreaterThanOrEqual(MINUTE);
				if (index) expect(block.start).toBeGreaterThanOrEqual(blocks[index - 1]!.start);
			}
		}
		// No span at all inside a busy plan, of its day or the days either side; no routine busy block either
		for (const busy of busyEvents) {
			for (const span of agenda.spans) expect(overlaps(span, busy), `span ${JSON.stringify(span)} in ${JSON.stringify(busy.event)}`).toBe(false);
			for (const block of agenda.busy.filter((block) => block.event === undefined)) expect(overlaps(block, busy)).toBe(false);
		}
		// Each busy plan of its day once, as itself
		for (const { event, start, end } of busyEvents.filter(({ event }) => keyOf(event.day) === keyOf(date))) {
			expect(agenda.busy.filter((block) => block.event === event.id)).toEqual([{ reason: event.what, start, end, day: date, event: event.id }]);
		}
		expect(agenda.busy.filter((block) => block.event !== undefined).every((block) => busyEvents.some(({ event }) => event.id === block.event))).toBe(true);
		// Time made to chat is online, for every channel, wherever no busy block is
		const allBusy = [...agendaOn(hours, addDays(date, -1)).busy, ...agenda.busy, ...busyEvents];
		for (const event of events.filter((event) => event.kind === 'online' && keyOf(event.day) === keyOf(date))) {
			const { start, end } = instantsOf(event, timezone);
			for (let at = start; at < end; at += 5 * MINUTE) {
				if (allBusy.some((block) => block.start <= at && at < block.end)) continue;
				expect(spanAt(hours, at, 'forum'), `online at ${new Date(at).toISOString()} for ${JSON.stringify(event)}`).not.toBeNull();
			}
		}
		// The routine as drawn, and the same day laid out afresh (no cache) as from the cache
		expect(routineOn(hours, date)).toEqual(agendaOn(persona, date));
		const fresh = withCalendar({ ...persona, schedule: ScheduleSchema.parse(JSON.parse(JSON.stringify(persona.schedule))) }, events);
		expect(agendaOn(fresh, date)).toEqual(agenda);
		expect(agendaOn(hours, date)).toEqual(agenda);
	});
});

describe.each(Array.from({ length: 60 }, (_, seed) => seed))('the checks of the plans a model proposes (seed %i)', (seed) => {
	it('keeps only plans within every guardrail, and refuses only for a reason that holds', () => {
		const rng = seededRng(`calendar-check-${seed}`);
		const persona = personaOf(rng, 'robin');
		const { timezone } = persona;
		const settings = settingsOf({ calendar: { enabled: true, plans: { perWeek: int(rng, 1, 6), maxDays: int(rng, 3, 30) }, makeTime: { perPersonDays: int(rng, 1, 7) } } }).calendar;
		let now = zonedToUtc(pick(rng, DATES), int(rng, 0, 1439), timezone);
		const store = memoryStore(() => now);
		const people = ['sam', 'kim', 'lee'].map((name) => store.createPerson('robin', 'chat', name, name).id);
		const hours = calendarHours(persona, store);
		const longest = (Math.max(...onlineMinutesByWeekday(persona.schedule)) + settings.makeTime.maxMinutes) * MINUTE;
		const onlineOn = (day: LocalDate) => agendaOn(hours, day).spans.filter((span) => span.kind === 'online').reduce((sum, span) => sum + span.end - span.start, 0);
		for (let step = 0; step < 40; step++) {
			now += int(rng, 0, 12) * 60 * MINUTE;
			const personId = pick(rng, people);
			const today = localDateOf(now, timezone);
			const roll = rng();
			const from = int(rng, 0, 1439);
			const proposal: PlanProposal =
				roll < 0.1
					? { cancel: int(rng, 0, step + 2) }
					: {
							day: rng() < 0.05 ? -1 : int(rng, 0, settings.plans.maxDays + 2),
							from: rng() < 0.03 ? '7pm' : clock(from),
							to: clock(from + int(rng, 5, roll < 0.55 ? 300 : 900)),
							...(roll < 0.55 ? { online: true as const } : { busy: pick(rng, REASONS) }),
						};
			const checked = checkPlan(proposal, { store, hours, settings, now, personId });
			if ('add' in checked) {
				const plan = checked.add;
				const block = { start: zonedToUtc(plan.day, plan.from, timezone), end: zonedToUtc(plan.day, plan.to, timezone) };
				const days = (Date.UTC(plan.day.year, plan.day.month - 1, plan.day.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY;
				expect(block.start).toBeGreaterThan(now);
				expect(days).toBeGreaterThanOrEqual(0);
				expect(days).toBeLessThanOrEqual(settings.plans.maxDays);
				expect(plan.to - plan.from).toBeGreaterThanOrEqual(15);
				if (plan.kind === 'online') {
					expect(plan.from).toBeGreaterThanOrEqual(7 * 60);
					expect(plan.to).toBeLessThanOrEqual(24 * 60);
					expect(plan.to - plan.from).toBeLessThanOrEqual(settings.makeTime.maxMinutes);
					// Over no busy block: its day's, nor one of the day before that runs into it
					for (const busy of [...agendaOn(hours, addDays(plan.day, -1)).busy, ...agendaOn(hours, plan.day).busy]) expect(overlaps(busy, block), JSON.stringify({ busy, plan })).toBe(false);
					expect(store.eventsMadeSince('robin', now - settings.makeTime.perPersonDays * DAY, { kind: 'online', personId })).toBe(0);
				} else {
					expect(planReasonProblem(plan.what!)).toBeNull();
					expect(plan.to - plan.from).toBeLessThanOrEqual(settings.plans.maxHours * 60);
					for (const other of store.events('robin', addDays(plan.day, -1), addDays(plan.day, 1)).filter((event) => event.kind === 'busy')) {
						expect(overlaps(instantsOf(other, timezone), block)).toBe(false);
					}
					expect(store.eventsMadeSince('robin', now - 7 * DAY, { kind: 'busy' })).toBeLessThan(settings.plans.perWeek);
				}
				store.addEvent('robin', plan);
				outcomes.added++;
				if (plan.kind === 'online') expect(onlineOn(plan.day)).toBeLessThanOrEqual(longest);
			} else if ('cancel' in checked) {
				expect(checked.cancel.source).toBe('persona');
				expect(store.cancelEvent(checked.cancel.id)).toBe(true);
				outcomes.cancelled++;
			} else {
				outcomes.refused.add(checked.refused);
				// A refusal about the time it was for holds
				if (checked.refused === 'busy' && checked.block) {
					const plan = proposal as { day: number };
					const day = addDays(today, plan.day);
					expect([...agendaOn(hours, addDays(day, -1)).busy, ...agendaOn(hours, day).busy].some((busy) => overlaps(busy, checked.block!))).toBe(true);
				}
				if (checked.refused === 'past') expect(checked.block!.start).toBeLessThanOrEqual(now);
			}
		}
	});
});

describe('the property tests themselves', () => {
	it('are not trivial: across the seeds plans are added, called off, and refused for every kind of reason', () => {
		expect(outcomes.added).toBeGreaterThan(100);
		expect(outcomes.cancelled).toBeGreaterThan(5);
		for (const reason of ['busy', 'night', 'too_long', 'too_soon', 'past', 'day', 'too_far', 'times', 'clash', 'week_cap', 'reason_sleep', 'reason_online', 'reason_characters', 'no_such_plan']) {
			expect([...outcomes.refused], reason).toContain(reason);
		}
	});
});
