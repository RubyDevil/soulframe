import { describe, expect, it } from 'vitest';
import { diffPaths } from '../src/merge.js';

describe('diffPaths', () => {
	it('lists only the changed leaves, arrays compared whole', () => {
		const a = { pacing: { quickSeconds: [4, 45], splitChance: 0.35 }, memory: { personNotes: 280 }, retentionDays: 90 };
		const b = { pacing: { quickSeconds: [4, 60], splitChance: 0.35 }, memory: { personNotes: 50 }, retentionDays: 90 };
		expect(diffPaths(a, b)).toEqual(['pacing.quickSeconds', 'memory.personNotes']);
		expect(diffPaths(a, structuredClone(a))).toEqual([]);
	});
});
