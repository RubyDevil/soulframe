import { describe, expect, it } from 'vitest';
import { seededRng, weightedPick } from '../src/rng.js';

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
