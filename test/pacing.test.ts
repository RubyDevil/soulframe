import { describe, expect, it, vi } from 'vitest';
import { betweenMessagesMs, drawIn, fitDelay, glanceMs, interruptionAt, interruptionsOn, normalQuantile, quietMs, readingMs, replyDelay, skewedMs, splitReply, typingMs, typingPlan, watchingChance, watchingMs } from '../src/pacing.js';
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
		// Log-normal by default: the middle draw is the geometric middle, √3 s
		expect(quietMs(() => 0.5, withSettle([1, 3]))).toBe(1_732);
	});

	it('is 0 without a draw when there is no quiet', () => {
		const rng = vi.fn(() => 0.5);
		expect(quietMs(rng, withSettle([0, 0]))).toBe(0);
		expect(rng).not.toHaveBeenCalled();
	});

	it('refuses a burst setting it does not know, and maxRestarts below 1', () => {
		expect(SettingsSchema.safeParse({ pacing: { burst: { settle: [1, 2] } } }).success).toBe(false);
		expect(SettingsSchema.safeParse({ pacing: { burst: { maxRestarts: 0 } } }).success).toBe(false);
		expect(DEFAULT_SETTINGS.pacing.burst).toEqual({ settleSeconds: { range: [2, 5], shape: 'lognormal' }, maxSettleResets: 3, restartOnNewMessage: true, maxRestarts: 1 });
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
		const pacing = pausing({ chance: 1, max: 2, seconds: { range: [1, 1], shape: 'lognormal' } });
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
		expect(DEFAULT_SETTINGS.pacing).toMatchObject({
			readingCharsPerSecond: { range: [15, 25], shape: 'normal' },
			readingDurationSeconds: [1, 20],
			thinkingPauses: { chance: 0, minChars: 120, max: 2, seconds: { range: [2, 6], shape: 'lognormal' } },
		});
		expect(() => SettingsSchema.parse({ pacing: { thinkingPauses: { chanse: 0.2 } } })).toThrow();
		expect(() => SettingsSchema.parse({ pacing: { thinkingPauses: { max: 4 } } })).toThrow();
		expect(() => SettingsSchema.parse({ pacing: { readingCharsPerSecond: [25, 15] } })).toThrow();
	});
});

describe('replyDelay', () => {
	it('is the time until it next glances at its messages without a turn to go by: skewed around 40 s, never under 4 s or over 15 min', () => {
		const rng = seededRng('delays');
		const delays = Array.from({ length: 4000 }, () => replyDelay(rng, null));
		expect(delays.every((delay) => !delay.watching)).toBe(true);
		const share = (under: number) => delays.filter((delay) => delay.ms < under).length / delays.length;
		// Half within the median, nine in ten within the 90th percentile, a few over five minutes
		expect(share(40_000)).toBeGreaterThan(0.47);
		expect(share(40_000)).toBeLessThan(0.53);
		expect(share(150_000)).toBeGreaterThan(0.88);
		expect(share(150_000)).toBeLessThan(0.92);
		expect(share(5 * 60_000)).toBeLessThan(0.99);
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
			expect(delay.ms).toBeLessThanOrEqual(20_000);
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

describe('watchingChance, skewedMs, watchingMs and glanceMs', () => {
	const pacing = (settings: Record<string, unknown>) => SettingsSchema.parse({ pacing: settings }).pacing;

	it('halves the chance that it still watches every halfLifeSeconds', () => {
		expect([0, 90_000, 180_000].map((ms) => watchingChance(ms))).toEqual([1, 0.5, 0.25]);
		expect(watchingChance(10_000, pacing({ watching: { halfLifeSeconds: 10 } }))).toBe(0.5);
	});

	it('draws a log-normal: the median at the middle draw, the 90th percentile at 0.9, the bounds at the ends', () => {
		const shape = { medianSeconds: 40, p90Seconds: 150, delaySeconds: [4, 900] as const };
		expect(skewedMs(() => 0.5, shape)).toBe(40_000);
		expect(skewedMs(() => 0.9, shape)).toBe(150_000);
		expect(skewedMs(() => 0, shape)).toBe(4_000);
		expect(skewedMs(() => 0.999999, shape)).toBe(900_000);
		expect([0.001, 0.025, 0.5, 0.975].map((p) => Number(normalQuantile(p).toFixed(4)))).toEqual([-3.0902, -1.96, 0, 1.96]);
	});

	it('gives whole milliseconds within their bounds', () => {
		const rng = seededRng('ranges');
		const own = pacing({ watching: { medianSeconds: 2, p90Seconds: 3, delaySeconds: [1, 3] }, glance: { medianSeconds: 20, p90Seconds: 30, delaySeconds: [10, 40] } });
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

	it('refuses a 90th percentile not above the median', () => {
		expect(SettingsSchema.safeParse({ pacing: { glance: { medianSeconds: 60, p90Seconds: 60 } } }).success).toBe(false);
		expect(SettingsSchema.safeParse({ pacing: { watching: { medianSeconds: 9 } } }).success).toBe(false);
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

	it('say which one is scheduled at a moment', () => {
		const [first] = interruptionsOn(persona, day, often);
		expect(interruptionAt(persona, first!.start, often)).toEqual(first);
		expect(interruptionAt(persona, first!.end, often)).not.toEqual(first);
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

describe('drawIn and the shapes of drawn ranges', () => {
	const shares = (shape: 'uniform' | 'normal' | 'lognormal', range: [number, number] = [10, 30]) => {
		const rng = seededRng(`shape-${shape}`);
		const values = Array.from({ length: 8000 }, () => drawIn(rng, { range, shape }));
		const inMiddle = values.filter((v) => v >= 15 && v <= 25).length / values.length;
		return { values, inMiddle, median: [...values].sort((a, b) => a - b)[4000]! };
	};

	it('keeps every draw within the range, the least at 0 and the most at the top, in every shape', () => {
		for (const shape of ['uniform', 'normal', 'lognormal'] as const) {
			const { values } = shares(shape);
			expect(Math.min(...values)).toBeGreaterThanOrEqual(10);
			expect(Math.max(...values)).toBeLessThanOrEqual(30);
			expect(drawIn(() => 0, { range: [10, 30], shape })).toBe(10);
			expect(drawIn(() => 0.9999999, { range: [10, 30], shape })).toBeCloseTo(30, 3);
			expect(drawIn(() => 0.5, { range: [7, 7], shape })).toBe(7);
		}
	});

	it('spreads uniform evenly, normal around the middle, lognormal around the geometric middle', () => {
		// The middle half of the range holds half the uniform draws, 95% of the normal ones (two standard deviations)
		expect(shares('uniform').inMiddle).toBeCloseTo(0.5, 1);
		expect(shares('normal').inMiddle).toBeGreaterThan(0.65);
		expect(shares('normal').median).toBeCloseTo(20, 0);
		expect(shares('lognormal').median).toBeCloseTo(Math.sqrt(10 * 30), 0);
		// From 0: its median at the geometric middle of a tenth of the most and the most
		expect(shares('lognormal', [0, 10]).median).toBeCloseTo(Math.sqrt(10), 0);
	});

	it('reads [least, most] with the setting\'s own shape, and { range, shape } as written', () => {
		const parsed = (value: unknown) => SettingsSchema.parse({ pacing: { backlogGapSeconds: value } }).pacing.backlogGapSeconds;
		expect(parsed([10, 20])).toEqual({ range: [10, 20], shape: 'lognormal' });
		expect(parsed({ range: [10, 20], shape: 'uniform' })).toEqual({ range: [10, 20], shape: 'uniform' });
		expect(parsed({ range: [10, 20] })).toEqual({ range: [10, 20], shape: 'lognormal' });
		expect(DEFAULT_SETTINGS.pacing.typingCharsPerSecond).toEqual({ range: [3.5, 7], shape: 'normal' });
		expect(DEFAULT_SETTINGS.retries.delayMinutes).toEqual({ range: [1, 4], shape: 'uniform' });
		for (const bad of [{ range: [20, 10] }, { range: [10, 20], shape: 'gaussian' }, { range: [10, 20], spread: 2 }]) {
			expect(SettingsSchema.safeParse({ pacing: { backlogGapSeconds: bad } }).success).toBe(false);
		}
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
