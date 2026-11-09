import type { PersonaConfig } from './config/personas.js';
import { seededRng, weightedPick } from './rng.js';
import { localDateOf, nextSpan, spanAt } from './schedule.js';

/**
 * The persona's mood for the day (its config's `moods`): picked by weight, seeded by the persona and the agenda day of
 * the span open now, else of the next one, so it holds through a night past midnight and after a restart. `null`
 * without moods.
 */
export function moodOf(persona: Pick<PersonaConfig, 'id' | 'schedule' | 'timezone' | 'moods'>, now: number): string | null {
	const { moods } = persona;
	if (!moods.length) return null;
	const day = (spanAt(persona, now) ?? nextSpan(persona, now))?.day ?? localDateOf(now, persona.timezone);
	const rng = seededRng(`${persona.id}:mood:${day.year}-${day.month}-${day.day}`);
	return weightedPick(rng, moods.map((m) => ({ weight: m.weight, value: m.mood }))) ?? null;
}
