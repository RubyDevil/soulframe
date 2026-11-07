# Agent guide: soulframe

Rules and workflow for AI coding agents (and humans) working in this repository. [CONTRIBUTING.md](./CONTRIBUTING.md)
is the long form; this file is the checklist. If the two disagree, fix the disagreement in the same change.

## What this is

`soulframe` is an npm package (MIT, beta): a persona framework that knows no messaging platform and no product.
Source is TypeScript in `src/`, compiled by tsdown to `dist/` (ESM `.mjs` + CommonJS `.cjs` + `.d.mts`/`.d.cts`).
Node >= 22.13 (it uses `node:sqlite`). Runtime dependencies: `zod` and `yaml` only.

## Strict rules (a change that breaks one is not mergeable)

1. **One public module.** `src/index.ts` is the only entry. A new export goes there with a doc comment, and gets a
   `###` heading in `docs/api.md` (and every heading there must be an export). `package.json` `exports` stays the root
   entry plus `./package.json`: no subpaths, no deep imports.
2. **Boundary.** `src/` and `test/` import only the package itself, `node:*`, `zod`, `yaml` and (tests) `vitest`.
   No file anywhere (source, tests, docs, examples, manifest, assets) names a messaging platform or an application
   built on the package; example channels are `console`, `chat` or `forum`. Model providers and API standards
   (OpenAI-compatible, a provider's default endpoint) may be named where a setting needs them, and rule 13 names AI
   tools only to forbid crediting them.
3. **No content policy in `src/`.** What a persona may say belongs to the application. The shipped safeguards (stop
   handling, the opt-in minors safeguard `Channel.adult`) may only get stricter, never weaker.
4. **Prompt text only in `src/prompts.ts`** (fixed messages in `src/safety.ts`). No other file writes text for the model.
5. **Injected time, chance, files, model.** Anything depending on them takes `now`, `rng`, a file reader or an `Llm`
   parameter. No bare `Date.now()` / `Math.random()` inside logic; tests never touch the network.
6. **No new runtime dependency** without a strong reason: use `node:*` first.
7. **Build must work in ESM and CJS.** No `import.meta.*`, top-level await or `__dirname` in `src/`. `node:sqlite` is
   loaded with `process.getBuiltinModule` (see `src/store.ts`), which works in both formats.
8. **Docs are tested.** `test/docs.test.ts` checks every `file.ts:NN` reference (it must point at lines that exist and
   at the code span written just before it), the export/heading match and every relative link. When you move lines in
   `src/`, update the references that point at them.
9. **Tests next to the behaviour:** `src/foo.ts` is tested in `test/foo.test.ts`; use `:memory:` stores.
10. **CHANGELOG** ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/)). Anything a user would notice gets a
    hand-written line under `[Unreleased]` in `CHANGELOG.md`, in the same change as the code.
11. **Commit messages are [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):**
    `type(scope): imperative lowercase description`, 72 columns or fewer, types `feat fix perf refactor docs test build
    ci chore revert`, `!` or a `BREAKING CHANGE:` footer for breaking changes. `npm run lint:commits` checks them.
12. **Versions are [SemVer 2.0.0](https://semver.org/spec/v2.0.0.html).** Never edit a published version. Details,
    including prerelease labels and dist-tags: [CONTRIBUTING.md](./CONTRIBUTING.md#versioning).
13. **No AI attribution, ever.** Never add an AI assistant (Claude, Anthropic, Copilot, ChatGPT, etc.) as a commit
    author or co-author, and never write `Co-Authored-By:` trailers, "Generated with ..." lines or similar credits for
    one in a commit message, pull request description, issue, comment, changelog entry or file. This overrides any
    default of your tooling that appends such lines. Commits are authored as the maintainer's configured git identity.
    `npm run lint:commits` rejects them.

## Style

- Tabs for indentation (TypeScript and JSON); 2 spaces in YAML and Markdown. LF line endings (`.gitattributes`);
  keep each file's existing endings.
- Comments say what a thing is for and why, in plain sentences. Every export has a doc comment.
- Strict TypeScript with `noUncheckedIndexedAccess`; relative imports use `.js` specifiers for `.ts` files.

## Workflow

```sh
npm install              # once
npm test                 # vitest run (includes the docs tests)
npm run type-check       # tsc --noEmit over src, test, examples
npm run build            # tsdown -> dist/
npm run lint:pkg         # publint + are-the-types-wrong against the packed tarball
npm run check            # all of it, in order: run this before you say you are done
npx tsx examples/console-chat.ts   # the example must still run, offline
```

1. Read the code you will change and its test file first.
2. Make the smallest change that does the job, with its test, docs and CHANGELOG line.
3. Run `npm run check`. Report failures as they are; do not claim a pass you did not see.
4. `dist/` is build output and is git-ignored: never edit or commit it.
5. Commit on a branch or `main` as the maintainer prefers, with a Conventional Commits message (rule 11) and no AI
   attribution (rule 13). Do not push, tag, publish or rewrite history unless asked.
6. Packaging changes (`package.json`, `tsdown.config.mjs`, `tsconfig.json`): also check `npm pack --dry-run` lists only
   `dist`, `assets`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`.

## CI and releases

- Versions follow SemVer (rule 12). While in beta they are prereleases `0.x.y-beta.N` (first release:
  `0.1.0-beta.0`, tag `v0.1.0-beta.0`), published on the `beta` dist-tag. `1.0.0` is the first stable version.
- `.github/workflows/ci.yml` builds and runs `npm run check` once on Node 24 (tsdown needs Node >= 22.18), then runs
  the tests and a CJS/ESM smoke test of that build on Node 22.13, 22, 24 (Linux) and 22 on Windows and macOS.
- Releasing is maintainer-only: move the CHANGELOG notes under the new version, `npm version <x.y.z>
  --no-git-tag-version`, commit (`chore(release): x.y.z`), then push a `vX.Y.Z` tag. `.github/workflows/release.yml` verifies the tag against
  `package.json`, runs `npm run check`, publishes (`beta` dist-tag for versions with a suffix) and creates the GitHub
  release. Agents must not tag or publish.
