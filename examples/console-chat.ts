/**
 * soulframe in one file: a persona defined inline, an in-memory store, the canned model and a console "channel".
 * No network, no API key, no file is read or written. From a clone of this repository, after `npm install`:
 *
 *   npx tsx examples/console-chat.ts
 */
import { fileURLToPath } from 'node:url';
import {
	createBrain,
	createCannedLlm,
	createReplyQueue,
	createRuntime,
	createStore,
	openDatabase,
	parsePersonas,
	sleep,
	type Channel,
	type Conversation,
	type Runtime,
} from 'soulframe';

// A fixed clock (Thursday 15 January 2026, 20:00 UTC, inside the persona's hours below) and a fixed source of
// numbers: the run is the same every time. A real service passes Date.now and Math.random (the defaults).
const NOW = Date.UTC(2026, 0, 15, 20, 0);
const now = () => NOW;
const rng = () => 0.5;

// 1. The persona, as its <id>.yaml (and <id>.md, the prompt) would hold it. loadPersonas reads them from a folder;
//    parsePersonas takes values already read, as here.
const loaded = parsePersonas({
	personas: [
		{
			id: 'robin',
			file: 'robin.yaml',
			raw: {
				name: 'Robin',
				timezone: 'UTC',
				window: { start: ['19:00', '19:00'], end: ['23:00', '23:00'] },
				chattiness: 'easygoing',
				character: {
					facts: ['You are 29 and live in a small coastal town.'],
					interests: ['board games', 'baking', 'indie music'],
					moods: ['cheerful', { mood: 'a little sleepy', weight: 0.5 }],
				},
				// Human pacing (seconds to minutes before a reply), made instant for the demo
				settings: { pacing: { quickReplyChance: 1, slowReplyChance: 0, quickReplyDelaySeconds: [0, 0], typingDurationSeconds: [0, 0], betweenReplyMessagesSeconds: [0, 0] } },
			},
		},
	],
	// The channels each persona is on: the names its hours' `on:` may use
	channels: { robin: ['console'] },
	readPrompt: () => 'You are Robin, warm and curious, writing in lowercase and always up for a good story.',
});
if (loaded.issues.length) throw new Error(loaded.issues.join('\n'));
const persona = loaded.personas[0]!;

// 2. Memory: one SQLite database, here in memory and gone at the end
const db = openDatabase(':memory:');
const store = createStore(db, now);

// 3. The runtime: the clock, randomness and store the brain and its reply queue share. The halt file is never created
//    here; the log only shows a few events.
const waiting = new Map<string, () => void>();
const nextEvent = (event: string) => new Promise<void>((resolve) => waiting.set(event, resolve));
const runtime: Runtime = {
	...createRuntime({ store, dryRun: false, haltFile: fileURLToPath(new URL('./HALT', import.meta.url)), rng, now }),
	log(_persona, event) {
		if (event === 'reply_scheduled' || event === 'reply_sent') console.log(`  [${event.replace('_', ' ')}]`);
		waiting.get(event)?.();
		waiting.delete(event);
	},
};

// 4. The brain, on that runtime, with the canned model (no provider): it answers one of a few fixed lines. `identity` is
//    the app's phrase after the persona's name in its identity line ("You are Robin, a character in a demo, chatting by
//    text in …"). Then its reply queue, on the same runtime.
const brain = createBrain({ persona, identity: 'a character in a demo', runtime, llm: createCannedLlm(rng) });
const queue = createReplyQueue({ persona, brain, runtime, act: async (personId, action) => console.log(`  [${action} person ${personId}]`) });

// 5. The channel: where the conversation happens, as the brain is told, and how a message goes out. `adult: true`
//    marks it 18+, which turns on soulframe's one built-in safeguard, avoiding minors (left out, it is off)
const terminal: Channel = { id: 'console', where: 'a terminal chat demo', maxLength: 500, adult: true };
const conversationWith = (name: string): Conversation => ({
	channel: terminal,
	async typing(on) {
		if (on) console.log('  (Robin is typing...)');
	},
	async send(text) {
		console.log(`Robin -> ${name}: ${text}`);
	},
});

/** One message in: the brain decides at once, the queue answers at its pace. */
async function receive(externalId: string, name: string, text: string) {
	console.log(`${name}: ${text}`);
	const decision = brain.incoming(terminal, externalId, name, text);
	console.log(`  [decision: ${decision.kind}${decision.kind === 'ignore' ? ` (${decision.reason})` : ''}]`);
	const sent = nextEvent('reply_sent');
	await queue.handle(decision, conversationWith(name), text);
	if (decision.kind === 'reply') await sent;
	// The queue records the turn once delivered: give it a moment before reading the store
	await sleep(20);
}

await receive('sam', 'Sam', 'hey robin! how is your evening going?');
const sam = store.person(persona.id, terminal.id, 'sam')!;
console.log(`  [memory: ${sam.name} is person ${sam.id}, ${sam.incoming} message in, ${store.history(sam.id).length} in the history]`);

// On an 18+ channel the code checks each message before the model: a sign of someone under 18 ends the chat and
// deny-lists the account (the goodbye goes out after a short pause of 2 to 10 seconds, whatever the pacing)
await receive('alex', 'Alex', "hi, i'm 16 btw");
console.log(`  [deny list: alex ${store.isDenied(terminal.id, 'alex') ? 'is' : 'is not'} denied]`);
await receive('alex', 'Alex', 'hello?');

queue.stop();
db.close();
