/**
 * Coarse luminance-grid comparison. Decides whether the screen meaningfully
 * changed without any model call, and where.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Fingerprint {
  region: Rect;
  columns: number;
  rows: number;
  cells: number[];
  capturedAt: number;
}

export interface FingerprintDiff {
  changed: boolean;
  /** Fraction of grid cells whose luminance moved beyond the threshold. */
  score: number;
  changedRegions: Rect[];
}

export function diffFingerprints(previous: Fingerprint | null, current: Fingerprint, cellThreshold = 10, changedFraction = 0.015): FingerprintDiff {
  if (!previous || previous.columns !== current.columns || previous.rows !== current.rows || !sameRect(previous.region, current.region)) {
    return { changed: true, score: 1, changedRegions: [current.region] };
  }
  const changedCells: Array<[number, number]> = [];
  for (let i = 0; i < current.cells.length; i += 1) {
    if (Math.abs(current.cells[i] - previous.cells[i]) > cellThreshold) {
      changedCells.push([i % current.columns, Math.floor(i / current.columns)]);
    }
  }
  const score = changedCells.length / current.cells.length;
  return {
    changed: score >= changedFraction,
    score: Math.round(score * 1000) / 1000,
    changedRegions: mergeCells(changedCells, current),
  };
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/** Merge changed grid cells into a few bounding rectangles (screen pixels). */
function mergeCells(cells: Array<[number, number]>, fp: Fingerprint): Rect[] {
  if (!cells.length) return [];
  const cellWidth = (fp.region.right - fp.region.left) / fp.columns;
  const cellHeight = (fp.region.bottom - fp.region.top) / fp.rows;
  const remaining = new Set(cells.map(([x, y]) => `${x},${y}`));
  const rects: Rect[] = [];
  for (const [x, y] of cells) {
    const key = `${x},${y}`;
    if (!remaining.has(key)) continue;
    // Flood-fill connected changed cells.
    let minX = x, maxX = x, minY = y, maxY = y;
    const stack: Array<[number, number]> = [[x, y]];
    remaining.delete(key);
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx);
      minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const next = `${cx + dx},${cy + dy}`;
        if (remaining.has(next)) {
          remaining.delete(next);
          stack.push([cx + dx, cy + dy]);
        }
      }
    }
    rects.push({
      left: Math.round(fp.region.left + minX * cellWidth),
      top: Math.round(fp.region.top + minY * cellHeight),
      right: Math.round(fp.region.left + (maxX + 1) * cellWidth),
      bottom: Math.round(fp.region.top + (maxY + 1) * cellHeight),
    });
  }
  return rects.sort((a, b) => area(b) - area(a)).slice(0, 6);
}

function area(rect: Rect): number {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

/** Stable short hash of a fingerprint, used as a cache key for visual understanding. */
export function fingerprintKey(fp: Fingerprint, quantum = 12): string {
  let hash = 2166136261;
  for (const cell of fp.cells) {
    hash ^= Math.round(cell / quantum);
    hash = Math.imul(hash, 16777619);
  }
  return `${fp.region.left},${fp.region.top},${fp.region.right},${fp.region.bottom}:${(hash >>> 0).toString(16)}`;
}
