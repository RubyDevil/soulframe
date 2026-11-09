/**
 * The timers a reply queue waits with, and a clock whose waits are skipped. A queue waits seconds to minutes at each
 * step of a turn, as a person would; on a step clock those waits take no real time, while its clock still reads as if
 * they had passed. A conversation hours long then runs in about the time its model calls take, every timestamp as
 * it would have been.
 */
// The module's own, never a test's fake one: a step clock settles on the real event loop whatever the globals are
import { setImmediate } from 'node:timers';

/** The timers a runtime waits with (`Runtime.timers`): the system's unless replaced, by a step clock's say. A timer is opaque: only handed back to clear it. */
export interface Timers {
	setTimeout(callback: () => void, ms: number): unknown;
	/** Clears a timer `setTimeout` answered: nothing for `undefined`, or for one that ran. */
	clearTimeout(timer: unknown): void;
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(timer: unknown): void;
}

/** The system's timers: what a runtime waits with unless given others. */
export const systemTimers: Timers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout | undefined),
	setInterval: (callback, ms) => setInterval(callback, ms),
	clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout | undefined),
};

/** Resolves after `ms` on `timers`. */
export const waitOn = (timers: Timers, ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms));

/** A clock that only moves on as it is stepped, past the waits, from the real time: see `createStepClock`. */
export interface StepClock {
	/** The time it reads: the real clock's, plus every wait skipped so far (from `start`, when given). */
	now: () => number;
	/** Timers that never fire on their own: each runs as it is stepped to, the clock moved forward to when it was due. */
	timers: Timers;
	/** Marks `work` as real work under way (a model call): no wait is skipped until it settles. Answers `work`. */
	track<T>(work: Promise<T>): Promise<T>;
	/** Resolves once no tracked work is under way and everything it set off has run as far as it can without a timer. */
	settle(): Promise<void>;
	/** Settles, runs the timer due first (the clock moved forward to it if it is due later), and settles again. Answers whether one ran. */
	step(): Promise<boolean>;
	/**
	 * Steps until `done()` holds, until the next timer is due after `until` (the clock then reads `until`), or until none
	 * is left, and answers which.
	 */
	run(options?: { until?: number; done?: () => boolean }): Promise<'done' | 'until' | 'idle'>;
	/** How many timers are set (not run, not cleared); an interval counts until it is cleared. */
	pending(): number;
	/** The waits skipped so far, in ms. */
	skipped(): number;
}

interface StepTimer {
	readonly id: number;
	due: number;
	/** When it was set or, for an interval, last set again: of timers due together, the first set runs first. */
	order: number;
	readonly callback: () => void;
	/** An interval's period, in ms. */
	readonly every?: number;
}

/** A delay as the system's timers read one: a negative or invalid delay is none. */
const delayOf = (ms: number) => (Number.isFinite(ms) && ms > 0 ? ms : 0);

/**
 * A clock for running a reply queue (or any code on `Runtime.timers`) without waiting: give its `now` and `timers` to
 * the runtime, wrap every real call (the model, the Decisions client) in `track`, and `run` it. It reads the real clock
 * (`now`, `Date.now` by default) plus the waits skipped so far, so real time spent on tracked work counts too: a model
 * that takes 4 seconds to answer took 4 seconds of the persona's reading time, as it would live. `start` moves the
 * clock to that time first (an evening, when the personas are online). Timers due at the same time run in the order
 * they were set. Nothing is skipped while tracked work is under way, so a turn's reading or typing never ends before
 * its model answered.
 */
export function createStepClock({ now: real = Date.now, start }: { now?: () => number; start?: number } = {}): StepClock {
	let offset = start === undefined ? 0 : start - real();
	let skipped = 0;
	let nextId = 1;
	let nextOrder = 0;
	const timers = new Map<number, StepTimer>();
	const inFlight = new Set<Promise<unknown>>();
	const now = () => real() + offset;

	const set = (callback: () => void, ms: number, every?: number) => {
		const id = nextId++;
		timers.set(id, { id, due: now() + delayOf(ms), order: nextOrder++, callback, ...(every !== undefined && { every }) });
		return id;
	};
	const clear = (timer: unknown) => {
		if (typeof timer === 'number') timers.delete(timer);
	};
	/** The timer due first; of those due together, the first set. */
	const first = () => {
		let found: StepTimer | undefined;
		for (const timer of timers.values()) if (!found || timer.due < found.due || (timer.due === found.due && timer.order < found.order)) found = timer;
		return found;
	};
	/** Moves the clock forward to `at` (never back), counting the skip. */
	const moveTo = (at: number) => {
		const ahead = at - now();
		if (ahead <= 0) return;
		offset += ahead;
		skipped += ahead;
	};
	const fire = (timer: StepTimer) => {
		moveTo(timer.due);
		// An interval comes again a period after it ran; a timeout is done
		if (timer.every !== undefined) Object.assign(timer, { due: now() + timer.every, order: nextOrder++ });
		else timers.delete(timer.id);
		timer.callback();
	};
	/** A turn of the real event loop (node:timers', which fake timers leave alone): every promise that can resolve without a timer has, by then. */
	const events = () => new Promise<void>((resolve) => setImmediate(resolve));
	const settle = async () => {
		for (;;) {
			await events();
			if (!inFlight.size) return;
			await Promise.allSettled(inFlight);
		}
	};

	return {
		now,
		timers: {
			setTimeout: (callback, ms) => set(callback, ms),
			clearTimeout: clear,
			// At least a millisecond apart: an interval of 0 would never let the clock move
			setInterval: (callback, ms) => set(callback, Math.max(1, delayOf(ms)), Math.max(1, delayOf(ms))),
			clearInterval: clear,
		},
		track(work) {
			inFlight.add(work);
			const done = () => inFlight.delete(work);
			work.then(done, done);
			return work;
		},
		settle,
		async step() {
			await settle();
			const timer = first();
			if (!timer) return false;
			fire(timer);
			await settle();
			return true;
		},
		async run({ until = Infinity, done = () => false } = {}) {
			for (;;) {
				await settle();
				if (done()) return 'done';
				const timer = first();
				if (!timer) return 'idle';
				if (timer.due > until) {
					moveTo(until);
					return 'until';
				}
				fire(timer);
			}
		},
		pending: () => timers.size,
		skipped: () => skipped,
	};
}
