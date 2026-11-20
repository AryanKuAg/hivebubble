import { existsSync, readFileSync } from 'node:fs';

/**
 * Read simple KEY=VALUE files (like .env.local) into process.env without
 * overriding variables that are already set. Only Hivebubble's own keys are
 * read, so a project's unrelated secrets never end up in Hivebubble.
 */
export function loadEnvFiles(
  files: string[],
  allowed = /^(ANTHROPIC_API_KEY|HIVEBUBBLE_[A-Z_]+|VERCEL_TOKEN|VERCEL_TEAM_ID|NETLIFY_AUTH_TOKEN|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)$/,
): void {
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (allowed.test(key) && value && process.env[key] === undefined) process.env[key] = value;
    }
  }
}
