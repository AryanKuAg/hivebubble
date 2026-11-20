import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import Anthropic from '@anthropic-ai/sdk';
import { isInside, type Checkpoints } from './checkpoints.js';
import { SYSTEM_APPEND } from './prompt.js';
import type { Route, ServerEvent, ToolAction } from './types.js';
import { VERSION } from './version.js';

/** Default model. The router varies effort on one model first (README §6). */
export const MODEL = 'claude-opus-5-5';

/** v0.1 tools: read, search and edit files. No shell, no web. */
export const TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'];

export interface AgentContext {
  cwd: string;
  emit: (event: ServerEvent) => void;
  checkpoints: Checkpoints;
  abort: AbortController;
}

export interface AgentRequest {
  prompt: string;
  route: Route;
  apiKey: string;
  /** Session to continue, so follow-ups like "a bit bigger" keep their context. */
  resume?: string;
  maxBudgetUsd: number;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  costUsd?: number;
  sessionId?: string;
}

export function toolAction(tool: string): ToolAction {
  switch (tool) {
    case 'Read':
      return 'read';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Write':
      return 'write';
    default:
      return 'other';
  }
}

export function toolFile(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  if (typeof o.file_path === 'string') return o.file_path;
  if (typeof o.notebook_path === 'string') return o.notebook_path;
  if (typeof o.path === 'string') return o.path;
  return undefined;
}

/**
 * Why a tool call reaches outside the project folder, or null when it stays
 * inside. Reads count too: files outside the project must never be sent to
 * the model.
 */
export function outsideProject(cwd: string, input: unknown): string | null {
  const file = toolFile(input);
  if (file && !isInside(cwd, path.resolve(cwd, file))) return `"${file}" is outside the project folder.`;
  const pattern = input && typeof input === 'object' ? (input as Record<string, unknown>).pattern : undefined;
  if (typeof pattern === 'string' && (path.isAbsolute(pattern) || pattern.startsWith('~') || pattern.split(/[\\/]/).includes('..'))) {
    return `The pattern "${pattern}" reaches outside the project folder.`;
  }
  return null;
}

export type KeyCheck = 'ok' | 'rejected' | 'unknown';

/**
 * Check the API key once, before any task, with a free models.list call. A
 * rejected key would otherwise leave the agent retrying for minutes.
 */
export async function verifyApiKey(apiKey: string): Promise<KeyCheck> {
  const client = new Anthropic({ apiKey, authToken: null, maxRetries: 0, timeout: 10_000 });
  try {
    await client.models.list({ limit: 1 });
    return 'ok';
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return 'rejected';
    // Offline, a proxy, a 403 on the models endpoint…: don't block the person, let the task report it.
    return 'unknown';
  }
}

/**
 * Claude Code keeps its own config (sessions, settings, logins). Hivebubble
 * gives the agent a private config folder so the person's own Claude Code
 * settings, hooks and logins never leak into Hivebubble, and Hivebubble only
 * ever runs on the API key the person provided.
 */
export function agentConfigDir(): string {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Hivebubble')
      : path.join(os.homedir(), '.hivebubble');
  const dir = path.join(base, 'claude');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function friendlyError(text: string): string {
  if (/invalid api key|authentication|401|x-api-key/i.test(text)) {
    return 'Your Anthropic API key was rejected. Check it in Hivebubble settings.';
  }
  if (/credit balance|billing|402/i.test(text)) {
    return 'Your Anthropic account is out of credit. Add credit in the Claude Console, then try again.';
  }
  if (/rate limit|429|overloaded|529/i.test(text)) {
    return 'Claude is busy right now. Wait a moment and try again.';
  }
  return text || 'Something went wrong while Claude was working.';
}

export async function runClaude(ctx: AgentContext, req: AgentRequest): Promise<AgentResult> {
  const rel = (file: string) => path.relative(ctx.cwd, path.resolve(ctx.cwd, file));

  // Every tool call passes through here. This is the one place that keeps the
  // agent inside the project folder and saves undo points before edits.
  const before: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const action = toolAction(input.tool_name);
    const file = toolFile(input.tool_input);
    const outside = outsideProject(ctx.cwd, input.tool_input);
    if (outside) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Hivebubble only works inside the project folder. ${outside}`,
        },
      };
    }
    if (file && (action === 'edit' || action === 'write')) ctx.checkpoints.snapshot(path.resolve(ctx.cwd, file));
    ctx.emit({ type: 'tool', id: input.tool_use_id, phase: 'start', action, tool: input.tool_name, file: file && rel(file) });
    return {};
  };

  const after: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const file = toolFile(input.tool_input);
    ctx.emit({
      type: 'tool',
      id: input.tool_use_id,
      phase: 'end',
      action: toolAction(input.tool_name),
      tool: input.tool_name,
      file: file && rel(file),
    });
    return {};
  };

  let sessionId: string | undefined;
  try {
    const run = query({
      prompt: req.prompt,
      options: {
        cwd: ctx.cwd,
        model: MODEL,
        effort: req.route.effort,
        // Only these tools exist for the agent; they are pre-approved, and the
        // PreToolUse hook enforces the project boundary on every call.
        tools: TOOLS,
        allowedTools: TOOLS,
        permissionMode: 'dontAsk',
        hooks: {
          PreToolUse: [{ hooks: [before] }],
          PostToolUse: [{ hooks: [after] }],
        },
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
        maxTurns: 40,
        maxBudgetUsd: req.maxBudgetUsd,
        abortController: ctx.abort,
        resume: req.resume,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: req.apiKey,
          CLAUDE_CONFIG_DIR: agentConfigDir(),
          CLAUDE_AGENT_SDK_CLIENT_APP: `hivebubble/${VERSION}`,
        },
      },
    });

    for await (const msg of run) {
      if ('session_id' in msg && typeof msg.session_id === 'string') sessionId = msg.session_id;
      if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) ctx.emit({ type: 'say', role: 'assistant', text: block.text.trim() });
        }
      }
      if (msg.type === 'result') {
        if (msg.subtype === 'success') {
          return {
            ok: !msg.is_error,
            summary: msg.is_error ? friendlyError(msg.result) : msg.result,
            costUsd: msg.total_cost_usd,
            sessionId,
          };
        }
        const reason =
          msg.subtype === 'error_max_budget_usd'
            ? `Stopped at the $${req.maxBudgetUsd.toFixed(2)} limit for one task. Raise it in settings or split the request.`
            : msg.subtype === 'error_max_turns'
              ? 'Stopped after too many steps. Try a smaller request.'
              : friendlyError(msg.errors.join(' '));
        return { ok: false, summary: reason, costUsd: msg.total_cost_usd, sessionId };
      }
    }
    return { ok: false, summary: 'Claude stopped without an answer.', sessionId };
  } catch (err) {
    if (ctx.abort.signal.aborted) return { ok: false, summary: 'Stopped.', sessionId };
    return { ok: false, summary: friendlyError(err instanceof Error ? err.message : String(err)), sessionId };
  }
}
