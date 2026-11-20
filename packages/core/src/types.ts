/** Shared types between the Hivebubble engine and the in-page bubble. */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The three-way switch shown to people: it shifts the router's choice down or up a level. */
export type Mode = 'quick' | 'balanced' | 'thorough';

export type TaskKind = 'question' | 'copy' | 'style' | 'component' | 'feature' | 'bug' | 'new-app' | 'general';

/**
 * What "done" means after a task (README §5, step 6):
 * - page: the dev server compiles every changed file, and the open page shows no new errors;
 * - typecheck: TypeScript reports no new errors;
 * - build: the production build still succeeds.
 */
export type Check = 'page' | 'typecheck' | 'build';

export interface Route {
  kind: TaskKind;
  effort: Effort;
  /** Plain-language label shown in the bubble, e.g. "Quick". */
  label: string;
  /** One short sentence on why the router chose this effort. */
  reason: string;
  /** The checks to run once the agent is done. */
  checks: Check[];
  /** What the router saw (rule, risks, retries…), kept in the router log to tune the rules. */
  signals: string[];
}

export interface CheckResult {
  check: Check;
  ok: boolean;
  /** Not run, and why (e.g. the build was already failing before the task). */
  skipped?: string;
  /** For a failure: the error, short enough to show and to give back to Claude. */
  detail?: string;
  durationMs: number;
}

/** What Claude has cost, from Hivebubble's ledger (all projects on this computer). */
export interface SpendSummary {
  todayUsd: number;
  todayTasks: number;
  monthUsd: number;
  monthTasks: number;
  dailyCapUsd: number;
  remainingUsd: number;
}

export type HostId = 'vercel' | 'netlify' | 'cloudflare';

/** One card in the deploy wizard (README §9). */
export interface HostCard {
  id: HostId;
  name: string;
  bestFor: string;
  freePlan: string;
  steps: number;
  time: string;
  /** Environment variables (from the Keychain via the Mac app) the host needs. */
  needs: string[];
  tokenUrl: string;
  connectSteps: string[];
  domainSteps: string[];
  connected: boolean;
  recommended: boolean;
  /** The address of the last deploy to this host. */
  lastUrl?: string;
}

/** An environment variable the app reads, and whether a .env file sets it (values are never read). */
export interface EnvNeed {
  name: string;
  set: boolean;
  usedIn: string[];
}

/** A registry skill offered before a task (README §8). */
export interface SkillOffer {
  id: string;
  title: string;
  description: string;
  author: string;
  license: string;
  /** Someone read every file at the pinned commit. */
  verified: boolean;
  url: string;
}

export interface CostEstimate {
  lowUsd: number;
  highUsd: number;
  /** 'history': this project's past tasks at this effort; 'typical': a rough guess. */
  basis: 'history' | 'typical';
}

/** An element the person picked on the page with the element picker. */
export interface PickedElement {
  selector: string;
  tag: string;
  text: string;
  html: string;
  /** `file:line` from a `data-hivebubble-src` attribute, when the project has source tags. */
  src?: string;
}

export type ClientMessage =
  | { type: 'chat'; text: string; element?: PickedElement; mode?: Mode; thinkHarder?: boolean }
  /** The answer to a cost confirmation for a big task. */
  | { type: 'confirm'; id: string; ok: boolean }
  /** `force`: undo even though the files changed after the task. */
  | { type: 'undo'; force?: boolean }
  | { type: 'stop' }
  /** An error on the open page while a task runs (the "reload check"). */
  | { type: 'page-error'; message: string; source?: string }
  /** Open the deploy wizard: which hosts are connected, what the app needs. */
  | { type: 'deploy-info' }
  | { type: 'deploy'; host: HostId };

export type ToolAction = 'read' | 'search' | 'edit' | 'write' | 'other';

/** A place a search found its pattern. */
export interface SearchHit {
  file: string;
  line?: number;
}

/**
 * Where on the page an agent step lands, worked out from the real tool call.
 * The bubble matches it against the `data-hivebubble-src` tags on the page.
 */
export interface ToolWhere {
  /**
   * The lines of `file` the step reads or changes (1-based, inclusive). For an
   * edit, the lines before the change on 'start' and after it on 'end'.
   */
  lines?: [number, number];
  /** For stylesheets: selectors of the rules involved, ready for querySelectorAll. */
  selectors?: string[];
  /** For searches, on 'end': where the matches are. */
  hits?: SearchHit[];
}

export type AgentKind = 'claude' | 'mock' | 'missing-key' | 'invalid-key';

export interface ChatEntry {
  role: 'user' | 'assistant' | 'system';
  text: string;
  route?: Route;
}

export interface ProjectSummary {
  name: string;
  framework: string;
}

export interface ToolEvent extends ToolWhere {
  type: 'tool';
  id: string;
  phase: 'start' | 'end';
  action: ToolAction;
  tool: string;
  /** Project-relative path with forward slashes. */
  file?: string;
  /** On 'end': false when the tool call failed. */
  ok?: boolean;
}

export type ServerEvent =
  | {
      type: 'hello';
      project: ProjectSummary;
      agent: AgentKind;
      busy: boolean;
      canUndo: boolean;
      history: ChatEntry[];
      /** True when the dev server stamps data-hivebubble-src on page elements. */
      sourceTags: boolean;
      spend: SpendSummary;
      /** A request to put in the message box (what someone asked for when creating the app). */
      draft?: string;
    }
  | { type: 'route'; route: Route }
  | { type: 'status'; state: 'idle' | 'working' }
  | { type: 'say'; role: 'assistant' | 'system'; text: string }
  | { type: 'user'; text: string; route: Route }
  | ToolEvent
  | {
      type: 'done';
      ok: boolean;
      summary: string;
      costUsd?: number;
      durationMs: number;
      canUndo: boolean;
      checks?: CheckResult[];
      /** 2 when the router retried after a failed check. */
      attempts?: number;
    }
  | { type: 'undone'; files: string[]; canUndo: boolean }
  /** The files changed after the task: undoing would throw those later changes away. */
  | { type: 'undo-conflict'; files: string[] }
  | { type: 'error'; message: string }
  /** The live cost meter: what this task has cost so far (an estimate until 'done'). */
  | { type: 'cost'; usd: number }
  | { type: 'check'; phase: 'start' | 'end'; check: Check; label: string; result?: CheckResult }
  /** A check failed: one more try, one effort level up. */
  | { type: 'retry'; route: Route; reason: string }
  /** A big task: show the estimate and wait for a 'confirm' answer. */
  | { type: 'confirm'; id: string; kind: 'cost'; route: Route; estimate: CostEstimate; spend: SpendSummary }
  /** A registry skill fits the request: offer to add it to the project first. */
  | { type: 'confirm'; id: string; kind: 'skill'; skill: SkillOffer }
  /** The daily spending cap is reached: no new tasks today. */
  | { type: 'paused'; spend: SpendSummary }
  | { type: 'deploy-info'; hosts: HostCard[]; env: EnvNeed[]; supported: boolean; why?: string }
  | {
      type: 'deploy';
      host: HostId;
      phase: 'build' | 'upload' | 'finalize' | 'live' | 'failed';
      message: string;
      done?: number;
      total?: number;
      file?: string;
      url?: string;
      adminUrl?: string;
      /** The live URL as a QR code, for a phone. */
      qrSvg?: string;
      /** For a failed build: the end of its output. */
      buildLog?: string;
      durationMs?: number;
    }
  | { type: 'spend'; spend: SpendSummary };
