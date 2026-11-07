import { describe, expect, it, vi } from 'vitest';
import { betweenMessagesMs, fitDelay, quickReplyMs, readingMs, replyDelayMs, splitReply, typingMs, typingPlan } from '../src/pacing.js';
import { seededRng } from '../src/rng.js';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '../src/settings.js';

describe('millisecond durations', () => {
	it('returns whole milliseconds for replies, typing and pauses', () => {
		const rng = seededRng('whole-milliseconds');
		for (let sample = 0; sample < 200; sample++) {
			expect(Number.isInteger(replyDelayMs(rng))).toBe(true);
			expect(Number.isInteger(typingMs('A message long enough to avoid the minimum typing duration.', rng))).toBe(true);
			expect(Number.isInteger(betweenMessagesMs(rng))).toBe(true);
		}
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

describe('replyDelayMs', () => {
	it('is mostly under a minute, sometimes minutes, never over 15', () => {
		const rng = seededRng('delays');
		const delays = Array.from({ length: 2000 }, () => replyDelayMs(rng));
		const quick = delays.filter((d) => d < 60_000).length / delays.length;
		expect(quick).toBeGreaterThan(0.55);
		expect(quick).toBeLessThan(0.75);
		expect(delays.some((d) => d > 5 * 60_000)).toBe(true);
		expect(Math.max(...delays)).toBeLessThanOrEqual(15 * 60_000);
	});
});

describe('quickReplyMs', () => {
	it('gives whole milliseconds within quickReplyDelaySeconds', () => {
		const rng = seededRng('quick');
		const pacing = { ...DEFAULT_SETTINGS.pacing, quickReplyDelaySeconds: [10, 20] as [number, number] };
		for (let sample = 0; sample < 200; sample++) {
			const delay = quickReplyMs(rng, pacing);
			expect(Number.isInteger(delay)).toBe(true);
			expect(delay).toBeGreaterThanOrEqual(10_000);
			expect(delay).toBeLessThanOrEqual(20_000);
		}
	});

	it("is replyDelayMs's quick branch, with the same draws", () => {
		const quick = { ...DEFAULT_SETTINGS.pacing, quickReplyChance: 1, slowReplyChance: 0 };
		const draws = seededRng('same');
		draws();
		expect(replyDelayMs(seededRng('same'), quick)).toBe(quickReplyMs(draws, quick));
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
