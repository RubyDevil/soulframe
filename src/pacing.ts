import { between, type Rng } from './rng.js';
import { DEFAULT_SETTINGS, SECOND, type Settings } from './settings.js';

type Pacing = Settings['pacing'];

/** Whole milliseconds drawn in a range of seconds. */
const msIn = (rng: Rng, [from, to]: readonly [number, number]) => Math.round(between(rng, from * SECOND, to * SECOND));

/**
 * How long before answering: usually under a minute, sometimes a few minutes, now and then a long gap,
 * as when someone is busy (the shares and ranges are `settings.pacing`).
 */
export function replyDelayMs(rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing): number {
	const roll = rng();
	if (roll < pacing.quickReplyChance) return quickReplyMs(rng, pacing);
	if (roll < pacing.quickReplyChance + pacing.slowReplyChance) return msIn(rng, pacing.slowReplyDelaySeconds);
	return msIn(rng, pacing.busyReplyDelaySeconds);
}

/** The quick delay alone: the only one on a short break. */
export const quickReplyMs = (rng: Rng, pacing: Pacing = DEFAULT_SETTINGS.pacing) => msIn(rng, pacing.quickReplyDelaySeconds);

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
