import { describe, expect, it } from 'vitest';
import { deepMerge, diffPaths } from '../src/merge.js';

describe('deepMerge', () => {
	it("doesn't change its inputs", () => {
		const base = { pacing: { quickSeconds: [4, 45], splitChance: 0.35 } };
		const over = { pacing: { splitChance: 0.1 } };
		const copies = JSON.stringify([base, over]);
		deepMerge(base, over);
		expect(JSON.stringify([base, over])).toBe(copies);
	});

	it('merges objects key by key; arrays replace; null removes; undefined keeps the base', () => {
		const base = { pacing: { quickSeconds: [4, 45], splitChance: 0.35 }, memory: { personNotes: 280 } };
		expect(deepMerge(base, { pacing: { quickSeconds: [1] } })).toEqual({ pacing: { quickSeconds: [1], splitChance: 0.35 }, memory: { personNotes: 280 } });
		expect(deepMerge(base, { memory: null })).toEqual({ pacing: base.pacing });
		expect(deepMerge(base, { pacing: { splitChance: null } })).toEqual({ pacing: { quickSeconds: [4, 45] }, memory: { personNotes: 280 } });
		expect(deepMerge(undefined, { a: null, b: 1 })).toEqual({ b: 1 });
		expect(deepMerge(base, { memory: undefined })).toEqual(base);
		expect(deepMerge(base, undefined)).toBe(base);
		expect(deepMerge(undefined, { a: 1 })).toEqual({ a: 1 });
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
