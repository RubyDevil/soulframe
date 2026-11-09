import { between, seededRng, type Rng } from './rng.js';
import { addDays, agendaOn, localDateOf, type Hours, type LocalDate } from './schedule.js';
import { DEFAULT_SETTINGS, MINUTE, SECOND, type Settings, type Shape } from './settings.js';

type Pacing = Settings['pacing'];

/** A drawn range of a setting (settings.ts `drawn`): its least and most, and the shape of its draws. */
export interface Drawn {
	range: readonly [number, number];
	shape: Shape;
}

/**
 * A value drawn from `range` with its `shape`, in the range's own unit, always within it, from one draw of `rng` (0 the
 * least, as close to 1 as it goes the most): `uniform` evenly; `normal` centred on the middle, a quarter of the range
 * per standard deviation (about 95% inside, the rest at the ends); `lognormal` with its median at the geometric middle
 * of the range (from a tenth of the most when the least is 0) and the same spread on a log scale, so most are near a
 * typical value and a few reach the most.
 */
export function drawIn(rng: Rng, { range: [least, most], shape }: Drawn): number {
	const u = rng();
	if (shape === 'uniform' || most <= least) return least + u * (most - least);
	const z = normalQuantile(u);
	const within = (value: number) => Math.min(most, Math.max(least, value));
	if (shape === 'normal') return within((least + most) / 2 + ((most - least) / 4) * z);
	const low = least > 0 ? least : most / 10;
	const median = Math.sqrt(low * most);
	return within(median * Math.exp((Math.log(most / median) / 1.959963984540054) * z));
}

/** Whole milliseconds drawn from a range of seconds. */
const msIn = (rng: Rng, spec: Drawn) => Math.round(drawIn(rng, spec) * SECOND);

/** A draw of a memoryless clock with this mean: most come soon, a few take a while (an exponential distribution). */
const memoryless = (rng: Rng, mean: number) => -Math.log(1 - rng()) * mean;

/**
 * The standard normal quantile of `p` (Acklam's rational approximation, relative error under 1.2e-9): the z with
 * probability `p` below it. -Infinity at 0, Infinity at 1.
 */
export function normalQuantile(p: number): number {
	if (p <= 0) return -Infinity;
	if (p >= 1) return Infinity;
	const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
	const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
	const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
	const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
	const tail = (q: number) => (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
	if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
	if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
	const q = p - 0.5;
	const r = q * q;
	return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** z of the 90th percentile of a normal distribution. */
const Z90 = 1.2815515655446004;

/**
 * Whole milliseconds drawn from a log-normal distribution (the shape of real answer times: a typical value and a long
 * tail) with this median and 90th percentile, in seconds, kept within `[least, most]`. One draw: 0 gives the least.
 */
export function skewedMs(rng: Rng, { medianSeconds, p90Seconds, delaySeconds: [least, most] }: { medianSeconds: number; p90Seconds: number; delaySeconds: readonly [number, number] }): number {
	const sigma = Math.log(p90Seconds / medianSeconds) / Z90;
	const seconds = medianSeconds * Math.exp(sigma * normalQuantile(rng()));
	return Math.round(Math.min(most, Math.max(least, seconds)) * SECOND);
}

/**
 * The chance that it is still on its phone `sinceMs` after its last turn with anyone: 1 at once, halving every
 * `watching.halfLifeSeconds` (or every `halfLifeSeconds` given, as `watching.chatHalfLifeSeconds` for one chat).
 */
export const watchingChance = (sinceMs: number, pacing: Pacing = DEFAULT_SETTINGS.pacing, halfLifeSeconds = pacing.watching.halfLifeSeconds) =>
	0.5 ** (Math.max(0, sinceMs) / (halfLifeSeconds * SECOND));

/** The lag before it answers while it is watching their chat (`watching`): the only delay on a short break. */
export const watchingMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => skewedMs(rng, pacing.watching);

/** The time until it next glances at its messages (`glance`): skewed, around `medianSeconds`, within `delaySeconds`. */
export const glanceMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => skewedMs(rng, pacing.glance);

/**
 * How long before it notices someone's message, and whether it was on its phone. `sinceMs`: how long ago its last turn
 * with anyone ended (0 while it writes one), or null when there was none (or it was away since). While it may still be
 * on its phone (`watchingChance`), a short lag; else the time until it next glances at its messages. Draws once for
 * the chance (with a turn to go by), then the delay.
 */
export function replyDelay(rng: Rng, sinceMs: number | null, pacing: Pacing = DEFAULT_SETTINGS.pacing): { ms: number; watching: boolean } {
	const watching = sinceMs !== null && rng() < watchingChance(sinceMs, pacing);
	return { ms: watching ? watchingMs(rng, pacing) : glanceMs(rng, pacing), watching };
}

/** A time something took the persona away from its messages, while online (`pacing.interruptions`). */
export interface Interruption {
	start: number;
	end: number;
}

/** The online time of a day: its online spans (not its breaks), the ones that overlap (on different channels) merged. */
const onlineTimeOf = (hours: Hours, date: LocalDate) => {
	const merged: { start: number; end: number }[] = [];
	for (const span of agendaOn(hours, date).spans.filter((span) => span.kind === 'online')) {
		const last = merged.at(-1);
		if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
		else merged.push({ start: span.start, end: span.end });
	}
	return merged;
};

/**
 * The interruptions of one agenda day (`pacing.interruptions`): inside its online time, on average one every
 * `meanMinutes` of it (a memoryless clock), each lasting `minutes`, never past the end of its span. Seeded by the
 * persona and the day, as its agenda is, so a restart finds the same ones; none with `meanMinutes` 0.
 */
export function interruptionsOn(hours: Hours, date: LocalDate, pacing: Pacing = DEFAULT_SETTINGS.pacing): Interruption[] {
	const { meanMinutes, minutes } = pacing.interruptions;
	if (meanMinutes <= 0) return [];
	const rng = seededRng(`${hours.id}:interruptions:${date.year}-${date.month}-${date.day}`);
	const found: Interruption[] = [];
	for (const online of onlineTimeOf(hours, date)) {
		for (let at = online.start + memoryless(rng, meanMinutes * MINUTE); at < online.end; ) {
			const end = Math.min(online.end, at + drawIn(rng, minutes) * MINUTE);
			found.push({ start: Math.round(at), end: Math.round(end) });
			at = end + memoryless(rng, meanMinutes * MINUTE);
		}
	}
	return found;
}

/** The interruptions of the agenda days around `at` (yesterday's, for a span past midnight, to tomorrow's). */
const interruptionsNear = (hours: Hours, at: number, pacing: Pacing) => {
	const today = localDateOf(at, hours.timezone);
	return [-1, 0, 1].flatMap((days) => interruptionsOn(hours, addDays(today, days), pacing));
};

/** The interruption the persona is in at `at`, else null. */
export const interruptionAt = (hours: Hours, at: number, pacing: Pacing = DEFAULT_SETTINGS.pacing): Interruption | null =>
	pacing.interruptions.meanMinutes > 0 ? (interruptionsNear(hours, at, pacing).find((away) => away.start <= at && at < away.end) ?? null) : null;

/** The quiet it waits for after someone's newest message before it starts the reply (`pacing.burst.settleSeconds`); 0, and no draw, when there is none. */
export const quietMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => (pacing.burst.settleSeconds.range[1] > 0 ? msIn(rng, pacing.burst.settleSeconds) : 0);

/** The delay, cut to the `leftMs` its span has left; null when not even `floorMs` fits (it waits for the next span). */
export const fitDelay = (delayMs: number, leftMs: number, floorMs: number): number | null => (leftMs < floorMs ? null : Math.min(delayMs, leftMs));

/** How long the typing indicator shows for a message: proportional to its length, within `typingDurationSeconds`. */
export function typingMs(text: string, rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): number {
	const charsPerSecond = drawIn(rng, pacing.typingCharsPerSecond);
	const ms = (text.length / charsPerSecond) * SECOND + between(rng, 400, 1500);
	return Math.round(Math.min(pacing.typingDurationSeconds[1] * SECOND, Math.max(pacing.typingDurationSeconds[0] * SECOND, ms)));
}

/**
 * How a message is typed: its `typingMs` as `typing` stretches, one unless thinking pauses cut a long message
 * (`pacing.thinkingPauses`: each of up to `max` with its `chance`, from `minChars`) into equal ones, with `pauses[i]`
 * between stretch i and the next. Draws only what typingMs does unless the message may have a pause.
 */
export function typingPlan(text: string, rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): { typing: number[]; pauses: number[] } {
	const total = typingMs(text, rng, pacing);
	const { chance, minChars, max, seconds } = pacing.thinkingPauses;
	const count = chance > 0 && text.length >= minChars ? Array.from({ length: max }, () => rng() < chance).filter(Boolean).length : 0;
	const pauses = Array.from({ length: count }, () => msIn(rng, seconds));
	const stretch = Math.floor(total / (count + 1));
	return { typing: Array.from({ length: count + 1 }, (_, i) => (i < count ? stretch : total - stretch * count)), pauses };
}

/**
 * How long reading `chars` characters takes before the reply is typed: proportional to their length, within
 * `readingDurationSeconds`; nothing, and no draw, when there is nothing to read.
 */
export function readingMs(chars: number, rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): number {
	if (chars <= 0) return 0;
	const ms = (chars / drawIn(rng, pacing.readingCharsPerSecond)) * SECOND;
	return Math.round(Math.min(pacing.readingDurationSeconds[1] * SECOND, Math.max(pacing.readingDurationSeconds[0] * SECOND, ms)));
}

/** How long it spends on `images` photos (`pacing.looking` each); nothing, and no draw, with none. */
export function lookingMs(images: number, rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): number {
	let ms = 0;
	for (let i = 0; i < images; i++) ms += msIn(rng, pacing.looking);
	return ms;
}

/** A pause between two messages of the same reply. */
export const betweenMessagesMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => msIn(rng, pacing.betweenReplyMessagesSeconds);

/**
 * A reply as the messages it is sent in: the lines the model wrote apart (three at most), else sometimes
 * a long reply cut at the sentence nearest its middle.
 */
export function splitReply(text: string, rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): string[] {
	const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
	if (lines.length > 1) return [...lines.slice(0, 2), ...(lines.length > 2 ? [lines.slice(2).join(' ')] : [])];
	const single = lines[0] ?? '';
	if (single.length <= 90 || rng() >= pacing.replySplitChance) return single ? [single] : [];
	const cuts = [...single.matchAll(/[.!?…]+\s+/g)].map((match) => match.index! + match[0].length);
	if (!cuts.length) return [single];
	const middle = single.length / 2;
	const cut = cuts.reduce((best, at) => (Math.abs(at - middle) < Math.abs(best - middle) ? at : best));
	return [single.slice(0, cut).trim(), single.slice(cut).trim()].filter(Boolean);
}
