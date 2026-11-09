import { describe, expect, it } from 'vitest';
import { deepMerge, diffPaths } from '../src/merge.js';

describe('deepMerge', () => {
	it('merges mappings key by key; a list, a range or any other value replaces; neither is changed', () => {
		const base = { pacing: { glance: { medianSeconds: 30, p90Seconds: 300 }, backlogGapSeconds: { range: [20, 90], shape: 'lognormal' } }, memory: { personNotes: 280 } };
		const over = { pacing: { glance: { medianSeconds: 60 }, backlogGapSeconds: [10, 40] } };
		const before = structuredClone(base);
		expect(deepMerge(base, over)).toEqual({ pacing: { glance: { medianSeconds: 60, p90Seconds: 300 }, backlogGapSeconds: [10, 40] }, memory: { personNotes: 280 } });
		expect(base).toEqual(before);
		// Nothing over it is the base; a mapping over a value that is none replaces it
		expect(deepMerge(base, undefined)).toBe(base);
		expect(deepMerge([1, 2], { a: 1 })).toEqual({ a: 1 });
	});
});

describe('diffPaths', () => {
	it('lists only the changed leaves, arrays compared whole', () => {
		const a = { pacing: { quickSeconds: [4, 45], splitChance: 0.35 }, memory: { personNotes: 280 }, retentionDays: 90 };
		const b = { pacing: { quickSeconds: [4, 60], splitChance: 0.35 }, memory: { personNotes: 50 }, retentionDays: 90 };
		expect(diffPaths(a, b)).toEqual(['pacing.quickSeconds', 'memory.personNotes']);
		expect(diffPaths(a, structuredClone(a))).toEqual([]);
	});
});
