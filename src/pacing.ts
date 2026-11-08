import { between, seededRng, type Rng } from './rng.js';
import { addDays, agendaOn, localDateOf, type Hours, type LocalDate } from './schedule.js';
import { DEFAULT_SETTINGS, MINUTE, SECOND, type Settings } from './settings.js';

type Pacing = Settings['pacing'];

/** Whole milliseconds drawn in a range of seconds. */
const msIn = (rng: Rng, [from, to]: readonly [number, number]) => Math.round(between(rng, from * SECOND, to * SECOND));

/** A draw of a memoryless clock with this mean: most come soon, a few take a while (an exponential distribution). */
const memoryless = (rng: Rng, mean: number) => -Math.log(1 - rng()) * mean;

/** The chance that it still has someone's chat open `sinceMs` after its last turn with them: 1 at once, halving every `watching.halfLifeSeconds`. */
export const watchingChance = (sinceMs: number, pacing: Pacing = DEFAULT_SETTINGS.pacing) => 0.5 ** (Math.max(0, sinceMs) / (pacing.watching.halfLifeSeconds * SECOND));

/** The lag before it answers while it is watching their chat (`watching.replyDelaySeconds`): the only delay on a short break. */
export const watchingMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => msIn(rng, pacing.watching.replyDelaySeconds);

/** The time until it next glances at its messages (`glance`): memoryless, with mean `meanSeconds`, within `delaySeconds`. */
export function glanceMs(rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): number {
	const [least, most] = pacing.glance.delaySeconds;
	return Math.round(Math.min(most, Math.max(least, memoryless(rng, pacing.glance.meanSeconds))) * SECOND);
}

/**
 * How long before it answers someone's message, and whether it was watching their chat. `sinceMs`: how long ago its
 * last turn with them ended, or null when there was none (or it was away since). While it may still be watching
 * (`watchingChance`), a short lag; else the time until it next glances at its messages. Draws once for the chance
 * (with a turn to go by), then the delay.
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
			const end = Math.min(online.end, at + between(rng, ...minutes) * MINUTE);
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

/** Whether an interruption began after `from` and by `to`: it looked away from every chat in between. */
export const interruptedBetween = (hours: Hours, from: number, to: number, pacing: Pacing = DEFAULT_SETTINGS.pacing) =>
	pacing.interruptions.meanMinutes > 0 && interruptionsNear(hours, to, pacing).some((away) => away.start > from && away.start <= to);

/** The quiet it waits for after someone's newest message before it starts the reply (`pacing.burst.settleSeconds`); 0, and no draw, when there is none. */
export const quietMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => (pacing.burst.settleSeconds[1] > 0 ? msIn(rng, pacing.burst.settleSeconds) : 0);

/** The delay, cut to the `leftMs` its span has left; null when not even `floorMs` fits (it waits for the next span). */
export const fitDelay = (delayMs: number, leftMs: number, floorMs: number): number | null => (leftMs < floorMs ? null : Math.min(delayMs, leftMs));

/** How long the typing indicator shows for a message: proportional to its length, within `typingDurationSeconds`. */
export function typingMs(text: string, rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): number {
	const charsPerSecond = between(rng, ...pacing.typingCharsPerSecond);
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
	const ms = (chars / between(rng, ...pacing.readingCharsPerSecond)) * SECOND;
	return Math.round(Math.min(pacing.readingDurationSeconds[1] * SECOND, Math.max(pacing.readingDurationSeconds[0] * SECOND, ms)));
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
