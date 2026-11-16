/**
 * The calendar through the brain, as people use it: many seeded runs of DM turns, openers, shares of its day, group-chat
 * lines and forgotten people, its model a random stub that makes, cancels and replaces plans (by the numbers its prompt
 * shows, or wrongly). After each step, what the code promises whatever the model writes:
 * - nothing throws;
 * - a plan's own words reach a prompt for someone else only as sharing allows (none with sharing off, nor anyone's
 *   name; with both thresholds off, only an open plan's), group chats included;
 * - someone forgotten leaves nothing behind: no later prompt, kv value, opener or audit line names them or holds their
 *   plans' words;
 * - a promise broken on someone is told to them exactly once: at the first turn with them that replies (or opener that
 *   is sent), never again, and no notice is told when nothing is owed.
 */

import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { isPromise } from '../src/calendar.js';
import { openerBlock, planShare } from '../src/initiative.js';
import type { Llm } from '../src/llm.js';
import { calledOffText, toOthers } from '../src/prompts.js';
import { seededRng, type Rng } from '../src/rng.js';
import { spanAt, zonedToUtc } from '../src/schedule.js';
import { DAY, HOUR, MINUTE, type Settings } from '../src/settings.js';
import { calledOffKey, type Person, type StoredEvent } from '../src/store.js';
import { everyDay, groupChannel, memoryStore, personaOf, PLAIN_DM, settingsOf, TEST_IDENTITY } from './fixtures.js';

const persona = personaOf({ id: 'robin', name: 'Robin', timezone: 'America/Toronto', schedule: everyDay(['18:00', '20:00'], ['00:30', '02:00']) });
const START = Date.UTC(2026, 9, 15, 1);
/** Names found nowhere else in a prompt, so one in it can only come from the calendar. */
const NAMES = ['Zelda', 'Yorick', 'Xavi', 'Wanda'];

type Sharing = 'off' | 'closed' | 'default';
const initiative = { enabled: true, sharing: { enabled: true, chance: 1 } };
const SETTINGS: Record<Sharing, Settings> = {
	off: settingsOf({ calendar: { enabled: true, sharing: { enabled: false } }, initiative }),
	closed: settingsOf({ calendar: { enabled: true, sharing: { personal: false, confidential: false } }, initiative }),
	default: settingsOf({ calendar: { enabled: true }, initiative }),
};

const int = (rng: Rng, from: number, to: number) => from + Math.floor(rng() * (to - from + 1));
const pick = <T>(rng: Rng, list: readonly T[]) => list[Math.floor(rng() * list.length)]!;
const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const named = (name: string, text: string) => new RegExp(`\\b${name}\\b`).test(text);

/** What the runs did, across seeds: the test of the tests (`is not trivial`). */
const outcomes = { promisesTold: 0, apologiesSent: 0, followUpsTelling: 0, othersWordsShown: 0, groupWordsShown: 0, forgotten: 0, replaced: 0, refused: 0, shares: 0 };

function simulate(seed: number, sharing: Sharing) {
	const rng = seededRng(`calendar-${sharing}-${seed}`);
	let now = START;
	const store = memoryStore(() => now);
	const settings = SETTINGS[sharing];
	/** The stub model's answer to the prompt it is shown, and the prompts it was shown. */
	let answerFor: (prompt: string) => unknown = () => ({ reply: null });
	const prompts: string[] = [];
	const llm: Llm = {
		complete: async (messages) => {
			const prompt = messages.map((m) => m.content).join('\n');
			prompts.push(prompt);
			return JSON.stringify(answerFor(prompt));
		},
	};
	const brain = createBrain({ settings, persona, identity: TEST_IDENTITY, runtime: { store, rng, now: () => now }, llm });
	const people = NAMES.map((name) => {
		const person = store.createPerson('robin', 'chat', name.toLowerCase(), name);
		return store.updatePerson(person.id, { familiarity: rng(), affinity: rng() * 2 - 1, conversations: 4, incoming: 3, lastInAt: now - DAY, handledAt: now - DAY });
	});
	const living = new Map(people.map((p) => [p.id, p.name]));
	const forgotten: { name: string; tokens: string[] }[] = [];
	/** How many times each broken promise was told, by event (an id may be reused once its row is deleted). */
	const told = new Map<string, number>();
	const keyOf = (event: StoredEvent) => `${event.id}@${event.createdAt}`;
	let token = 0;

	/** Every plan the persona made, standing or called off (each found by its `plan_added` audit line). */
	const plans = (): StoredEvent[] =>
		store
			.auditLog('robin', 100_000)
			.filter((row) => row.kind === 'plan_added')
			.flatMap((row) => store.eventById(row.detail.eventId as number) ?? []);
	const tokenOf = (event: StoredEvent) => /zork\d+/.exec(event.what)?.[0];
	/** The notice of a broken promise, as a prompt to them says it. */
	const noticeOf = (event: StoredEvent, name: string) =>
		calledOffText({ start: zonedToUtc(event.day, event.from, persona.timezone), end: zonedToUtc(event.day, event.to, persona.timezone), kind: event.kind, what: toOthers(event.what, name) }, persona.timezone);
	/** Promises broken on `personId` for someone else, not yet told, still worth telling. */
	const owedTo = (personId: number) =>
		plans().filter(
			(event) =>
				event.personId === personId &&
				isPromise(event) &&
				event.cancelledBy !== null &&
				event.cancelledBy !== personId &&
				!told.has(keyOf(event)) &&
				zonedToUtc(event.day, event.to, persona.timezone) > now - 14 * DAY,
		);

	/** A plan answer as a model might write it, with the numbers its prompt showed (or a wrong one now and then). */
	const planAnswer = (prompt: string) => {
		const ids = [...prompt.matchAll(/\[(\d+)\] /g)].map((m) => Number(m[1]));
		const id = () => (ids.length && rng() < 0.85 ? pick(rng, ids) : int(rng, 1, 60));
		const roll = rng();
		if (roll < 0.3) return null;
		token++;
		const day = int(rng, 0, 6);
		const from = int(rng, 7 * 60, 22 * 60);
		const busy = {
			day,
			from: clock(from),
			to: clock(from + int(rng, 30, 240)),
			busy: pick(rng, [`at the zork${token} party`, `at your zork${token} party`, `dinner with you at zork${token}`, `helping u at zork${token}`, `at zork${token}`]),
			...(rng() < 0.7 && { public: pick(rng, ['at a party', 'out', 'at a friends', 'at your place']) }),
			...(rng() < 0.9 && { share: pick(rng, ['open', 'personal', 'confidential', 'secret']) }),
			withThem: rng() < 0.6,
		};
		const online = { day, from: clock(from), to: clock(from + int(rng, 30, 150)), online: true };
		const made = rng() < 0.5 ? busy : online;
		if (roll < 0.6) return made;
		if (roll < 0.75) return { cancel: id() };
		if (roll < 0.92) return { ...made, cancel: id() };
		return pick(rng, [{ day: 'saturday', from: '10:00', to: '11:00', busy: 'x' }, { cancel: id(), from: '10:00' }, 'tomorrow', { day: 2, from: '10:00', to: '11:00' }]);
	};

	/** What a prompt for `viewer` (null: a group chat) may hold of others' plans and of the forgotten. */
	const checkPrompt = (prompt: string, viewer: number | null) => {
		for (const event of plans()) {
			const t = tokenOf(event);
			if (!t || event.personId === viewer || !named(t, prompt)) continue;
			if (sharing === 'off') throw new Error(`plan ${event.id} "${event.what}" made with ${event.personId} told to ${viewer} with sharing off`);
			if ((sharing === 'closed' || viewer === null) && event.share !== 'open') throw new Error(`${event.share} plan ${event.id} "${event.what}" told to ${viewer}`);
			// Told in confidence, said so where it is told
			if (event.share === 'confidential' && !new RegExp(`${t}[^"]*", in confidence|${t}[^"]*" \\(in confidence`).test(prompt)) {
				throw new Error(`confidential plan ${event.id} "${event.what}" told to ${viewer} without saying so`);
			}
			if (viewer === null) outcomes.groupWordsShown++;
			else outcomes.othersWordsShown++;
		}
		// With nothing shared but open plans (whose words never say "you"), nobody else is ever named
		if (sharing !== 'default') for (const [id, name] of living) if (id !== viewer && named(name, prompt)) throw new Error(`${name} named to ${viewer} with sharing ${sharing}`);
		for (const { name, tokens } of forgotten) {
			if (named(name, prompt)) throw new Error(`forgotten ${name} in a prompt`);
			for (const t of tokens) if (named(t, prompt)) throw new Error(`forgotten ${name}'s ${t} in a prompt`);
		}
	};
	/** A prompt to `person`: what it tells of promises broken on them is all that is owed, and only that. */
	const checkNotices = (person: Person, prompt: string, owed: StoredEvent[]) => {
		const notice = /You called off (?:a plan|plans) with (?:them|\w+) for something else, and haven't told them yet: (.*?)\. (?:Tell|Text|If)/.exec(prompt);
		if (!owed.length) {
			if (notice) throw new Error(`a called-off notice to ${person.name} with nothing owed: ${notice[0]} (kv ${store.get('robin', calledOffKey(person.id))})`);
			return;
		}
		if (!notice) throw new Error(`nothing told to ${person.name} of ${owed.map((e) => e.id).join(', ')}`);
		for (const event of owed) if (!notice[1]!.includes(noticeOf(event, person.name))) throw new Error(`promise ${event.id} owed to ${person.name} not told: ${notice[1]}`);
	};
	/** A turn or opener with them was sent: what it told them is told. */
	const sent = (person: Person, messages: readonly string[], owed: StoredEvent[]) => {
		for (const message of messages) store.addMessage(person.id, 'chat', 'out', message);
		for (const event of owed) told.set(keyOf(event), (told.get(keyOf(event)) ?? 0) + 1);
		outcomes.promisesTold += owed.length;
	};

	const dm = async (person: Person) => {
		const decision = brain.incoming(PLAIN_DM, person.ids.chat!, person.name, 'hey');
		if (decision.kind !== 'reply') return;
		const owed = owedTo(person.id);
		const reply = rng() < 0.25 ? null : 'ok';
		// Now and then a follow-up of its own too, which an apology never replaces
		const followUp = rng() < 0.2 ? { days: int(rng, 0, 2), about: 'ask how it went' } : null;
		answerFor = (prompt) => ({ reply, plan: planAnswer(prompt), ...(followUp && { followUp }) });
		const turn = await brain.compose(person.id, PLAIN_DM);
		const prompt = prompts.at(-1)!;
		checkPrompt(prompt, person.id);
		checkNotices(person, prompt, owed);
		// A draft dropped now and then: nothing of it kept
		if (rng() < 0.15) return;
		turn.keep?.();
		if (turn.messages.length) sent(person, turn.messages, owed);
		store.updatePerson(person.id, { handledAt: store.personById(person.id).lastInAt });
	};

	const openers = async () => {
		for (const opener of store.dueOpeners('robin', now)) {
			const person = store.personById(opener.personId);
			const block = openerBlock(store, person, now, settings.initiative, opener);
			if (block?.final) store.closeOpener(opener.id, 'dropped');
			if (block) continue;
			const owed = owedTo(person.id);
			if (opener.kind === 'apology' && !owed.length) throw new Error(`an apology to ${person.name} with nothing owed (kv ${store.get('robin', calledOffKey(person.id))})`);
			const reply = rng() < 0.3 ? null : 'hey you';
			answerFor = () => ({ reply, notes: null, self: null });
			const turn = await brain.composeOpener(person.id, PLAIN_DM, opener);
			const prompt = prompts.at(-1)!;
			checkPrompt(prompt, person.id);
			checkNotices(person, prompt, owed);
			turn.keep?.();
			if (turn.messages.length) {
				sent(person, turn.messages, owed);
				if (opener.kind === 'apology') outcomes.apologiesSent++;
				if (opener.kind === 'followUp' && owed.length) outcomes.followUpsTelling++;
				if (opener.kind === 'share') outcomes.shares++;
				store.closeOpener(opener.id, 'sent');
			} else store.closeOpener(opener.id, 'declined');
		}
	};

	const groupLine = async () => {
		answerFor = () => ({ reply: null });
		const before = prompts.length;
		await brain.composeGroupChatLine(groupChannel('Trip'), [{ name: 'Quinn', text: 'what are you all up to this week?', mine: false, at: now - MINUTE }], false, true);
		if (prompts.length > before) checkPrompt(prompts.at(-1)!, null);
	};

	const forget = (person: Person) => {
		const tokens = plans()
			.filter((event) => event.personId === person.id)
			.flatMap((event) => tokenOf(event) ?? []);
		store.forgetPerson(person.id);
		living.delete(person.id);
		forgotten.push({ name: person.name, tokens });
		outcomes.forgotten++;
		// Nothing of them stays in what the store keeps for the others
		const others = people.filter((p) => living.has(p.id));
		const kept = JSON.stringify([
			others.flatMap((p) => [store.get('robin', `calendarRefused:${p.id}`), store.get('robin', calledOffKey(p.id)), store.pendingOpener(p.id) ?? null, store.sentOpeners(p.id, 1000)]),
			store.auditLog('robin', 100_000),
		]);
		if (named(person.name, kept)) throw new Error(`forgotten ${person.name} kept in the store`);
		for (const t of tokens) if (named(t, kept)) throw new Error(`forgotten ${person.name}'s ${t} kept in the store`);
	};

	return {
		told,
		/** Counts what its audit says happened. */
		tally() {
			const kinds = store.auditLog('robin', 100_000).map((row) => row.kind);
			outcomes.refused += kinds.filter((kind) => kind === 'plan_refused').length;
			outcomes.replaced += store
				.auditLog('robin', 100_000)
				.filter((row) => row.kind === 'plan_cancelled')
				.filter((row) => kinds.includes('plan_added')).length;
		},
		async run(steps: number) {
			for (let step = 0; step < steps; step++) {
				now += pick(rng, [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 7 * HOUR, DAY]);
				const left = people.filter((p) => living.has(p.id));
				const roll = rng();
				if (roll < 0.6) await dm(store.personById(pick(rng, left).id));
				else if (roll < 0.8) await openers();
				else if (roll < 0.88) {
					// Just back from one of its plans, as a share of its day is planned
					const ended = plans()
						.filter((event) => event.kind === 'busy' && event.cancelledAt === null)
						.map((event) => zonedToUtc(event.day, event.to, persona.timezone))
						.filter((end) => end > now && end < now + 3 * DAY);
					if (ended.length) now = pick(rng, ended) + int(rng, 1, 10) * MINUTE;
					const span = spanAt(brain.hours, now);
					const share = span?.kind === 'online' ? planShare({ store, persona: brain.hours, settings, span, now, rng }) : null;
					// Sent when it is due, as the reply queue would
					if (share) {
						now = Math.max(now, share.dueAt);
						await openers();
					}
				} else if (roll < 0.97) await groupLine();
				else if (left.length > 2) forget(store.personById(pick(rng, left).id));
			}
		},
	};
}

describe('the calendar through the brain, at random', () => {
	for (const sharing of ['off', 'closed', 'default'] as const) {
		it.each(Array.from({ length: Number(process.env.SIM_SEEDS ?? 10) }, (_, i) => i + 1))(`keeps its word with sharing ${sharing}, seed %i`, async (seed) => {
			const sim = simulate(seed, sharing);
			await sim.run(150);
			for (const [id, times] of sim.told) expect(times, `promise ${id} told`).toBe(1);
			sim.tally();
		});
	}

	it('is not trivial: across the seeds promises are broken and told, words shared, people forgotten', () => {
		expect(outcomes.promisesTold).toBeGreaterThan(30);
		expect(outcomes.apologiesSent).toBeGreaterThan(5);
		expect(outcomes.othersWordsShown).toBeGreaterThan(10);
		expect(outcomes.groupWordsShown).toBeGreaterThan(1);
		expect(outcomes.followUpsTelling).toBeGreaterThan(2);
		expect(outcomes.forgotten).toBeGreaterThan(5);
		expect(outcomes.refused).toBeGreaterThan(50);
		expect(outcomes.shares).toBeGreaterThan(3);
	});
});
