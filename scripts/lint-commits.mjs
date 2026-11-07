// Checks commit subjects against Conventional Commits 1.0.0 (see CONTRIBUTING.md, "Commit messages").
// Usage: node scripts/lint-commits.mjs [<git revision range>]   (default: origin/main..HEAD)
import { execFileSync } from 'node:child_process';

const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert'];
const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9-]+\\))?!?: [^A-Z\\s].*[^.\\s]$`);
const MAX_SUBJECT = 72;
// An AI assistant is never credited in a commit (see CONTRIBUTING.md, "No AI attribution").
const AI_CREDIT = /^co-authored-by:.*(claude|anthropic|copilot|chatgpt|openai|gemini)|generated (with|by).*(claude|anthropic|copilot|chatgpt|gemini)/im;

const range = process.argv[2] ?? 'origin/main..HEAD';
const log = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%B%x1e', range], { encoding: 'utf8' });

const problems = [];
for (const entry of log.split('\x1e')) {
	const [hash, subject, message = ''] = entry.trim().split('\x1f');
	if (!hash || !subject) continue;
	if (subject.startsWith('Merge ')) continue;
	if (AI_CREDIT.test(message)) problems.push(`${hash.slice(0, 7)} "${subject}": credits an AI assistant (no Co-Authored-By or "Generated with" lines)`);
	if (!SUBJECT.test(subject)) problems.push(`${hash.slice(0, 7)} "${subject}": not "type(scope): lowercase imperative description" with a type in ${TYPES.join(', ')}`);
	else if (subject.length > MAX_SUBJECT) problems.push(`${hash.slice(0, 7)} "${subject}": subject is ${subject.length} characters, the limit is ${MAX_SUBJECT}`);
}

if (problems.length > 0) {
	console.error(`Commit messages that do not follow Conventional Commits (see CONTRIBUTING.md):\n- ${problems.join('\n- ')}`);
	process.exit(1);
}
console.log(`Commit messages OK (${range}).`);
