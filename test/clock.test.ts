import { describe, expect, it, vi } from 'vitest';
import { createStepClock, systemTimers, waitOn } from '../src/clock.js';

const T0 = Date.UTC(2026, 9, 15, 20, 0);

/** A promise and the means to settle it from outside. */
const deferred = <T = void>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

describe('systemTimers', () => {
	it('waits with the system timers, read as each is called (fake timers apply)', async () => {
		vi.useFakeTimers();
		try {
			let fired = 0;
			systemTimers.setTimeout(() => fired++, 1000);
			const cleared = systemTimers.setTimeout(() => fired++, 1000);
			systemTimers.clearTimeout(cleared);
			systemTimers.clearTimeout(undefined);
			const every = systemTimers.setInterval(() => fired++, 400);
			await vi.advanceTimersByTimeAsync(1000);
			expect(fired).toBe(3);
			systemTimers.clearInterval(every);
			await vi.advanceTimersByTimeAsync(1000);
			expect(fired).toBe(3);
			const waited = waitOn(systemTimers, 50).then(() => 'waited');
			await vi.advanceTimersByTimeAsync(50);
			await expect(waited).resolves.toBe('waited');
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('createStepClock', () => {
	it('reads the real clock until stepped, from `start` when given', () => {
		let real = T0;
		const clock = createStepClock({ now: () => real });
		expect(clock.now()).toBe(T0);
		real += 250;
		expect(clock.now()).toBe(T0 + 250);
		const later = createStepClock({ now: () => real, start: T0 + 3_600_000 });
		expect(later.now()).toBe(T0 + 3_600_000);
		real += 100;
		expect(later.now()).toBe(T0 + 3_600_100);
		expect(later.skipped()).toBe(0);
	});

	it('skips a wait: the timer runs at once, the clock moved to when it was due', async () => {
		const clock = createStepClock({ now: () => T0 });
		const seen: number[] = [];
		clock.timers.setTimeout(() => seen.push(clock.now()), 90_000);
		expect(clock.pending()).toBe(1);
		const started = performance.now();
		expect(await clock.step()).toBe(true);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(seen).toEqual([T0 + 90_000]);
		expect(clock.skipped()).toBe(90_000);
		expect(clock.pending()).toBe(0);
		expect(await clock.step()).toBe(false);
	});

	it('runs timers by when they are due, those due together in the order they were set', async () => {
		const clock = createStepClock({ now: () => T0 });
		const order: string[] = [];
		clock.timers.setTimeout(() => order.push('c'), 3000);
		clock.timers.setTimeout(() => order.push('a'), 1000);
		clock.timers.setTimeout(() => order.push('b1'), 2000);
		clock.timers.setTimeout(() => order.push('b2'), 2000);
		// Negative and invalid delays are none, as the system's
		clock.timers.setTimeout(() => order.push('now'), -5);
		clock.timers.setTimeout(() => order.push('nan'), Number.NaN);
		expect(await clock.run()).toBe('idle');
		expect(order).toEqual(['now', 'nan', 'a', 'b1', 'b2', 'c']);
		expect(clock.now()).toBe(T0 + 3000);
	});

	it('never moves the clock back for a timer that came due while real time passed', async () => {
		let real = T0;
		const clock = createStepClock({ now: () => real });
		const seen: number[] = [];
		clock.timers.setTimeout(() => seen.push(clock.now()), 1000);
		real += 5000;
		await clock.step();
		expect(seen).toEqual([T0 + 5000]);
		expect(clock.skipped()).toBe(0);
	});

	it('runs what a timer sets, and nothing cleared', async () => {
		const clock = createStepClock({ now: () => T0 });
		const order: string[] = [];
		const dropped = clock.timers.setTimeout(() => order.push('cleared'), 500);
		clock.timers.setTimeout(() => {
			order.push('first');
			clock.timers.setTimeout(() => order.push('nested'), 1000);
		}, 1000);
		clock.timers.clearTimeout(dropped);
		clock.timers.clearTimeout(undefined);
		await clock.run();
		expect(order).toEqual(['first', 'nested']);
		expect(clock.now()).toBe(T0 + 2000);
	});

	it('repeats an interval a period after each run, until cleared', async () => {
		const clock = createStepClock({ now: () => T0 });
		const seen: number[] = [];
		const every = clock.timers.setInterval(() => seen.push(clock.now() - T0), 30_000);
		clock.timers.setTimeout(() => clock.timers.clearInterval(every), 100_000);
		expect(await clock.run()).toBe('idle');
		expect(seen).toEqual([30_000, 60_000, 90_000]);
	});

	it('runs a promise chain on its timers as it would on real ones (waitOn)', async () => {
		const clock = createStepClock({ now: () => T0 });
		const times: number[] = [];
		const chain = (async () => {
			for (const ms of [2000, 5000, 60_000]) {
				await waitOn(clock.timers, ms);
				times.push(clock.now() - T0);
			}
		})();
		expect(await clock.run()).toBe('idle');
		await chain;
		expect(times).toEqual([2000, 7000, 67_000]);
	});

	it('skips no wait while tracked work is under way, and runs what that work set off first', async () => {
		let real = T0;
		const clock = createStepClock({ now: () => real });
		const order: string[] = [];
		const model = deferred<string>();
		// A turn: it reads for 20 s while the model writes, then types for 10 s once it answered
		const turn = (async () => {
			const reading = waitOn(clock.timers, 20_000).then(() => order.push(`read at ${clock.now() - T0}`));
			const text = await clock.track(model.promise);
			order.push(`answered at ${clock.now() - T0}`);
			await reading;
			clock.timers.setTimeout(() => order.push(`sent ${text} at ${clock.now() - T0}`), 10_000);
		})();
		const running = clock.run();
		// The model takes 3 s of real time; the clock waits for it
		setTimeout(() => {
			real += 3000;
			model.resolve('hi');
		}, 20);
		expect(await running).toBe('idle');
		await turn;
		expect(order).toEqual(['answered at 3000', 'read at 20000', 'sent hi at 30000']);
		expect(clock.skipped()).toBe(27_000);
	});

	it('answers tracked work as it settles, a rejection included', async () => {
		const clock = createStepClock({ now: () => T0 });
		await expect(clock.track(Promise.resolve(42))).resolves.toBe(42);
		const failing = clock.track(Promise.reject(new Error('down')));
		await expect(failing).rejects.toThrow('down');
		await clock.settle();
		expect(await clock.step()).toBe(false);
	});

	it('stops at `until`, the clock then reading it, and once `done` holds', async () => {
		const clock = createStepClock({ now: () => T0 });
		let ticks = 0;
		clock.timers.setInterval(() => ticks++, 30_000);
		expect(await clock.run({ until: T0 + 100_000 })).toBe('until');
		expect(ticks).toBe(3);
		expect(clock.now()).toBe(T0 + 100_000);
		expect(await clock.run({ done: () => ticks >= 5 })).toBe('done');
		expect(ticks).toBe(5);
		expect(clock.now()).toBe(T0 + 150_000);
		expect(clock.pending()).toBe(1);
	});

	it('keeps an interval of 0 at least a millisecond apart', async () => {
		const clock = createStepClock({ now: () => T0 });
		let ticks = 0;
		clock.timers.setInterval(() => ticks++, 0);
		expect(await clock.run({ until: T0 + 5 })).toBe('until');
		expect(ticks).toBe(5);
	});
});

describe('createStepClock under fake timers', () => {
	it('still settles and steps: it waits on the real event loop, not the globals', async () => {
		vi.useFakeTimers();
		try {
			const clock = createStepClock({ now: () => T0 });
			const seen: number[] = [];
			clock.timers.setTimeout(() => seen.push(clock.now()), 60_000);
			await clock.track(Promise.resolve());
			expect(await clock.run()).toBe('idle');
			expect(seen).toEqual([T0 + 60_000]);
		} finally {
			vi.useRealTimers();
		}
	});
});
