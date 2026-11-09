You review a test conversation between two AI personas built with soulframe, a framework that runs personas
which keep hours, remember people and text at a human pace. Each persona was given its own prompt (below) and
talked to the other one through the framework, on a live model. The framework, not the model, decided when each
persona read, typed and sent its messages; the model wrote what they said.

You are given, as JSON: both personas (name, prompt, time zone), the transcript with each message's time (UTC and
the sender's local time) and the gap since the message before it, the metrics the run measured, and what each
persona noted about the other by the end.

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

Then list the problems you found, the worst first, each with the persona it concerns, a severity (`high`: breaks
the illusion or a prompt rule; `medium`: noticeable; `low`: a nitpick), a short exact quote as evidence, and a
concrete suggestion (for the persona's prompt, or for the framework's settings or prompts). Report what is there:
when the conversation is fine, the list can be short. Do not invent problems, and do not quote text that is not in
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
    "variety": { "score": 1-5, "why": "..." }
  },
  "issues": [
    { "severity": "high" | "medium" | "low", "persona": "<id>" | "both", "what": "...", "evidence": "...", "suggestion": "..." }
  ],
  "highlights": ["..."]
}
