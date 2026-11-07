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

The source is TypeScript, run directly by `tsx` and Vitest during development and compiled by `npm run build`
([tsdown](https://tsdown.dev/)) into `dist/` (ESM and CommonJS, with type declarations) for publishing. The example and
the docs import the package by its own name, `soulframe`; `tsconfig.json` maps that name to `src/index.ts`, so
type-checking and `tsx` need no build.

## Checks

```sh
npm test                          # vitest run: every test/**/*.test.ts
npm run type-check                # tsc --noEmit over src, test and examples
npx tsx examples/console-chat.ts  # the example still runs, offline
npm run check                     # all of the above's gates plus the build, publint and are-the-types-wrong
```

A pull request keeps these green (CI runs `npm run check` once, then the tests and a smoke test of the build on Node 22.13 and newer, on Linux, Windows and macOS). Run one test file with `npx vitest run test/brain.test.ts`.

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
4. `package.json` exports only the root entry (`"."`, built from `src/index.ts`, plus `./package.json`): `src/index.ts`
   is the only public module. A new export
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
Contributions are accepted under the project's [MIT license](./LICENSE).

To release (maintainers):

1. Move the `[Unreleased]` notes under a new `## [x.y.z] - date` heading in the CHANGELOG.
2. `npm version <x.y.z> --no-git-tag-version`, commit (`Release x.y.z`) and push to `main` once CI is green.
3. `git tag vx.y.z && git push origin vx.y.z`. The `Release` workflow checks the tag against `package.json`, runs
   `npm run check`, publishes to npm (a prerelease such as `0.1.0-beta.1` goes out on the `beta` dist-tag, and only a version without a suffix becomes `latest`) and
   creates the GitHub release from the CHANGELOG.
