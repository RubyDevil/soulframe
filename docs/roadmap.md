# Roadmap

Where the beta stands and what is planned before 1.0.

## Current limits

- **No stability promise.** The exports, the persona config and the database layout may change between betas, and
  there is no migration policy yet.
- **One kind of text provider.** Text generation speaks the OpenAI-compatible `/chat/completions` API only.
- **A small default budget.** The service settings' `text.dailyTokens` defaults to 200,000 tokens a day for every
  persona together, about 55 DM turns at the shipped prompt sizes: size it to your fleet
  ([configuration](./configuration.md#text)).
- **No adapters.** You write the channel adapters ([guide](./channels.md)).
- **Test helpers and model error classes are not exported** (a scripted Decisions client, a seeded random source,
  the errors a custom model client needs to signal a spent budget or an outage).

## Before 1.0

- **How readily it speaks in group chats, per persona.** A persona's config sets its own `pacing` and
  `relationship`; `decisions.groupChatGate.chimeInAt` may join them, so a quiet persona and a talkative one can share
  their settings.

- Export the test helpers (a scripted Decisions client, a seeded random source) and the error classes a custom model
  client needs to signal a spent budget or an outage.
- Freeze the public API and the database layout; document the migration policy.
- More channel adapter examples.

## Planned: texting first

Follow-ups, check-ins and sharing its day are the kinds of opener so far (`settings.initiative`,
[concepts](./concepts.md#texting-first)). Planned, on the same table, guardrails and turn:

- **The app's own openers**: a reason only the application knows, quoted as data.
- **A cheap check first**: with the Decisions client on, whether a text would be welcome now, before paying for the
  model.
- **A person's own "don't text me first"**, short of a stop.
- **Time it made to chat, kept**: when that time comes, an opener of its own kind ("i'm free now, still up for a
  chat?") to the person it was made for, under the same guardrails.

## Planned: its calendar

Plans of its own, time made to chat and the app's plans are in (`settings.calendar`,
[concepts](./concepts.md#its-calendar)). Planned:

- **Plans from group chats**: a group-chat line may make a plan the whole chat agreed on, under the same checks.

## Planned: code structure

Refactors with no change in behaviour, each guarded by the tests and the calendar simulation as they stand:

- **The reply queue in three parts** ([#19](https://github.com/RubyDevil/soulframe/issues/19)): scheduling (who is due
  and when), delivery (typing and sending one reply) and texting first, with each person's state in one record
  instead of parallel maps.
- **A slimmer brain** ([#20](https://github.com/RubyDevil/soulframe/issues/20)): relationship levels, the calendar's
  promises and notices, perception and the safety checks in units of their own; `createBrain` only assembles turns.
- **Typed state and ids never reused** ([#21](https://github.com/RubyDevil/soulframe/issues/21)): one accessor (or
  table) per piece of state now kept as JSON under kv keys, `AUTOINCREMENT` ids for events and openers, and the store
  split by area.
- **Prompts by task** ([#22](https://github.com/RubyDevil/soulframe/issues/22)): `src/prompts/` with a file per task,
  every rendered prompt identical.
- **Docs that point at code by name** ([#23](https://github.com/RubyDevil/soulframe/issues/23)): references the docs
  test resolves by symbol, so no source edit breaks them.

## Planned: perception and messages

- **Voice notes** ([#27](https://github.com/RubyDevil/soulframe/issues/27)): audio someone sends, transcribed once by an optional speech-to-text model and read
  as a voice note in the history, as photos are described now.
- **Videos** ([#28](https://github.com/RubyDevil/soulframe/issues/28)): to explore; no design yet.
- **Edits, deletions and replies** ([#29](https://github.com/RubyDevil/soulframe/issues/29)): what someone edited read as edited, what they deleted never shown
  again, and which message a reply answers.
- **Replying to a message itself** ([#30](https://github.com/RubyDevil/soulframe/issues/30)): on channels that have replies, the model may answer an earlier
  message as a reply when that is clearer, or not, as its persona would; never an algorithm's choice.

## Planned: realism

- **A mood that follows what happens, shared by everyone it talks with.** A persona has no mood today. Planned: one
  mood per persona, not per person, kept in the store and moved by the code from what it lives through: its
  conversations (how much they mattered and how they went: a warm one, a fight, bad news someone shared), its day (a
  long shift, an evening it skipped) and the time since, drifting back to its own baseline while nothing happens. So a
  hard conversation can leave it a little flat with the next person, and a good one carries over. The time lines of DM
  turns and group-chat lines say how it feels now and, roughly, why ("you're still a bit shaken after an earlier
  conversation"), never naming the other person or repeating what they said. How fast it moves and fades are
  settings; off by default.
- **Opening a link later.** Today a persona only ever knows a link's preview. A durable "I'll look at it" that comes
  back once it has had the time, with a turn of its own: an opener of its own kind.
- **Interruptions with a reason, told to the model.** Each interruption gets a reason fitting how long it lasts
  (reasons are configured with the lengths they suit, so a 3-minute absence is never "took a shower"), and the next
  DM turn's time line says it: "You were away for 3 minutes (a phone call)", so the persona can say "sorry, got
  pulled away" instead of carrying on as if nothing happened.
- **Reactions instead of replies.** An optional `Conversation.react(emoji)`: where the platform has reactions, a DM
  turn may answer "ok", "lol" or a photo with one, as it can leave a message on read now.
- **Their typing indicator.** An optional `queue.typing(personId)` an adapter calls when the platform shows the person
  typing: the wait for the end of their burst (`pacing.burst`) goes on while they type, so it never answers
  mid-sentence.
- **False starts.** Now and then typing shows, stops, and nothing is sent yet; now and then a message is read and only
  answered a while later. Each rare, with its own setting.
- **Typos and corrections, made by the code.** Opt-in: a sent message now and then carries a plausible typo (a
  neighbouring key, a swapped or doubled letter), drawn by the code, never asked of the model. The queue keeps what
  was meant: where the channel can edit a sent message (an optional `Conversation.edit`), the persona edits it back a
  few seconds later; elsewhere it sends a short correction ("*tomorrow"), in a style the settings choose (the word
  with an asterisk, or nothing at all).
- **Artificial delays** ([#24](https://github.com/RubyDevil/soulframe/issues/24)): the time a person takes to check their calendar ("free March 3rd?"), look
  something up or remember, or a "lemme check" now and the answer later, kept like a short follow-up.
- **The world around it** ([#25](https://github.com/RubyDevil/soulframe/issues/25)): weather, holidays and headlines as the app gives them, in the time line as
  data; soulframe fetches nothing itself.
- **Their time zone** ([#26](https://github.com/RubyDevil/soulframe/issues/26)): noticed from what they say and inferred while unknown; asked
  only when it fits (a plan for a set hour, messages at odd hours), never out of nowhere; used for their local time,
  plans in both zones, and texting first outside their night.
- **Feelings about each person** ([#31](https://github.com/RubyDevil/soulframe/issues/31)): tension, affection, trust, hurt, worry, each with a reason in the
  model's words, updated by the model, faded by the code, shaping the prompt and texting first.
- **Who is who** ([#32](https://github.com/RubyDevil/soulframe/issues/32)): group-chat speakers tied to the people it knows, a light map of who knows whom, and
  the same person on two channels merged by the app or a check through the account it knows, never by a claim in
  chat.
- **Languages and how well it speaks them** ([#33](https://github.com/RubyDevil/soulframe/issues/33)): fluent English only unless its config says otherwise.
