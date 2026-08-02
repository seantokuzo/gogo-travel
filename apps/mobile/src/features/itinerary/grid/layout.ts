/**
 * Timed-block overlap layout (T-7.7 / IT-6 — R-itin-15): overlapping blocks
 * render side-by-side, never occluded. Classic calendar column assignment:
 *
 * 1. Blocks sort by (start asc, end desc) — longer blocks claim columns
 *    first so short ones nest beside them deterministically.
 * 2. A CLUSTER is a maximal run of transitively-overlapping blocks; column
 *    widths split per cluster (a lone evening block stays full-width even
 *    when the morning had a three-way split).
 * 3. Within a cluster, each block takes the first column whose previous
 *    occupant has ended; the cluster's column count sizes every member.
 *
 * `overlapping` is the R-itin-15 Badge flag — true only for blocks that
 * DIRECTLY share a time range with another (a cluster can chain blocks that
 * never touch each other; those get split widths but no badge).
 *
 * Zero-length spans are widened to one minute internally so two identical
 * point events still split side-by-side instead of stacking.
 */

export interface TimedSpan {
  /** Minutes from midnight, trip-local wall time. */
  startMinutes: number;
  endMinutes: number;
}

export interface ColumnAssignment {
  /** 0-based column within the overlap cluster. */
  column: number;
  /** Total columns in the cluster (width = 1/columns of the day column). */
  columns: number;
  /** R-itin-15: this block directly shares a time range with another. */
  overlapping: boolean;
}

/** Effective end for clustering/overlap math — floors zero-length spans. */
function effectiveEnd(span: TimedSpan): number {
  return Math.max(span.endMinutes, span.startMinutes + 1);
}

/**
 * Assigns side-by-side columns to a single day's timed blocks. Returns a new
 * array in the INPUT order with `{column, columns, overlapping}` attached.
 */
export function assignOverlapColumns<T extends TimedSpan>(
  blocks: readonly T[],
): (T & ColumnAssignment)[] {
  const order = blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => {
      if (a.block.startMinutes !== b.block.startMinutes) {
        return a.block.startMinutes - b.block.startMinutes;
      }
      const byEnd = effectiveEnd(b.block) - effectiveEnd(a.block);
      // Stable input-index tiebreak keeps assignment deterministic.
      return byEnd !== 0 ? byEnd : a.index - b.index;
    });

  const assignments = new Array<ColumnAssignment>(blocks.length);

  let cluster: { index: number; end: number }[] = [];
  let columnEnds: number[] = [];
  let clusterMaxEnd = -1;

  const closeCluster = () => {
    for (const member of cluster) {
      const assignment = assignments[member.index];
      if (assignment !== undefined) assignment.columns = columnEnds.length;
    }
    cluster = [];
    columnEnds = [];
    clusterMaxEnd = -1;
  };

  for (const { block, index } of order) {
    const start = block.startMinutes;
    const end = effectiveEnd(block);
    if (cluster.length > 0 && start >= clusterMaxEnd) closeCluster();

    let column = columnEnds.findIndex((colEnd) => colEnd <= start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }

    assignments[index] = { column, columns: 1, overlapping: false };
    cluster.push({ index, end });
    clusterMaxEnd = Math.max(clusterMaxEnd, end);
  }
  closeCluster();

  // Direct-overlap badge flags (strict interval intersection on effective ends).
  for (let i = 0; i < blocks.length; i += 1) {
    const a = blocks[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < blocks.length; j += 1) {
      const b = blocks[j];
      if (b === undefined) continue;
      if (a.startMinutes < effectiveEnd(b) && b.startMinutes < effectiveEnd(a)) {
        const ai = assignments[i];
        const bj = assignments[j];
        if (ai !== undefined) ai.overlapping = true;
        if (bj !== undefined) bj.overlapping = true;
      }
    }
  }

  return blocks.map((block, index) => ({
    ...block,
    ...(assignments[index] ?? { column: 0, columns: 1, overlapping: false }),
  }));
}
