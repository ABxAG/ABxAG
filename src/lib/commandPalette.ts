/**
 * Command palette pure logic — framework-free so it stays unit-testable
 * under plain node:test (no DOM, no React).
 */

export interface CommandDef {
  id: string;
  title: string;
  hint?: string;
  /** Extra searchable words, e.g. ["settings", "config"]. */
  keywords?: string[];
  run(): void;
}

/**
 * Subsequence fuzzy score. Higher = better. Returns -1 on no match.
 * Prefix hits and consecutive runs score best; empty query scores 0
 * (caller keeps original order).
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  if (t.includes(q)) {
    // Exact-substring bonus: earlier + longer-relative matches win.
    return 1000 - t.indexOf(q) * 4 + Math.round((q.length / t.length) * 100);
  }
  let qi = 0;
  let score = 0;
  let run = 0;
  let prevIdx = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] === q[qi]) {
      const consecutive = ti === prevIdx + 1;
      run = consecutive ? run + 1 : 1;
      score += 10 + run * 6;
      // Word-boundary bonus (start, or after space / - / _).
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "-" || t[ti - 1] === "_") {
        score += 12;
      }
      prevIdx = ti;
      qi += 1;
    } else {
      run = 0;
    }
  }
  if (qi < q.length) return -1;
  // Compact matches (short span) beat scattered ones.
  score -= (prevIdx - q.length) * 0.5;
  return Math.round(score);
}

/** Filter + rank commands for a query. Empty query returns all in order. */
export function filterCommands(query: string, commands: CommandDef[]): CommandDef[] {
  if (query.trim().length === 0) return [...commands];
  const scored: Array<{ cmd: CommandDef; score: number; index: number }> = [];
  commands.forEach((cmd, index) => {
    const hay = [cmd.title, cmd.hint ?? "", ...(cmd.keywords ?? [])].join(" ");
    const score = fuzzyScore(query, hay);
    if (score >= 0) scored.push({ cmd, score, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.cmd);
}

/**
 * Move a list selection. Wraps around; length 0 yields -1 (nothing selected).
 */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  const next = (index + delta) % length;
  return next < 0 ? next + length : next;
}
