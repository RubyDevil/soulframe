# Writing a channel adapter

soulframe knows no platform. A **channel adapter** is the application code that connects one platform to a persona:
it turns the platform's events into calls to the brain and the reply queue, and the queue's `send` into the
platform's API. This page walks through one.

The pieces an adapter uses:

| Piece | Role |
| --- | --- |
| `ChannelId` | The string your application chooses for the platform, e.g. `'chat'`. The same everywhere: in the persona's `on:`, in identities, in the deny list. |
| `Channel` | How the brain is told about the place: `where`, `maxLength`, optional `identityNote`, `notes`, `invitations`, `actions` and `adult`. |
| `Conversation` | One person on that channel: `typing`, `send`, optional `typingRefreshMs`, `markRead`, `delivered`, `extraLines` and `invitation`. |
| `brain.incoming` | Called for every message, synchronously. |
| `queue.handle` | Hands the decision to the reply queue. |
| `queue.requeue`, `watchSpans`, `fullyOnline` | Restarts and presence. |
| `store.person`, `store.link` | Identities across channels. |

## The shape of an adapter

The client below is a stand-in for whatever SDK your platform has.

```ts
import { UnreachableError, watchSpans, type Brain, type Channel, type Conversation, type LinkPreview, type Persona, type ReplyQueue, type Runtime } from 'soulframe';

/** A stand-in for your platform's SDK. */
interface ChatClient {
	onDirectMessage(handler: (message: { from: { id: string; displayName: string }; text: string; images: { url: string }[]; cards: LinkPreview[] }) => void): void;
	sendTyping(userId: string): Promise<void>;
	markRead(userId: string): Promise<void>;
	sendMessage(userId: string, text: string): Promise<void>;
	setPresence(online: boolean): Promise<void>;
}

const CHAT_DM: Channel = { id: 'chat', where: 'Example Chat direct messages', maxLength: 2000 };

export function createChatAdapter({ persona, brain, queue, runtime, client }: { persona: Persona; brain: Brain; queue: ReplyQueue; runtime: Runtime; client: ChatClient }) {
	const conversationWith = (userId: string): Conversation => ({
		channel: CHAT_DM,
		async typing(on) {
			if (on) await client.sendTyping(userId).catch(() => undefined);
		},
		// This platform shows typing for 5 seconds per signal: the queue signals again every 4 while it types
		typingRefreshMs: 4_000,
		// Their messages show as read as it starts writing the reply; it reads them (pacing.readingCharsPerSecond) while the model writes
		markRead: () => client.markRead(userId).catch(() => undefined),
		async send(text) {
			try {
				await client.sendMessage(userId, text);
			} catch (error) {
				// They blocked the persona or closed their DMs: never try them again on this channel
				if (isBlockedError(error)) throw new UnreachableError('blocked');
				throw error;
			}
		},
	});

	client.onDirectMessage(({ from, text, images, cards }) => {
		if (!text.trim() && !images.length) return;
		const decision = brain.incoming(CHAT_DM, from.id, from.displayName, { text, images, links: cards });
		void queue.handle(decision, conversationWith(from.id), text).catch((error) => runtime.log(persona.id, 'dm_failed', { error: String(error) }));
	});

	let stopHours: (() => void) | undefined;
	return {
		async start() {
			// Everyone still owed a reply from before the restart
			await queue.requeue(CHAT_DM.id, async (person) => (person.ids[CHAT_DM.id] ? conversationWith(person.ids[CHAT_DM.id]!) : null));
			// Show online while a span is open here
			stopHours = watchSpans(persona, CHAT_DM.id, runtime, (span) => void client.setPresence(span !== null));
		},
		stop() {
			stopHours?.();
		},
	};
}

declare function isBlockedError(error: unknown): boolean;
```

**Photos and links.** Pass what came with a message as an `IncomingMessage`. An image's `url` must be one the vision
model can reach, or a `data:` URI (for a platform whose files need a login, download it and pass one). For links, pass
the preview cards your platform already gives you. Where it attaches them a moment late, or not at all, give
`createBrain` a `previewLink` function instead: it runs while the persona reads. soulframe never fetches a URL a
stranger sent, so if `previewLink` does, guard it the way you would guard any server fetching a stranger's URL
(no private addresses, a size and time limit). URLs in the text are found for you; with no card, the persona knows
only the site's name. In DMs only: for group chats, write what you want the persona to know into `GroupChatLine.text`.

And the wiring. What every persona shares is built once, from the
[service settings](./configuration.md#service-settings) (`service` from `parseServiceSettings`): the token meters,
every persona's model client and the Decisions client (`personas` from `loadPersonas` or `parsePersona`, `settings`
from `parseSettings`, the same for every persona or its own):

```ts
const meter = createTokenMeter(runtime.store, service.text.dailyTokens, runtime.now);
const llms = llmsFor(personas.map(({ id }) => ({ id, settings })), { dryRun: false, apiKeyOf: (name) => process.env[name] ?? '', meter, budget: service.text });
const decisions = createConfiguredDecisions({
	settings: service.decisions,
	apiKeyOf: (name) => process.env[name] ?? '',
	meter: createTokenMeter(runtime.store, service.decisions.dailyTokens, runtime.now, 'decisionTokens'),
	now: runtime.now,
});
```

Then, once per persona (its `llm` is `llms.get(persona.id)!`):

```ts
// What your personas are, how they write, your rules and allowed links, all optional: left out, the identity line is
// the name alone, there is no style block, no rule is added and every link is kept
const policy: Policy = { rules: ['Never ask for real names or addresses.'], allowedLinks: ['https://example.com'] };
const style = 'Write like a person chatting:\n- Short messages, no lists, no markdown.';
const brain = createBrain({ persona, settings, identity: 'a guide made by Example (https://example.com)', style, runtime, llm, decisions, policy });
// The queue answers with its brain's persona and settings
const queue = createReplyQueue({ brain, runtime, act: (personId, action) => chat.act(personId, action) });
const chat = createChatAdapter({ persona, brain, queue, runtime, client });
await chat.start();      // every channel of the persona
queue.start();           // once all of them are up
// ... on shutdown:
chat.stop();
queue.stop();
```

## `Channel`

Describe each place a conversation happens with a `Channel`. One platform often gives several: its DMs, each group
chat (`where: 'the group chat "Trip planning"'`), a posting channel. They share the `id` when they are
the same platform, since the id keys hours and identities.

- `where` completes the identity line's "chatting by text in ...".
- `maxLength`: a longer message is cut at a word, with an ellipsis.
- `targetLength`: in a group chat, the soft length the model is asked to keep a line under ("one short line (under
  150 characters)"); left out, 150, or four fifths of `maxLength` when that is less. `maxLength` still cuts.
- `identityNote`: channels may add a disclosure note (`Channel.identityNote`), appended word for word to the identity
  line.
- `notes`: what the model should know about the place, word for word: a group-chat task lists them with its own
  instructions, a post task gives them after its instruction (`['Everyone here is planning a trip together: keep to
  it.']`). A DM turn's own lines are `Conversation.extraLines`.
- `invitations`: DM turns here may accept a group-chat invitation (`acceptInvite`).
- `actions`: what the persona may choose here besides talking, each `{ name, when }` (`{ name: 'archive', when: 'when
  the conversation is over and you would rather not pick it up again' }`), offered before `block`. An action the
  channel doesn't declare becomes `none`. `block` is always offered.
- `adult`: set it to `true` on a channel whose conversations are meant for adults only (18+). It turns on soulframe's
  minors safeguard there: a message that says or hints that its writer is under 18 ends the conversation and
  deny-lists them, the Decisions age check runs when it is on, and the prompt says the persona only talks with adults.
  Left out, none of it runs. Set it the same way on every surface of an 18+ platform (its DMs, its group chats, its
  posting channels), and load the personas with `loadPersonas({ ..., adult: true })` too.

## `Conversation`

```ts
interface Conversation {
	channel: Channel;
	typing(on: boolean): Promise<void>;
	typingRefreshMs?: number;
	markRead?(): Promise<void>;
	send(text: string): Promise<void>;
	delivered?(text: string): void;
	extraLines?(person: Person): readonly string[];
	invitation?: { name: string; join(): Promise<void> };
}
```

A conversation is cheap: make one per incoming message, or keep one per person; the queue keeps the one it was given
for the person's pending turn.

### `typing` and `send`

For each message of a reply the queue calls `typing(true)`, waits the typing time, calls `send(text)`, and always
calls `typing(false)` afterwards, sent or not. A rejection from `typing` counts as a failed delivery (the rest of the
reply is dropped), so swallow the errors that don't matter. How long typing shows, and the optional read receipt and
pauses around it, are in [the next section](#typing-read-receipts-and-thinking-pauses).

`send` must resolve once the message is out, and reject otherwise:

- **`UnreachableError(code)`** when the person can't be messaged there any more (they blocked the persona, closed
  their DMs, left the platform). The rest of the reply is dropped, an active person becomes `stopped`, and the
  `unreachable` event is logged with `code`. A goodbye that is refused keeps them as they were (denied or blocked).
- **Any other error**: the rest of the reply is dropped and `delivery_failed` is logged. It is never retried: a send
  that timed out may still have landed.

The queue records each message in the history only after `send` resolves. In a dry run (`runtime.dryRun`) `send` is
never called.

### Typing, read receipts and thinking pauses

Three optional pieces make the typing look like a person's. Leave them out and the queue does exactly what is
described above: one `typing(true)` per message, the typing time, the send, one `typing(false)`.

- **`typingRefreshMs`** (a positive number of milliseconds): most platforms drop a typing indicator a few seconds
  after its last signal, while a long message may be typed for up to `pacing.typingDurationSeconds` (45 seconds by
  default). Give how long one signal shows, or a little less, and the queue calls `typing(true)` again at that rhythm
  until the message is sent. It checks the halt switch, `queue.stop()` and the person's state at each one, so a reply
  cut short stops typing then, not at the end of the typing time.
- **`markRead()`**: shows the person their messages were read (a read receipt). The queue calls it as it starts
  writing a reply (again for a draft written again with a newer message), and reads what they wrote while the model
  writes, as long as that takes (15 to 25 characters a second by default, 1 to 20 seconds, plus `pacing.looking` per photo): typing starts once both
  are done. That reading happens without `markRead` too. A reply halted or cancelled before then types nothing. A
  rejection counts as a failed delivery, as for `typing`: swallow it if a missing receipt doesn't matter. A turn the
  persona leaves on read shows their messages read too, as a person who read them and chose not to answer.
- **Thinking pauses** are the brain's setting, not the adapter's (`pacing.thinkingPauses`, off by default): a long
  message may stop typing a moment (`typing(false)`) and start again (`typing(true)`), as when someone stops to think.
  Your `typing` sees nothing new: stretches of typing, each ended by one `typing(false)`.

How fast each persona types is its brain's `pacing` too (`typingCharsPerSecond`, `typingDurationSeconds`; see
[configuration](./configuration.md#pacing)). In a dry run the queue makes the same calls and waits (`markRead` and
`typing` included) and only logs in place of `send`: check `runtime.dryRun` in them if a rehearsal must not show
anything on the platform.

### `delivered`

`delivered(text)` is called once per message that went out: after `send` resolved, and in a dry run after the message
was logged (`dry_send`) in place of sending. It is never called for a message whose send failed, nor for the rest of
a reply that was dropped. Do your own bookkeeping on what the persona said here rather than in `send`, so a dry run
rehearses it as it will run live (counting how often something was brought up, say). It runs before the next message
of the reply is typed; a throw counts as a failed delivery.

### `extraLines`

`extraLines(person)` adds your own lines to a DM turn's task, after the notes on the person and before any invitation
and the time. It is called as the brain composes, with the person as it reads them. Use it for platform context the
model should know this turn (a feature that is off here, something the person did elsewhere in your app). Keep them
short: they are sent with every turn.

### Invitations

When someone invites the persona into a group chat, attach the invitation to the conversation you hand to
`queue.handle`:

```ts
const conversation = conversationWith(userId);
conversation.invitation = { name: group.name, join: () => client.joinGroup(group.id) };
await queue.handle(decision, conversation, text);
```

The queue keeps it for the person's next turn. It is offered to the model only where `channel.invitations`; its
name is quoted as data, never as instructions. The persona joins (`join()` is called) only when the model accepts,
chose no action, a full online span is open, the queue is not halted or stopped, the person is still active, and it is
not a dry run (then it is only logged). On a short break the invitation waits (`inviteWaits`) for full online time.
Otherwise, joined or declined, it is used once.

## The `act` callback

`createReplyQueue`'s `act(personId, action)` carries out what the persona chose besides talking: `'block'` or the
name of one of the channel's `actions`. The store already has the outcome (a block makes the person `blocked`; both
are audited); `act` does it on the platform. Route it by the person's identities:

```ts
async act(personId, action) {
	const userId = store.personById(personId).ids[CHAT_DM.id];
	if (!userId) return; // where there is nothing to block, never answering again is the block
	if (action === 'block') await client.block(userId);
	else if (action === 'archive') await client.archive(userId);
}
```

It is not called while halted or stopped, nor in a dry run (the action is logged instead).

## Restarts: `requeue`

After a restart, people who wrote while your application was down, or whose reply was cut short, are still owed a turn.
Once a channel is connected, call:

```ts
await queue.requeue(channelId, async (person) => conversationFor(person) /* or null when unreachable */);
```

It reads everyone of the persona who last wrote on `channelId`, is still active and owed a turn, from up to 48 hours
before the persona was last online, and puts them in the backlog, oldest first. They are answered one at a time once
a span is open on that channel. Call `queue.start()` after every channel is up: it records "last online" every 30
seconds (what the next start's `requeue` reads) and moves the backlog on.

If your platform delivers messages that came in while you were disconnected, pass each one's time as `incoming`'s
`at`, in order: the brain keeps the newer of two times as their last message.

## Presence: `watchSpans` and `fullyOnline`

`watchSpans(persona, channelId, runtime, onChange)` calls `onChange(span)` right away and whenever the span on that
channel opens, closes or changes (checked every 30 seconds), and answers a function that stops watching. Use it to
show the persona online, to join or leave group chats, to start a posting schedule.

The reply queue does not need it: it checks the hours itself, for openers too ([texting first](#texting-first-allowinitiative)).
But anything else the persona does on its own initiative should check them:

- **Group chats, posts and joining a group chat** only in full online time: `fullyOnline(persona, channelId, runtime.now())`.
- **DMs** in any span, breaks included: `spanAt(persona, runtime.now(), channelId)`.

## Texting first: `allowInitiative`

With the brain's `settings.initiative.enabled` on (off by default), the persona may text someone first on the
channels you allow, each with how to reach a person there, as `requeue` takes it:

```ts
const withdraw = queue.allowInitiative(CHAT_DM.id, async (person) => (person.ids[CHAT_DM.id] ? conversationWith(person.ids[CHAT_DM.id]!) : null));
// later, to stop texting first there (the setting stays as it is): withdraw();
```

Nothing is texted first on a channel you never allow, and `null` drops that opener (they can't be reached there). The
queue checks at each tick of `start()` whether an opener is due and allowed (see
[concepts](./concepts.md#texting-first)), and sends it through the conversation like a reply: `typing`, `send`,
`delivered` and `extraLines`, never `markRead` (there is nothing of theirs to read). Their answer comes in as any
message does, through `incoming` and `handle`. soulframe never texts first anyone who never wrote to the persona;
for someone else who should get no opener, `conversationOf` may answer `null` (that opener is dropped).

## Group chats

The brain writes; the adapter decides when to ask. A typical loop for a group chat, in full online time:

```ts
const chat: Channel = { id: 'chat', where: `the group chat "${name}"`, maxLength: 190, notes: ['Everyone here is planning a trip together: keep to it.'], adult: true };
// For each new line someone else wrote (the age check answers 'none' in a group chat without adult: true):
const check = await brain.checkGroupChatLine(chat, line.text);
if (check.level !== 'none') { /* never answer it; on 'deny', deny-list the writer: store.deny(chat.id, line.userId, 'minor') */ }
const gate = await brain.wantsToSpeak(groupId, recent); // null: no gate, let the model decide
if (gate && !gate.speak) return;
const text = await brain.composeGroupChatLine(chat, recent, quiet, hosted);
if (text) await client.sendGroupMessage(groupId, text);
```

`minorSignal(text)` is the 18+ safeguard's own under-18 check, for lines the brain never sees through `incoming` (run
it where your channel is 18+). The gate counts its own checks per `groupId` (any id you keep for the chat):
past `settings.decisions.groupChatGate.perHour` in an hour it answers `null` without asking. Pace group-chat lines yourself (`typingMs` gives a typing time).

## Posts

`brain.composePost(channel, { rules, examples, recent })` writes one post for a channel whose `rules` you pass (the
channel's own posting rules; what the post is for goes in the channel's `notes`), in the style of `examples`, not repeating `recent` (your record of the persona's last
posts). It answers `null` when the model wrote nothing usable. Where and when to post, and how often, are the
application's: post in full online time.

## Identities and `link`

A person is the persona's contact, with one account per channel in `Person.ids`. `brain.incoming` finds the person by
`(persona, channel, externalId)` or creates them. When you learn that an account on another channel is the same
person (they told the persona, or your platform links accounts), attach it:

```ts
if (!store.person(persona.id, 'forum', forumUserId)) store.link(personId, 'forum', forumUserId);
```

`link` throws when the person already has an account on that channel, or another of the persona's people has this
one, so check first. From then on both accounts reach the same history, notes and relationship. A deny-listing for
being under 18 covers every account the person has.

The deny list is keyed by channel and account and shared by every persona: check `store.isDenied(channelId, userId)`
before doing anything else with someone (accepting a contact request, greeting them in a group chat). `incoming` checks it for
DMs.

## Logging

The reply queue and `watchSpans` report through `runtime.log(persona, event, detail)` (the brain logs nothing: what it
decides goes to the store's audit log). Events include `dm_received`,
`reply_scheduled` (with `watching`: timed as it still had their chat open), `reply_batched`, `reply_waiting` (in the
backlog, with the next opening), `away` (an interruption, from and until), `interruption_held` (one held off by a conversation that matters), `reply_processing`,
`reply_superseded` (a message that makes the draft start over), `reply_restarted`, `reply_after_turn` (a message that
gets a turn of its own once this one ends), `reply_picked` (who went first among several due, with their weight),
`dm_sent`, `reply_sent`, `reply_skipped` (left on read), `reply_failed`, `reply_waiting_budget`,
`reply_waiting_provider`, `reply_cancelled`, `reply_paused`, `unreachable`, `delivery_failed`, `invite_accepted`,
`invite_not_joined`, `action_skipped` (an action not carried out while halted or stopped), `hours_open` and `hours_closed`,
`opener_processing` and `opener_<outcome>` (`sent`, `declined`, `superseded`, `dropped`, `failed`, `rehearsed`) for
texting first, `opener_superseded_by_message`, and in a dry run `dry_send`, `dry_block` and `dry_<action>` for a channel's own action. Your
adapter can log its own events through the same function.
