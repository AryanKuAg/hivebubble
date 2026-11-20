/**
 * A small line diff for showing what a skill update changes before it is
 * applied (README §8: "show the diff on every update"). Longest common
 * subsequence, printed as unified-style hunks with a little context.
 */
export function lineDiff(before: string, after: string, context = 2, maxLines = 4000): string {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length > maxLines || b.length > maxLines) return `(too long to compare line by line: ${a.length} → ${b.length} lines)`;
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..].
  const lcs: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: Array<{ op: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: ' ', text: a[i++] });
      j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      ops.push({ op: '+', text: b[j++] });
    } else {
      ops.push({ op: '-', text: a[i++] });
    }
  }
  if (!ops.some((o) => o.op !== ' ')) return '';
  // Keep changed lines plus `context` lines around them.
  const keep = ops.map(() => false);
  ops.forEach((o, n) => {
    if (o.op === ' ') return;
    for (let k = Math.max(0, n - context); k <= Math.min(ops.length - 1, n + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let gap = false;
  ops.forEach((o, n) => {
    if (!keep[n]) {
      gap = true;
      return;
    }
    if (gap && out.length > 0) out.push('…');
    gap = false;
    out.push(`${o.op}${o.text}`);
  });
  return out.join('\n');
}
