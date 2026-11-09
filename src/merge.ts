/**
 * Merging config values (a persona's own settings over its brain's): plain objects merge key by key; arrays
 * ([least, most] ranges, lists) and scalars replace; `null` for a key removes what was set there, back to the schema's
 * default (or none).
 */
export const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `over` on top of `base`, neither changed. `undefined` keeps the base; a key set to `null` is removed. */
export function deepMerge(base: unknown, over: unknown): unknown {
	if (over === undefined) return base;
	if (!isPlainObject(over)) return over;
	const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
	for (const [key, value] of Object.entries(over)) {
		if (value === null) delete out[key];
		else out[key] = deepMerge(out[key], value);
	}
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
