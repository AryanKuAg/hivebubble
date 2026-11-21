// Claude Code hook: tells a running Hivebubble about each step, so the bees on
// the page follow it, files are saved before each edit (Undo), and the bubble's
// Stop button works. Without a Hivebubble for this folder it does nothing, and
// it never fails a step because of Hivebubble.
import { call, findEngine } from './engine.mjs';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
} catch {
  process.exit(0);
}

const engine = findEngine(input.cwd || undefined);
if (!engine) process.exit(0);

try {
  const answer = await call(
    engine,
    'event',
    {
      hook_event_name: input.hook_event_name,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_response: input.tool_response,
      tool_use_id: input.tool_use_id,
      cwd: input.cwd,
      message: input.message,
      notification_type: input.notification_type,
    },
    { timeoutMs: 3000 },
  );
  if (input.hook_event_name === 'PreToolUse' && (answer.deny || answer.allow)) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: answer.deny ? 'deny' : 'allow',
          permissionDecisionReason: answer.deny || answer.allow,
        },
      }),
    );
  }
} catch {
  // Hivebubble stopped or restarted: carry on without it.
}
process.exit(0);
