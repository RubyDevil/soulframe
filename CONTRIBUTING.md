# Contributing to soulframe

Thanks for helping. soulframe is beta and lives in its own repository,
[RubyDevil/soulframe](https://github.com/RubyDevil/soulframe). Everything below runs from the root of a clone.

## Setup

You need Node.js **22.13 or newer** and npm.

```sh
git clone https://github.com/RubyDevil/soulframe
cd soulframe
npm install
```

The package has no build step: its source is TypeScript, run by `tsx` and Vitest. The example and the docs import it
by its own name, `soulframe`, which Node resolves to this folder through the `exports` of `package.json`.

## Checks

```sh
npm test                          # vitest run: every test/**/*.test.ts
npm run type-check                # tsc --noEmit over src, test and examples
npx tsx examples/console-chat.ts  # the example still runs, offline
```

A pull request keeps all three green. Run one test file with `npx vitest run test/brain.test.ts`.

`npm test` checks the docs too (`test/docs.test.ts`):

- a code reference, `file.ts:NN`, `src/file.ts:NN`, a range `file.ts:NN-MM` or a list `file.ts:NN, :MM` (the file
  under `src/`), must point at existing lines; the first of a list must also hold one of the names in the code span
  written just before it, such as `` `compose` (brain.ts:330) `` or `` (`checkIncoming`, brain.ts:272-281) ``. Write
  that span when you add a reference: it is what keeps the reference from drifting silently. A failure names the
  nearest line that holds the name;
- every export of `src/index.ts` has its `###` heading in `docs/api.md`, and every heading there is an export;
- every relative link and `#anchor` in the package's Markdown resolves.

## The boundary

soulframe stays independent of any application that uses it. An application that embeds the package (as a workspace
under its `packages/soulframe`) may enforce these rules with its own test:

1. The package's `src` and `test` import only the package itself, `node:*` modules, its own dependencies (`zod`,
   `yaml`) and, in tests, `vitest`.
2. An application reaches the package only by its bare name, `soulframe`: no relative path into the package's
   folder, no subpath such as `soulframe/src/...`.
3. No file of the package (source, tests, docs, examples, manifest, assets) names a messaging platform or a product.
   Channels are opaque `ChannelId` strings the application chooses.
4. `package.json` exports exactly `{ ".": "./src/index.ts" }`: `src/index.ts` is the only public module. A new export
   goes there, with its doc comment, and into [docs/api.md](./docs/api.md).

A channel in an example is `console`, `chat` or `forum`. The package keeps no application's history: an application's
own database layouts, and their migrations, are the application's.

## Style

- **Tabs** for indentation, in TypeScript and JSON alike.
- **Keep each file's line endings** as they are; new files use LF.
- Comments say what a thing is for and why, in plain sentences; every export has a doc comment.
- No new runtime dependency without a good reason: `node:*` first.
- Everything time- or chance-dependent takes injected `now` and `rng`, so tests can fix them.
- **Tests next to the behaviour**: a change to `src/schedule.ts` comes with a test in `test/schedule.test.ts`, one to
  the reply queue in `test/runtime.test.ts`, and so on. Tests use `:memory:` stores and never the network.
- The package ships no content policy and no product voice: what a persona is and may say is the application's to
  decide (its model, `identity`, `style`, `policy` and channel `notes`), so no rule, filter or product wording of that
  kind goes into `src/`. What the package does ship only ever gets stricter:
  a change that weakens the stop handling or the opt-in minors safeguard (`Channel.adult`) will not be merged.
- Prompt text lives in `src/prompts.ts` (and the fixed messages in `src/safety.ts`): no other file writes text for the
  model.

## Changes and releases

Add a line under `[Unreleased]` in [CHANGELOG.md](./CHANGELOG.md) for anything a user of the package would notice.
The package is not published yet and no license has been chosen; until one is, contributions are accepted on the
understanding that the owner will choose the license for the first release.
