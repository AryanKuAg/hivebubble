/** Shared types between the Hivebubble engine and the in-page bubble. */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The three-way switch shown to people: it shifts the router's choice down or up a level. */
export type Mode = 'quick' | 'balanced' | 'thorough';

export type TaskKind = 'copy' | 'style' | 'component' | 'feature' | 'bug' | 'new-app' | 'general';

export interface Route {
  kind: TaskKind;
  effort: Effort;
  /** Plain-language label shown in the bubble, e.g. "Quick". */
  label: string;
  /** One short sentence on why the router chose this effort. */
  reason: string;
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
  | { type: 'chat'; text: string; element?: PickedElement; mode?: Mode }
  | { type: 'undo' }
  | { type: 'stop' };

export type ToolAction = 'read' | 'search' | 'edit' | 'write' | 'other';

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

export type ServerEvent =
  | { type: 'hello'; project: ProjectSummary; agent: AgentKind; busy: boolean; canUndo: boolean; history: ChatEntry[] }
  | { type: 'route'; route: Route }
  | { type: 'status'; state: 'idle' | 'working' }
  | { type: 'say'; role: 'assistant' | 'system'; text: string }
  | { type: 'user'; text: string; route: Route }
  | { type: 'tool'; id: string; phase: 'start' | 'end'; action: ToolAction; tool: string; file?: string }
  | { type: 'done'; ok: boolean; summary: string; costUsd?: number; durationMs: number; canUndo: boolean }
  | { type: 'undone'; files: string[]; canUndo: boolean }
  | { type: 'error'; message: string };
