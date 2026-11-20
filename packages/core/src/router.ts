import type { Effort, Mode, Route, TaskKind } from './types.js';

/**
 * Smart Router v0: instant, rule-based effort picking.
 *
 * It reads only the message, whether an element was picked, the person's
 * Quick/Balanced/Thorough switch and whether the last attempt failed. No LLM
 * call, so it decides in well under a millisecond. The table lives in the plan
 * (README §6) and is meant to be tuned with real task logs.
 */

export interface RouteInput {
  text: string;
  hasElement: boolean;
  mode?: Mode;
  previousFailed?: boolean;
}

const LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh'];

const LABELS: Record<Effort, string> = {
  low: 'Quick',
  medium: 'Balanced',
  high: 'Careful',
  xhigh: 'Deep',
  max: 'Deepest',
};

interface Rule {
  kind: TaskKind;
  effort: Effort;
  test: RegExp;
  reason: string;
}

// Order matters: the first matching rule wins.
const RULES: Rule[] = [
  {
    kind: 'bug',
    effort: 'high',
    test: /\b(error|exception|stack ?trace|crash(es|ed)?|broken|not working|doesn'?t work|blank (page|screen)|undefined is not|cannot read|failed to)\b/,
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
    test: /\b(change|replace|update|rename|fix|edit|reword|rewrite)\b.{0,40}\b(text|title|headline|heading|label|wording|copy|typo|words?|sentence|paragraph|caption)\b|\b(change|replace|update|rename)\b.{0,60}\bto\s+["“']|\b(make|have|let)\b.{0,40}\bsays?\b/,
    reason: 'A text change is a one-line edit.',
  },
  {
    kind: 'feature',
    effort: 'high',
    test: /\b(database|db|supabase|firebase|postgres|backend|server|api|auth|log ?in|sign ?in|sign ?up|password|payments?|stripe|checkout|email|upload|save[sd]?\b.{0,30}\b(to|in|into))\b/,
    reason: 'Data, logins and payments touch several files and need care.',
  },
  {
    kind: 'component',
    effort: 'medium',
    test: /\b(add|create|insert|new|put)\b.{0,40}\b(section|component|button|form|card|cards|page|footer|header|navbar|nav|menu|modal|popup|list|table|gallery|testimonials?|pricing|faq|banner|hero|slider|carousel|tabs?)\b/,
    reason: 'A new section is a contained change in a few files.',
  },
  {
    kind: 'style',
    effort: 'low',
    test: /\b(colou?r|bigger|smaller|larger|size|font|bold|italic|padding|margin|spacing|space|rounded|round(er)?|corners?|border|shadow|align|center|centre|left|right|background|dark mode|width|height|gap|opacity|style|look|darker|lighter|move)\b/,
    reason: 'A style tweak is a small, local change.',
  },
];

function shift(effort: Effort, by: number): Effort {
  if (effort === 'max') return 'max';
  const i = LEVELS.indexOf(effort);
  return LEVELS[Math.min(LEVELS.length - 1, Math.max(0, i + by))];
}

export function routeTask(input: RouteInput): Route {
  const text = input.text.toLowerCase();
  const rule = RULES.find((r) => r.test.test(text));

  let kind: TaskKind = rule?.kind ?? 'general';
  let effort: Effort = rule?.effort ?? 'medium';
  let reason = rule?.reason ?? 'A general request gets balanced effort.';

  // A picked element pins the change to one place, so a vague request on it is still small.
  if (!rule && input.hasElement) {
    kind = 'style';
    effort = 'low';
    reason = 'The change is on one picked element.';
  }

  if (input.previousFailed) {
    effort = shift(effort, 1);
    reason = 'The last try did not work, so this one goes one level deeper.';
  }

  if (input.mode === 'quick') effort = shift(effort, -1);
  if (input.mode === 'thorough') effort = shift(effort, 1);

  // `max` is never chosen automatically (README §6): it is only for a manual "Think harder".
  return { kind, effort, label: LABELS[effort], reason };
}
