import { describe, expect, it } from 'vitest';
import { ScheduleSchema } from '../src/config/hours.js';
import { moodOf } from '../src/mood.js';
import { seededRng, weightedPick } from '../src/rng.js';
import { scheduleOfWindow, zonedToUtc } from '../src/schedule.js';

const TZ = 'America/Toronto';
const persona = (
	moods: { mood: string; weight: number }[],
	// Always 20:00 to 02:00
	schedule = scheduleOfWindow({ start: ['20:00', '20:00'], end: ['02:00', '02:00'], skipDayChance: 0 }),
) => ({ id: 'robin', timezone: TZ, schedule, character: { facts: [], interests: [], boundaries: [], moods } });
const MOODS = ['chill', 'playful', 'curious', 'sleepy', 'chatty', 'dreamy'].map((mood) => ({ mood, weight: 1 }));
const at = (day: number, minutes: number) => zonedToUtc({ year: 2026, month: 10, day }, minutes, TZ);

describe('moodOf', () => {
	it('is the same for the same persona and night', () => {
		expect(moodOf(persona(MOODS), at(14, 21 * 60))).toBe(moodOf(persona(MOODS), at(14, 22 * 60)));
	});

	it('holds across local midnight within one window', () => {
		expect(moodOf(persona(MOODS), at(14, 23 * 60))).toBe(moodOf(persona(MOODS), at(15, 60)));
	});

	it("is the agenda day's: the same on a daytime break, before the evening and past midnight in it", () => {
		// A break at 10:30, then online from between 23:30 and 00:30: on 13 October that is 00:24 on the 14th, still the 13th's
		const schedule = ScheduleSchema.parse({ days: { 'mon-sun': { breaks: [{ start: ['10:30', '10:30'], minutes: [10, 10] }], online: [{ start: ['23:30', '00:30'], end: ['02:30', '02:30'] }] } } });
		expect([at(13, 10 * 60 + 35), at(13, 15 * 60), at(14, 2 * 60)].map((now) => moodOf(persona(MOODS, schedule), now))).toEqual(['sleepy', 'sleepy', 'sleepy']);
	});

	it('keeps the mood a window persona had before the agenda', () => {
		expect(moodOf(persona(MOODS), at(14, 21 * 60))).toBe('curious');
	});

	it('can differ on another night', () => {
		const moods = new Set(Array.from({ length: 14 }, (_, day) => moodOf(persona(MOODS), at(day + 1, 21 * 60))));
		expect(moods.size).toBeGreaterThan(1);
	});

	it('never picks a mood of weight 0', () => {
		const moods = [
			{ mood: 'never', weight: 0 },
			{ mood: 'always', weight: 1 },
		];
		for (let day = 1; day <= 20; day++) expect(moodOf(persona(moods), at(day, 21 * 60))).toBe('always');
	});

	it('is null without moods', () => {
		expect(moodOf(persona([]), at(14, 21 * 60))).toBeNull();
	});
});

describe('weightedPick', () => {
	it('picks by weight', () => {
		const items = [
			{ weight: 1, value: 'a' },
			{ weight: 3, value: 'b' },
		];
		expect(weightedPick(() => 0, items)).toBe('a');
		expect(weightedPick(() => 0.24, items)).toBe('a');
		expect(weightedPick(() => 0.26, items)).toBe('b');
		expect(weightedPick(() => 0.999, items)).toBe('b');
		const rng = seededRng('weights');
		const counts = { a: 0, b: 0 };
		for (let i = 0; i < 4000; i++) counts[weightedPick(rng, items) as 'a' | 'b']++;
		expect(counts.b / counts.a).toBeGreaterThan(2.5);
		expect(counts.b / counts.a).toBeLessThan(3.5);
	});

	it('gives undefined for an empty or all-zero list', () => {
		expect(weightedPick(() => 0.5, [])).toBeUndefined();
		expect(weightedPick(() => 0.5, [{ weight: 0, value: 'a' }])).toBeUndefined();
	});
});
