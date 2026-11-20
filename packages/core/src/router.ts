import type { Check, Effort, Mode, Route, TaskKind } from './types.js';

/**
 * Smart Router v1: instant, rule-based routing (README §6).
 *
 * For every message it picks the effort, the checks to run afterwards and a
 * one-line reason, from signals it can read without an LLM call: the words in
 * the message (quoted new text excluded), whether an element was picked and
 * where it is written, risky areas, an empty project, how many things are
 * asked at once, whether the last attempt failed or was undone, and the
 * person's Quick/Balanced/Thorough switch. `max` effort is only ever chosen by
 * the "Think harder" button. The signals are kept in the route, so the router
 * log can tune these rules with real outcomes.
 */

export interface RouteInput {
  text: string;
  hasElement: boolean;
  /** Where the picked element is written (file:line:col), when the page has source tags. */
  elementSrc?: string;
  mode?: Mode;
  /** The "Think harder" button: the only way to reach max effort. */
  thinkHarder?: boolean;
  previousFailed?: boolean;
  /** The person undid the last task, a sign it went wrong. */
  previousUndone?: boolean;
  /** The project has no source files of its own yet. */
  emptyProject?: boolean;
}

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

export const EFFORT_LABELS: Record<Effort, string> = {
  low: 'Quick',
  medium: 'Balanced',
  high: 'Careful',
  xhigh: 'Deep',
  max: 'Deepest',
};

/** What "done" means per kind of task (README §6 starting table). The check runner skips what a project can't do. */
const CHECKS: Record<TaskKind, Check[]> = {
  question: [],
  copy: ['page'],
  style: ['page', 'typecheck'],
  component: ['page', 'typecheck'],
  general: ['page', 'typecheck'],
  feature: ['page', 'typecheck', 'build'],
  bug: ['page', 'typecheck', 'build'],
  'new-app': ['page', 'typecheck', 'build'],
};

interface Rule {
  kind: TaskKind;
  effort: Effort;
  test: RegExp;
  /** Match against the whole message, quotes included (copy changes need the quoted new text). */
  withQuotes?: boolean;
  reason: string;
}

const COMPONENT_NOUN =
  '(?:section|component|button|form|card|cards|page|footer|header|navbar|nav|menu|modal|popup|list|table|gallery|testimonials?|pricing|faq|banner|hero|slider|carousel|tabs?|sidebar|map|video)';

// Order matters: the first matching rule wins.
const RULES: Rule[] = [
  {
    kind: 'bug',
    effort: 'high',
    test: /\b(error|exception|stack ?trace|crash(es|ed)?|broken|not working|doesn'?t work|isn'?t working|blank (page|screen)|(page|screen|site)\b.{0,15}\bblank|undefined is not|cannot read|failed to|(type|reference|syntax)error)\b|\n\s+at\s+\S+.*:\d+:\d+/,
    reason: 'Fixing a bug needs careful reading before changing code.',
  },
  {
    kind: 'new-app',
    effort: 'xhigh',
    test: /\b(make|build|create|start)\b.{0,20}\b(an?|my|new)\b.{0,40}\b(app|website|web ?site|site|dashboard|store|shop|platform|saas|tool)\b|\bfrom scratch\b|\bnew project\b/,
    reason: 'A new app touches many files, so it gets the deepest planning.',
  },
  {
    kind: 'copy',
    effort: 'low',
    withQuotes: true,
    test: /\b(change|replace|update|rename|fix|edit|reword|rewrite)\b.{0,40}\b(text|title|headline|heading|label|wording|copy|typo|words?|sentence|paragraph|caption)\b|\b(change|replace|swap|update|rename|reword)\b.{0,60}\bto\s+["“'‘]|\b(change|replace|swap|update|rename|reword)\b.{0,60}["“'‘].{1,120}["”'’].{0,20}\b(with|to|into|for)\s+["“'‘]|\b(make|have|let)\b.{0,40}\bsays?\b/,
    reason: 'A text change is a one-line edit.',
  },
  {
    kind: 'feature',
    effort: 'high',
    test: /\b(database|db|supabase|firebase|postgres|backend|server|api|auth|log ?in|sign ?in|sign ?up|password|payments?|stripe|checkout|e-?mails?|upload|save[sd]?\b.{0,40}\b(to|in|into))\b/,
    reason: 'Data, logins and payments touch several files and need care.',
  },
  {
    kind: 'component',
    effort: 'medium',
    // "add a testimonials section", not "add more space between the cards".
    test: new RegExp(
      `\\b(add|create|insert|put|build)\\s+(?:(?:an?|another|new|some|one|the)\\s+)?(?:(?!(?:more|less|extra|some)\\b)[\\w'-]+\\s+){0,3}${COMPONENT_NOUN}\\b|\\bmake\\s+(?:an?|another)\\s+(?:new\\s+)?(?:[\\w'-]+\\s+){0,2}${COMPONENT_NOUN}\\b`,
    ),
    reason: 'A new section is a contained change in a few files.',
  },
  {
    kind: 'style',
    effort: 'low',
    test: /\b(colou?r|bigger|smaller|larger|size|font|bold|italic|padding|margin|spacing|space|rounded|round(er)?|corners?|border|shadow|align|center|centre|left|right|background|dark mode|width|height|gap|opacity|style|look|darker|lighter|softer|move|brown|blue|red|green|white|black)\b/,
    reason: 'A style tweak is a small, local change.',
  },
];

const EDIT_VERBS = /\b(change|make|add|remove|delete|fix|update|create|build|put|move|replace|rename)\b/;
const QUESTION = /^(what|why|how|where|who|which|when|does|do|is|are|explain)\b/;

/** Areas where a careless change does real damage (README §6): they get at least careful effort and a build. */
const RISKS: Array<{ area: string; test: RegExp }> = [
  { area: 'secrets', test: /\.env\b|\bapi[ -]?keys?\b|\bsecrets?\b|\b(access|auth) tokens?\b/ },
  { area: 'packages', test: /\bpackage\.json\b|\bnpm\b|\bdependenc(y|ies)\b|\b(install|upgrade)\b.{0,30}\b(package|library|plugin)s?\b/ },
  { area: 'logins', test: /\b(log ?in|log ?out|sign ?in|sign ?up|auth\w*|passwords?)\b/ },
  { area: 'payments', test: /\b(payments?|stripe|checkout|billing|subscriptions?|invoices?)\b/ },
  { area: 'data', test: /\b(database|schema|migrations?|supabase|firebase|postgres|sql|prisma)\b/ },
];

/** The message without quoted text: "change it to 'Pay now'" is a text change, not a payments task. */
export function withoutQuotes(text: string): string {
  return text.replace(/"[^"]*"|“[^”]*”|‘[^’]*’|(^|[\s(])'[^']*'(?=$|[\s.,!?;:)])/g, '$1 ');
}

/** How many separate things a message asks for (bullets, semicolons, "also"). */
function asks(plain: string): number {
  const bullets = (plain.match(/\n\s*(?:[-*•]|\d+[.)])\s/g) ?? []).length;
  const joins = (plain.match(/;|\balso\b|\band then\b/g) ?? []).length;
  return 1 + bullets + joins;
}

/** One effort level up or down. `max` stays put, and nothing but Think harder goes past `xhigh`. */
export function shiftEffort(effort: Effort, by: number): Effort {
  if (effort === 'max') return 'max';
  const i = LEVELS.indexOf(effort);
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, i + by))];
}

export function routeTask(input: RouteInput): Route {
  const text = input.text.toLowerCase().trim();
  const plain = withoutQuotes(text);
  const signals: string[] = [];

  let kind: TaskKind;
  let effort: Effort;
  let reason: string;
  const rule = RULES.find((r) => r.test.test(r.withQuotes ? text : plain));
  if (QUESTION.test(plain) && plain.trim().endsWith('?') && !EDIT_VERBS.test(plain)) {
    kind = 'question';
    effort = 'low';
    reason = 'A question about the project, with no changes to make.';
    signals.push('question');
  } else if (rule) {
    ({ kind, effort, reason } = rule);
    signals.push(`rule:${rule.kind}`);
  } else if (input.hasElement) {
    // A picked element pins the change to one place, so a vague request on it is still small.
    kind = 'style';
    effort = 'low';
    reason = 'The change is on one picked element.';
  } else {
    kind = 'general';
    effort = 'medium';
    reason = 'A general request gets balanced effort.';
  }
  if (input.hasElement) signals.push(input.elementSrc ? 'element:source' : 'element');

  if (input.emptyProject && kind !== 'question') {
    kind = 'new-app';
    effort = 'xhigh';
    reason = 'The project is empty, so this builds an app from the start.';
    signals.push('empty-project');
  }

  const checks = new Set<Check>(CHECKS[kind]);
  const risks = kind === 'question' ? [] : RISKS.filter((r) => r.test.test(plain)).map((r) => r.area);
  if (risks.length > 0) {
    signals.push(...risks.map((r) => `risk:${r}`));
    checks.add('build');
    if (LEVELS.indexOf(effort) < LEVELS.indexOf('high')) {
      effort = 'high';
      reason = `It touches ${risks.join(' and ')}, which need care.`;
    }
  }

  if (kind !== 'question' && asks(plain) >= 3) {
    effort = shiftEffort(effort, 1);
    reason = 'It asks for several things at once.';
    signals.push('several-asks');
  }

  if (input.previousFailed || input.previousUndone) {
    effort = shiftEffort(effort, 1);
    reason = input.previousUndone
      ? 'You undid the last change, so this one goes one level deeper.'
      : 'The last try did not work, so this one goes one level deeper.';
    signals.push(input.previousUndone ? 'after-undo' : 'after-failure');
  }

  if (input.mode === 'quick') effort = shiftEffort(effort, -1);
  if (input.mode === 'thorough') effort = shiftEffort(effort, 1);
  if (input.mode && input.mode !== 'balanced') signals.push(`mode:${input.mode}`);

  // `max` is never chosen automatically: only "Think harder" reaches it.
  if (input.thinkHarder) {
    effort = 'max';
    reason = 'You asked the hive to think harder.';
    signals.push('think-harder');
  }

  return { kind, effort, label: EFFORT_LABELS[effort], reason, checks: [...checks], signals };
}
