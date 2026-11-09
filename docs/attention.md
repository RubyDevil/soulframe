# Attention, timing and relationships

How a persona decides **when** it answers, **who** it answers first, and **how well it knows and likes** each person,
with every setting that changes it explained in plain terms. The [configuration reference](./configuration.md#settings)
lists the same keys in tables, with their types and ranges; this page says what each one does, and what to expect when
you change it. All of them are settings of a persona's brain (`createBrain({ settings })`): one object for every
persona, or one of their own for a persona that should answer differently.

- [The model in one minute](#the-model-in-one-minute)
- [`relationship`: getting to know and like each person](#relationship-getting-to-know-and-like-each-person)
- [`pacing.watching`: on its phone](#pacingwatching-on-its-phone)
- [`pacing.glance`: off its phone](#pacingglance-off-its-phone)
- [`pacing.interruptions`: short absences while online](#pacinginterruptions-short-absences-while-online)
- [`pacing.priority`: who goes first](#pacingpriority-who-goes-first)
- [`pacing.burst`: people who write in bursts](#pacingburst-people-who-write-in-bursts)
- [`decisions.importance`: knowing what matters before the model reads it](#decisionsimportance-knowing-what-matters-before-the-model-reads-it)
- [Drawn ranges and their shapes](#drawn-ranges-and-their-shapes)
- [Coming from 0.1.0-beta.0](#coming-from-010-beta0)

## The model in one minute

- **One person at a time.** While it writes or sends a reply to someone, nobody else's reply starts. When that reply
  is sent it moves straight on to whoever is waiting; it never waits for the person it just answered.
- **On its phone, or not.** While it writes a reply to anyone, and for a while after, it is on its phone: a message from
  anyone is noticed within seconds. Off its phone, it notices messages when it next looks at them, one look for
  everyone: whoever wrote before that look is noticed at once.
- **Who goes first** when several are waiting is drawn at random by weight: how close it is to them, how much their
  conversation matters right now, whether it still has their chat open, and how long they have waited.
- **Now and then it is away** for a few minutes, never in the middle of a conversation that matters.
- **Bursts.** It waits for someone who writes several messages in a row to stop, and answers them together.
- **Relationships.** It gets to know people (familiarity) and comes to like or dislike them (affinity), slowly, from
  what their conversations meant. The prompt describes both in sentences you can rewrite.

The agenda (online hours, breaks, busy blocks) decides when it is online at all; everything here happens inside that
online time. See [concepts](./concepts.md#agenda-spans-busy-blocks-and-the-situation).

## `relationship`: getting to know and like each person

Two numbers are kept for each person, in the database (`Person.familiarity`, `Person.affinity`). **Familiarity**, 0 to
1, is how well the persona knows them: it is counted by the code, never set by the model. **Affinity**, -1 to 1, is how
it feels about them: the model moves it one small step at a time, never sets it outright. Both change only when a
reply is kept (sent, or the turn otherwise committed), never for a draft that was dropped.

| Key | Default | What it does |
| --- | --- | --- |
| `familiarity.growth` | `0.012` | How fast it gets to know someone. Each kept turn adds this share of what is left to know (1 - familiarity), times how much the turn mattered: small talk a quarter, an ordinary chat once, something personal 2.5 times, something that matters a lot 5 times. A stranger is at 0.012 after one ordinary turn, 0.06 after one deep one. Raise it to make it warm up faster. |
| `familiarity.fadeHalfLifeDays` | `60` | How fast it fades apart: after 60 days without a word, half of it is left. Counted when they next write. `0`: it never fades. |
| `familiarity.levels` | the shipped seven | The sentences the prompt uses, and where each starts: `{ from, text }`, `{name}` for their name. Replaces the shipped list whole; the first starts at 0, each above the one before. |
| `affinity.enabled` | `true` | Off: the model is asked nothing about it, the prompt says nothing of it, and it weighs nothing in who goes first. |
| `affinity.step` | `0.05` | How far one turn moves it. The model answers -1 (a little cooler), 0 (no change, most of the time) or 1 (a little warmer). Larger, its feelings swing faster. |
| `affinity.fadeHalfLifeDays` | `0` | How fast it drifts back to neutral while they are apart. `0`: never, so a grudge or a fondness keeps. |
| `affinity.levels` | the shipped five | As `familiarity.levels`, from -1. An empty `text` says nothing: the shipped neutral level is empty. |
| `hysteresis` | `0.05` | Keeps the level from flip-flopping when a value sits on a threshold: it goes up as soon as the value reaches a level, but back down only once it is this far below that level's start. |

The levels are set once, when a conversation starts (a message after `memory.conversationGapHours` of silence), and
kept for all of it: the tone never changes in the middle of a chat. With them comes the way things went lately: "You've
grown closer lately." when familiarity rose well above its slow-moving average, "It's been a while, and things feel a
little more distant than they were." when time apart cost some of it. Nothing is said on a first conversation.

The shipped familiarity levels, from 0, 0.08, 0.18, 0.32, 0.48, 0.65 and 0.82: still getting to know them; have talked
a few times; starting to feel at ease; one of your regulars; getting close; close; one of the people closest to you.
The shipped affinity levels, from -1, -0.6, -0.2, 0.2 and 0.6: hard to warm to (polite but guarded); rubs you the wrong
way now and then; nothing said; you like them; you're really fond of them. Their exact words, and how the line is
put together, are in [system prompts](./prompts.md) (`FAMILIARITY_LEVELS`, `AFFINITY_LEVELS`).

Your own levels, with thresholds of your own:

```yaml
settings:
  relationship:
    familiarity:
      levels:
        - { from: 0, text: "{name} is new here; you're still a bit formal." }
        - { from: 0.25, text: "You and {name} chat often and easily." }
        - { from: 0.6, text: "{name} is a friend: you joke around and check in on each other." }
    affinity:
      enabled: false
```

A database made by `0.1.0-beta.0` is upgraded when the store opens: familiarity starts from each person's
conversations so far (1 - 0.9^n: 2 make them at ease, 5 a regular, 12 close), so nobody who was close becomes a
stranger.

## `pacing.watching`: on its phone

While it writes a reply to anyone, and for a while after, the persona is on its phone, and a new message from anyone
is noticed after a short lag: chatting with one person does not leave another waiting for its next look. They still
wait for the reply under way to be sent, since it answers one person at a time.

| Key | Default | What it does |
| --- | --- | --- |
| `halfLifeSeconds` | `90` | How long it stays on its phone after its last reply to anyone. Right after it, certainly; after 90 seconds, half the time; after 3 minutes, a quarter. Raise it for a persona that keeps its phone in hand. An interruption since then means it put the phone down. |
| `chatHalfLifeSeconds` | `90` | The same for one person's chat: the chance it still has their chat open. It changes no one's timing: it only gives that person up to three times the weight when several are waiting. |
| `medianSeconds` | `4` | The lag before it notices a message while on its phone: half are shorter than this. |
| `p90Seconds` | `8` | Nine in ten lags are shorter than this. |
| `delaySeconds` | `[2, 20]` | The shortest and longest lag. |

On a short break it is on its phone the whole time: this lag is the only delay there.

## `pacing.glance`: off its phone

Off its phone, it looks at its messages now and then. There is one next look for everyone, drawn when the first
message comes in; everyone who writes before it is noticed at that look, together, and picked among by weight. When it
picks up its phone for someone's turn (a reply coming due, a catch-up reply as it comes online), whoever was still
waiting for the look is noticed then.

| Key | Default | What it does |
| --- | --- | --- |
| `medianSeconds` | `40` | Half its looks come sooner than this. |
| `p90Seconds` | `150` | Nine in ten come sooner than this: how long the slow tail is. |
| `delaySeconds` | `[4, 900]` | Never sooner than 4 seconds or later than 15 minutes. The least is also the shortest time a reply must still fit before its online time ends. |

The looks are skewed like the time people really take: most within a minute, around a typical 15 to 40 seconds, and
now and then several minutes. A persona that checks rarely: `medianSeconds: 120`, `p90Seconds: 600`.

## `pacing.interruptions`: short absences while online

Now and then, while online (not on a short break), something takes it away from its messages for a few minutes.
Nobody's reply starts until it is back; one it was typing is finished first; and it is off its phone when it comes
back. They are drawn per day from the persona's seed, as its agenda is, so a restart finds the same ones, and the
config check (`personaReport`) lists today's.

| Key | Default | What it does |
| --- | --- | --- |
| `meanMinutes` | `40` | How often: on average once every 40 minutes of online time, at random moments. `0` for none; otherwise at least 1. |
| `minutes` | `[2, 8]`, lognormal | How long each lasts, never past the end of its online time. |
| `holdAtImportance` | `2` | Keeps it from walking out of a conversation that matters. While someone whose conversation was rated at least this (0 small talk, 1 ordinary, 2 something personal, 3 something that matters a lot), within the last `priority.importanceHalfLifeMinutes`, is in an exchange with it, an interruption waits. `4`: never waits. |
| `calmMinutes` | `5` | How long that conversation must be quiet before the interruption it held off comes, for the time it had left. |

An exchange means a message within `calmMinutes`, or a reply of theirs coming or under way (not a retry, nor a wait
for the token budget). Going offline at the end of its online hours is its agenda's, and comes whatever the
conversation: an interruption still held then is dropped. One is held at a time.

## `pacing.priority`: who goes first

It answers one person at a time. When several are waiting at once, the next is drawn at random, each person weighing:

- **closeness:** `1 + familiarity`, times `1 + affinity / 2` while affinity is kept;
- **how much their conversation matters now:** from 1 (small talk) to 4 (something that matters a lot), 2 for an
  ordinary chat, fading back to 2 over `importanceHalfLifeMinutes`;
- **whether it still has their chat open:** up to three times as much (`watching.chatHalfLifeSeconds`);
- **how long they waited:** `1 + waited / agingMinutes`.

So a close friend's confession usually goes before a stranger's "hey", and the "hey" still gets in soon. The pick is
made again at every reply, so an active, important chat comes back to the front by itself.

| Key | Default | What it does |
| --- | --- | --- |
| `weighted` | `true` | `false`: in the order they came due, ignoring every weight. |
| `agingMinutes` | `2` | How fast waiting counts: every 2 minutes of it add their whole weight again (twice it after 2 minutes, four times after 6), so nobody waits forever. Lower it to make waiting count for more. |
| `importanceHalfLifeMinutes` | `30` | How fast a conversation's importance fades back to an ordinary chat's in the pick: a confession counts fully at once and half as much 30 minutes later. The same window says whether a rating is recent enough to hold an interruption off. |

Where the importance comes from: the model rates each turn it writes (0 to 3, in the DM answer format), and with the
Decisions API on, a typed check can rate new messages before the model reads them (below).

## `pacing.burst`: people who write in bursts

| Key | Default | What it does |
| --- | --- | --- |
| `settleSeconds` | `[2, 5]`, lognormal | How long they must be quiet before it starts writing the reply. Each new message starts the wait again. `[0, 0]`: no wait. |
| `maxSettleResets` | `3` | How many messages may start that wait again; past them it starts anyway, so someone who never stops still gets a reply. |
| `restartOnNewMessage` | `true` | A message that comes in while the reply is being written, before its first message goes out, drops the draft: it is written again with that message read. `false`: the reply goes out as planned, and the message gets a reply of its own after. Once the first message of a reply is being sent, it is never restarted. |
| `maxRestarts` | `1` | How many times in a row one reply may be dropped and written again. Each dropped draft cost a whole reply's tokens: the config check warns above 1. |

Nothing of a dropped draft is sent or kept: its notes, block, action and the change it would have made to familiarity
or affinity are thrown away with it.

## `decisions.importance`: knowing what matters before the model reads it

| Key | Default | What it does |
| --- | --- | --- |
| `decisions.importance.enabled` | `true` | Only with the Decisions API on (`decisions.enabled`). Asks how much someone's new messages matter (0 to 3) when their turn comes due while others wait, so the pick weighs a confession before the model has read it, and with the other checks of every DM turn. Usually it rides along with the stop and age checks, at the cost of one more question; with those off, it is a request of its own. Off, or on any failure, the model's own rating of their last turn is used. |

Like the rest of `decisions`, it is in the settings your code gives each brain.

## `perception`: photos and links

The persona knows what someone sees on their phone without tapping: a photo, and a link's preview card, never the page
behind it. So it can't discuss an article two seconds after it was sent.

**A photo** is described once, by `models.vision`, when its turn comes, and the description is stored with the message
in place of the URL. The chat model only ever reads that description, so it needs no vision of its own, and the photo
costs once, however long it stays in the history. Looking takes `pacing.looking` per photo on top of the reading; it
overlaps the model's call, as reading does, so the visible wait is the longer of the two. A description that fails, is
refused or takes over `perception.timeoutSeconds` doesn't stop the reply: the persona goes by the photo's `alt` if the app gave one, else
the photo "wouldn't load" and it says so in its own way. It stays that way: there is no second try. Each failed call is audited (`image_unseen`).

**A link** shows as its card if the app has one (`IncomingMessage.links`, or `createBrain`'s `previewLink`), else as
its site's name. The URL takes no reading time; the words on a card the app passed in do (a `previewLink` card comes too late for that read). The prompt says it has not opened the link
and won't in this chat: it can react to the headline, ask what's in it, or say it can't look right now, in its own
words and fitting what it is doing. If they ask later, it still hasn't got round to it, so nothing it promised goes
unkept.

The code's stop and age checks read only the person's own words: a headline or a sign in a photo is not them saying
it. The typed checks (`decisions`) also read what a photo shows, never a card, which is someone else's words. With
`decisions` off, a photo gets no age or stop check, the same limit as an unusual way of putting something. No image
moderation is built in: what a vision model accepts is its provider's to decide.

Group chats and posts are out of scope: `GroupChatLine.text` is yours to write.

## Drawn ranges and their shapes

Some settings are a range a value is drawn from each time. Each has a shape, the way its values spread between the
least and the most:

- **`uniform`**: any value as likely as any other;
- **`normal`**: most near the middle, a bell curve with about 95% of them inside the range (the rest at its ends): for
  a speed someone keeps close to;
- **`lognormal`**: most near a typical value low in the range (its geometric middle, √(least × most)), a few out to the
  most: for waits and pauses, the shape of the time people take.

| Key | What is drawn | Default |
| --- | --- | --- |
| `pacing.typingCharsPerSecond` | typing speed | `[3.5, 7]`, normal |
| `pacing.readingCharsPerSecond` | reading speed | `[15, 25]`, normal |
| `pacing.looking` | the time spent on each photo | `[1.5, 5]`, lognormal |
| `pacing.thinkingPauses.seconds` | a pause while typing a long message | `[2, 6]`, lognormal |
| `pacing.burst.settleSeconds` | the quiet waited for after their newest message | `[2, 5]`, lognormal |
| `pacing.betweenReplyMessagesSeconds` | the pause between two messages of one reply | `[0.8, 3.5]`, lognormal |
| `pacing.backlogGapSeconds` | the pause before each catch-up reply as it comes online | `[30, 150]`, lognormal |
| `pacing.returnOnlineReplyDelayMinutes` | the extra wait before the first of them | `[0, 0]`, lognormal |
| `pacing.interruptions.minutes` | how long an interruption lasts | `[2, 8]`, lognormal |
| `retries.delayMinutes` | the wait before a failed model call is tried again | `[1, 4]`, uniform |

Write `[least, most]` to keep a setting's own shape, `{ range: [least, most], shape }` to choose one:

```yaml
settings:
  pacing:
    backlogGapSeconds: [20, 90]                              # still lognormal
    typingCharsPerSecond: { range: [4, 8], shape: uniform }
```

In `Settings`, these read as `{ range, shape }` whichever way they were written. Ranges that are only limits
(`typingDurationSeconds`, `readingDurationSeconds`, `watching.delaySeconds`, `glance.delaySeconds`) have no shape:
a value is kept inside them, not drawn from them.

## Coming from 0.1.0-beta.0

A config that still sets one of these fails to load (`unknown key`). Delete the line, or use what replaced it:

| Removed | Use instead |
| --- | --- |
| `pacing.singlePresence` | nothing: it always answers one person at a time (with it off, parallel replies could overwrite each other's self notes) |
| `pacing.quickReplyChance`, `pacing.slowReplyChance` | nothing: how soon it answers comes from whether it is on its phone (`watching`) or when it next looks (`glance`) |
| `pacing.quickReplyDelaySeconds` | `watching` for the lag while on its phone, `glance` for its next look |
| `pacing.slowReplyDelaySeconds` | the tail of `glance` (`p90Seconds`) |
| `pacing.busyReplyDelaySeconds` | `interruptions` (how often, how long) |
| `memory.relationshipAfter` | `relationship.familiarity.levels`, to place levels where you want them |

Roughly: a persona that answered slowly sets a higher `glance.medianSeconds`; one with long busy gaps sets
`interruptions.minutes` higher; one that answered faster than most sets `glance.medianSeconds` lower and
`watching.halfLifeSeconds` higher.

Unchanged keys whose behaviour changed:

- the drawn ranges above now follow their shape (`[least, most]` still loads, with that setting's default shape);
- `markRead` is called as it starts writing each draft, also for a turn it then leaves on read;
- `brain.compose` stores nothing of a turn until its `keep()` is called (the reply queue does it): code that calls
  `compose` without the queue calls `turn.keep?.()`.
