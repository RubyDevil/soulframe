/**
 * Small helpers on plain config values (parsed YAML or JSON): telling a mapping from the rest, merging one over
 * another, reading the value at a path, and the paths where two values differ.
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `over` on top of `base`, neither changed: plain objects merge key by key; a list, a `[least, most]` range or any other value replaces. */
export function deepMerge(base: unknown, over: unknown): unknown {
	if (over === undefined) return base;
	if (!isPlainObject(over) || !isPlainObject(base)) return over;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(over)) out[key] = deepMerge(base[key], value);
	return out;
}

/** Dotted paths where `b` differs from `a` (leaves and arrays compared whole), e.g. 'pacing.watching.halfLifeSeconds'. */
export function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
	if (isPlainObject(a) && isPlainObject(b)) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
		return keys.flatMap((key) => diffPaths(a[key], b[key], prefix ? `${prefix}.${key}` : key));
	}
	return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}

/** The value at `path` in `value`, or undefined. */
export function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
	let at = value;
	for (const key of path) {
		if (Array.isArray(at) && typeof key === 'number') at = at[key];
		else if (isPlainObject(at)) at = at[key];
		else return undefined;
	}
	return at;
}
