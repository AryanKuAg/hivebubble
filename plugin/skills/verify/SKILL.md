---
name: verify
description: What "done" means for a Hivebubble task and how Hivebubble checks the work afterwards. Use before replying that a change is finished.
---

# Verify

After you reply, Hivebubble checks your work on its own:

1. **Page check**: the dev server must compile every file you changed, and the open page must not show new errors from those files.
2. **Type check** (TypeScript projects): no new TypeScript errors.
3. **Build check** (bigger tasks): the production build still succeeds.

If a check fails, you get one more try, with the error.

## Before you say you're done

- Re-read each file you changed: JSX tags balanced, imports pointing at files and names that exist, exports matching their imports.
- A new component is imported and rendered where it should appear, not just created.
- After renaming or removing something, search the project for other uses of it.
- No placeholder text, TODOs or half-finished branches left in the code.
- Stay inside the request. If you couldn't do part of it, say which part and why.
