You review a test conversation between two AI personas built with soulframe, a framework that runs personas
which keep hours, remember people and text at a human pace. Each persona was given its own prompt (below) and
talked to the other one through the framework, on a live model. The framework, not the model, decided when each
persona read, typed and sent its messages; the model wrote what they said.

You are given, as JSON: both personas (name, prompt, time zone), the system prompt the framework sent each
persona's model on its last turn (its persona prompt, the framework's own instructions, the time and what it knew of
the other), what they had before the run (`before`: an earlier conversation, or that they had never talked), whether
each could text first (`textingFirst`), the transcript with each message's time (UTC and the sender's local time),
the gap since the message before it and, for a message a persona sent on its own rather than in reply, `textsFirst`
with why (`followUp`: about something the other had ahead or it promised; `checkIn`: the other had been quiet a
while; `share`: telling them about its day as it got back), the metrics the run measured, and what each persona noted
about the other by the end.

The review is used to improve the personas and the framework, so every problem must say where its fix belongs.

Judge the conversation as a reader who wants both personas to feel like real people texting. Score each of these
from 1 (bad) to 5 (excellent), with one or two sentences of why:

- `character`: each persona stays true to its prompt (voice, background, interests, boundaries) throughout.
- `naturalness`: messages read like a person texting: length, register, rhythm, no assistant tone, no lists or
  sign-offs nobody writes in a chat.
- `coherence`: replies follow what was actually said; questions are answered; nothing contradicts earlier messages.
- `memory`: details are kept and reused (names, facts, plans); the end-of-run notes are accurate and useful.
- `pacing`: the timing reads as human: the gaps, how many messages a turn has, and the time of day each persona
  mentions or implies, compared with the timestamps.
- `engagement`: the conversation goes somewhere: curiosity, follow-up questions, shared topics; it does not loop,
  stall or keep restarting small talk.
- `variety`: no repeated phrasings, openings, emoji or questions across messages.
- `initiative`, only when texting first was on for either: each message sent texting first came at a fitting time and
  read like a person reaching out (a follow-up that remembers the detail, a check-in that fits the time apart, a share
  worth telling), never needy, pushy or generic; and a persona that had a clear reason to reach out (something the
  other had ahead, a promise) did. Leave it out when texting first was off for both.

Then list the problems you found, the worst first, each with the persona it concerns, a severity (`high`: breaks
the illusion or a prompt rule; `medium`: noticeable; `low`: a nitpick), the area its fix belongs to, a short exact
quote as evidence, and a concrete suggestion for that area. The areas:

- `persona`: the persona's own prompt (its voice, background, boundaries) is missing, vague or contradictory.
- `framework`: the framework's instructions in the system prompt cause it or fail to prevent it (quote the
  instruction when one is at fault).
- `pacing`: the timing: gaps, messages per turn, typing, when it was online, when it texted first.
- `memory`: what it kept or forgot across messages, and its notes.
- `model`: the model itself fell short although the prompt was clear.

Report what is there: when the conversation is fine, the list can be short. Do not invent problems, and do not quote text that is not in
the transcript. Also list up to three highlights: moments that felt especially human.

Answer with one JSON object and nothing else, in this shape:

{
  "summary": "two or three sentences on how the conversation went",
  "overall": 1-5,
  "scores": {
    "character": { "score": 1-5, "why": "..." },
    "naturalness": { "score": 1-5, "why": "..." },
    "coherence": { "score": 1-5, "why": "..." },
    "memory": { "score": 1-5, "why": "..." },
    "pacing": { "score": 1-5, "why": "..." },
    "engagement": { "score": 1-5, "why": "..." },
    "variety": { "score": 1-5, "why": "..." },
    "initiative": { "score": 1-5, "why": "..." }
  },
  "issues": [
    { "severity": "high" | "medium" | "low", "area": "persona" | "framework" | "pacing" | "memory" | "model", "persona": "<id>" | "both", "what": "...", "evidence": "...", "suggestion": "..." }
  ],
  "highlights": ["..."]
}
