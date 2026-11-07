/** A source of numbers in [0, 1). Injected everywhere randomness is used, so tests can fix it. */
export type Rng = () => number;

/** A repeatable source seeded by a string (xmur3 hash into mulberry32). */
export function seededRng(seed: string): Rng {
	let h = 1779033703 ^ seed.length;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	let state = h >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export const between = (rng: Rng, min: number, max: number) => min + rng() * (max - min);

export const pick = <T>(rng: Rng, items: readonly T[]): T | undefined => items[Math.floor(rng() * items.length)];

/** One of `items` by weight (undefined when none has weight). */
export function weightedPick<T>(rng: Rng, items: readonly { weight: number; value: T }[]): T | undefined {
	const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
	if (total <= 0) return undefined;
	let left = rng() * total;
	for (const item of items) {
		if (item.weight <= 0) continue;
		left -= item.weight;
		if (left < 0) return item.value;
	}
	// Rounding: the last item with weight
	return items.findLast((item) => item.weight > 0)?.value;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
