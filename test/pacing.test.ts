import { describe, expect, it, vi } from 'vitest';
import { betweenMessagesMs, fitDelay, glanceMs, interruptedBetween, interruptionAt, interruptionsOn, quietMs, readingMs, replyDelay, splitReply, typingMs, typingPlan, watchingChance, watchingMs } from '../src/pacing.js';
import { seededRng } from '../src/rng.js';
import { ScheduleSchema } from '../src/config/hours.js';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '../src/settings.js';

describe('millisecond durations', () => {
	it('returns whole milliseconds for replies, typing and pauses', () => {
		const rng = seededRng('whole-milliseconds');
		for (let sample = 0; sample < 200; sample++) {
			expect(Number.isInteger(replyDelay(rng, null).ms)).toBe(true);
			expect(Number.isInteger(replyDelay(rng, 30_000).ms)).toBe(true);
			expect(Number.isInteger(typingMs('A message long enough to avoid the minimum typing duration.', rng))).toBe(true);
			expect(Number.isInteger(betweenMessagesMs(rng))).toBe(true);
		}
	});
});

describe('quietMs', () => {
	const withSettle = (settleSeconds: [number, number]) => SettingsSchema.parse({ pacing: { burst: { settleSeconds } } }).pacing;

	it('draws the quiet after their newest message within settleSeconds', () => {
		expect(quietMs(() => 0)).toBe(2_000);
		expect(quietMs(() => 0.5, withSettle([1, 3]))).toBe(2_000);
	});

	it('is 0 without a draw when there is no quiet', () => {
		const rng = vi.fn(() => 0.5);
		expect(quietMs(rng, withSettle([0, 0]))).toBe(0);
		expect(rng).not.toHaveBeenCalled();
	});

	it('refuses a burst setting it does not know, and maxRestarts below 1', () => {
		expect(SettingsSchema.safeParse({ pacing: { burst: { settle: [1, 2] } } }).success).toBe(false);
		expect(SettingsSchema.safeParse({ pacing: { burst: { maxRestarts: 0 } } }).success).toBe(false);
		expect(DEFAULT_SETTINGS.pacing.burst).toEqual({ settleSeconds: [2, 5], maxSettleResets: 3, restartOnNewMessage: true, maxRestarts: 1 });
	});
});

describe('typingMs', () => {
	it('grows with the message and stays within bounds', () => {
		const short = typingMs('hey', seededRng('a'));
		const long = typingMs('x'.repeat(200), seededRng('a'));
		expect(long).toBeGreaterThan(short);
		expect(short).toBeGreaterThanOrEqual(1_500);
		expect(typingMs('x'.repeat(5000), seededRng('a'))).toBe(45_000);
	});
});

describe('typingPlan', () => {
	const long = 'x'.repeat(200);
	const pausing = (thinkingPauses: Partial<Settings['pacing']['thinkingPauses']>): Settings['pacing'] => ({
		...DEFAULT_SETTINGS.pacing,
		thinkingPauses: { ...DEFAULT_SETTINGS.pacing.thinkingPauses, ...thinkingPauses },
	});

	it('is typingMs in one stretch by default, drawing nothing more', () => {
		const planned = seededRng('plan');
		const alone = seededRng('plan');
		expect(typingPlan(long, planned)).toEqual({ typing: [typingMs(long, alone)], pauses: [] });
		expect(planned()).toBe(alone());
	});

	it('cuts a long message into equal stretches around its pauses, the typing time unchanged', () => {
		const pacing = pausing({ chance: 1, max: 2, seconds: [1, 1] });
		const { typing, pauses } = typingPlan(long, seededRng('p'), pacing);
		expect(pauses).toEqual([1_000, 1_000]);
		expect(typing).toHaveLength(3);
		expect(typing.reduce((sum, ms) => sum + ms)).toBe(typingMs(long, seededRng('p'), pacing));
		expect(Math.max(...typing) - Math.min(...typing)).toBeLessThanOrEqual(2);
	});

	it('pauses no message under minChars, and each pause only by its chance', () => {
		const pacing = pausing({ chance: 0.5, minChars: 150, max: 3 });
		expect(typingPlan('x'.repeat(149), () => 0, pacing).pauses).toEqual([]);
		expect(typingPlan(long, () => 0.4, pacing).pauses).toHaveLength(3);
		expect(typingPlan(long, () => 0.6, pacing).pauses).toEqual([]);
	});
});

describe('readingMs', () => {
	it('is proportional to the length, within readingDurationSeconds', () => {
		// 25 characters a second at the top of the range, 15 at the bottom
		expect(readingMs(300, () => 1)).toBe(12_000);
		expect(readingMs(300, () => 0)).toBe(20_000);
		expect(readingMs(5, () => 0)).toBe(1_000);
		expect(readingMs(5_000, () => 0)).toBe(20_000);
	});
	it('gives whole milliseconds, and nothing without a draw when there is nothing to read', () => {
		const rng = vi.fn(seededRng('read'));
		for (let sample = 0; sample < 100; sample++) expect(Number.isInteger(readingMs(1 + sample * 7, rng))).toBe(true);
		const draws = rng.mock.calls.length;
		expect(readingMs(0, rng)).toBe(0);
		expect(rng).toHaveBeenCalledTimes(draws);
	});
});

describe('the typing settings', () => {
	it('default to no thinking pause and a human reading speed, and refuse an unknown or out-of-range key', () => {
		expect(DEFAULT_SETTINGS.pacing).toMatchObject({ readingCharsPerSecond: [15, 25], readingDurationSeconds: [1, 20], thinkingPauses: { chance: 0, minChars: 120, max: 2, seconds: [2, 6] } });
		expect(() => SettingsSchema.parse({ pacing: { thinkingPauses: { chanse: 0.2 } } })).toThrow();
		expect(() => SettingsSchema.parse({ pacing: { thinkingPauses: { max: 4 } } })).toThrow();
		expect(() => SettingsSchema.parse({ pacing: { readingCharsPerSecond: [25, 15] } })).toThrow();
	});
});

describe('replyDelay', () => {
	it('is the time until it next glances at its messages without a turn to go by: mostly under a minute, never under 4 s or over 15 min', () => {
		const rng = seededRng('delays');
		const delays = Array.from({ length: 4000 }, () => replyDelay(rng, null));
		expect(delays.every((delay) => !delay.watching)).toBe(true);
		const quick = delays.filter((delay) => delay.ms < 60_000).length / delays.length;
		// A memoryless clock with a 60 s mean: 1 - 1/e of them come within the minute
		expect(quick).toBeGreaterThan(0.58);
		expect(quick).toBeLessThan(0.68);
		expect(delays.some((delay) => delay.ms > 4 * 60_000)).toBe(true);
		expect(Math.min(...delays.map((delay) => delay.ms))).toBeGreaterThanOrEqual(4_000);
		expect(Math.max(...delays.map((delay) => delay.ms))).toBeLessThanOrEqual(15 * 60_000);
	});

	it('is a short lag while it is still watching their chat, likelier the sooner they answer', () => {
		const rng = seededRng('watching');
		const shareWatching = (sinceMs: number) => Array.from({ length: 4000 }, () => replyDelay(rng, sinceMs)).filter((delay) => delay.watching).length / 4000;
		expect(shareWatching(0)).toBe(1);
		expect(shareWatching(90_000)).toBeGreaterThan(0.45);
		expect(shareWatching(90_000)).toBeLessThan(0.55);
		expect(shareWatching(15 * 60_000)).toBeLessThan(0.01);
		for (let sample = 0; sample < 200; sample++) {
			const delay = replyDelay(rng, 0);
			expect(delay.ms).toBeGreaterThanOrEqual(2_000);
			expect(delay.ms).toBeLessThanOrEqual(10_000);
		}
	});

	it('draws the chance only with a turn to go by, then the delay', () => {
		const rng = vi.fn(() => 0);
		expect(replyDelay(rng, null)).toEqual({ ms: 4_000, watching: false });
		expect(rng).toHaveBeenCalledTimes(1);
		expect(replyDelay(rng, 10_000)).toEqual({ ms: 2_000, watching: true });
		expect(rng).toHaveBeenCalledTimes(3);
	});
});

describe('watchingChance, watchingMs and glanceMs', () => {
	const pacing = (settings: Record<string, unknown>) => SettingsSchema.parse({ pacing: settings }).pacing;

	it('halves the chance that it still watches every halfLifeSeconds', () => {
		expect([0, 90_000, 180_000].map((ms) => watchingChance(ms))).toEqual([1, 0.5, 0.25]);
		expect(watchingChance(10_000, pacing({ watching: { halfLifeSeconds: 10 } }))).toBe(0.5);
	});

	it('gives whole milliseconds within their ranges', () => {
		const rng = seededRng('ranges');
		const own = pacing({ watching: { replyDelaySeconds: [1, 3] }, glance: { meanSeconds: 30, delaySeconds: [10, 40] } });
		for (let sample = 0; sample < 500; sample++) {
			const watching = watchingMs(rng, own);
			const glance = glanceMs(rng, own);
			expect(Number.isInteger(watching) && Number.isInteger(glance)).toBe(true);
			expect(watching).toBeGreaterThanOrEqual(1_000);
			expect(watching).toBeLessThanOrEqual(3_000);
			expect(glance).toBeGreaterThanOrEqual(10_000);
			expect(glance).toBeLessThanOrEqual(40_000);
		}
	});

	it('glances after meanSeconds on average', () => {
		const rng = seededRng('mean');
		const own = pacing({ glance: { meanSeconds: 100, delaySeconds: [0, 3600] } });
		const mean = Array.from({ length: 8000 }, () => glanceMs(rng, own)).reduce((sum, ms) => sum + ms, 0) / 8000;
		expect(mean).toBeGreaterThan(95_000);
		expect(mean).toBeLessThan(105_000);
	});
});

describe('interruptions', () => {
	// Online 19:00 to 23:00 UTC every day, with a 10-minute break at 12:30
	const persona = { id: 'robin', timezone: 'UTC', schedule: ScheduleSchema.parse({ days: { 'mon-sun': { online: [{ start: ['19:00', '19:00'], end: ['23:00', '23:00'] }], breaks: [{ start: ['12:30', '12:30'], minutes: [10, 10] }] } } }) };
	const day = { year: 2026, month: 10, day: 14 };
	const often = SettingsSchema.parse({ pacing: { interruptions: { meanMinutes: 20, minutes: [2, 8] } } }).pacing;

	it('come now and then inside its online time, never on a break, each 2 to 8 minutes, the same on every draw', () => {
		const found = interruptionsOn(persona, day, often);
		expect(found.length).toBeGreaterThan(0);
		expect(interruptionsOn(persona, day, often)).toEqual(found);
		for (const { start, end } of found) {
			expect(start).toBeGreaterThanOrEqual(Date.UTC(2026, 9, 14, 19));
			expect(end).toBeLessThanOrEqual(Date.UTC(2026, 9, 14, 23));
			expect(end - start).toBeLessThanOrEqual(8 * 60_000);
		}
		// One every 20 minutes of online time on average, over many days
		const days = Array.from({ length: 60 }, (_, i) => ({ year: 2026, month: 1 + Math.floor(i / 28), day: 1 + (i % 28) }));
		const perDay = days.reduce((sum, date) => sum + interruptionsOn(persona, date, often).length, 0) / days.length;
		expect(perDay).toBeGreaterThan(8);
		expect(perDay).toBeLessThan(11);
	});

	it('are none with meanMinutes 0', () => {
		const none = SettingsSchema.parse({ pacing: { interruptions: { meanMinutes: 0 } } }).pacing;
		expect(interruptionsOn(persona, day, none)).toEqual([]);
		expect(interruptionAt(persona, Date.UTC(2026, 9, 14, 20), none)).toBeNull();
	});

	it('say when it is away, and whether it was away in between', () => {
		const [first] = interruptionsOn(persona, day, often);
		expect(interruptionAt(persona, first!.start, often)).toEqual(first);
		expect(interruptionAt(persona, first!.end, often)).not.toEqual(first);
		expect(interruptedBetween(persona, first!.start - 1, first!.start, often)).toBe(true);
		expect(interruptedBetween(persona, first!.start, first!.end, often)).toBe(false);
	});
});

describe('fitDelay', () => {
	it('keeps a delay that fits, cuts one that does not, and gives null when not even the floor fits', () => {
		expect(fitDelay(30_000, 60_000, 4_000)).toBe(30_000);
		expect(fitDelay(90_000, 60_000, 4_000)).toBe(60_000);
		expect(fitDelay(30_000, 3_000, 4_000)).toBeNull();
		expect(fitDelay(30_000, -30_000, 4_000)).toBeNull();
	});
});

describe('splitReply', () => {
	it('sends the lines the model wrote apart, three at most', () => {
		expect(splitReply('one\n\ntwo\nthree\nfour', seededRng('x'))).toEqual(['one', 'two', 'three four']);
	});
	it('keeps a short reply whole', () => {
		expect(splitReply('just one short line', seededRng('x'))).toEqual(['just one short line']);
	});
	it('cuts a long reply at a sentence when it splits', () => {
		const text = 'This is the first sentence of a reply that runs long. And this is the second one, which ends it here.';
		const always = () => 0;
		expect(splitReply(text, always)).toEqual(['This is the first sentence of a reply that runs long.', 'And this is the second one, which ends it here.']);
	});
});
