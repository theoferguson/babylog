import { hourOffset } from './days.js';

// Column packing for the day timeline, the same idea a week calendar uses:
// anything that overlaps on screen shares the width instead of drawing on top.
//
// Overlap is measured in *rendered* pixels, not logical time. An instant event
// (diaper, bottle, pump) has no duration at all, so on logic alone two of them a
// few minutes apart would never overlap -- yet they visibly collide, because
// every block has a minimum height.

export function layout(events, { tz, hourPx = 44, minPx = 22, gapPx = 2 } = {}) {
  const blocks = events
    .map((e) => {
      const top = hourOffset(e.started_at, e.tz || tz) * hourPx;
      const span = e.ended_at
        ? ((new Date(e.ended_at) - new Date(e.started_at)) / 3600000) * hourPx
        : 0;
      const height = Math.max(minPx, span);
      return { event: e, top, height, bottom: top + height };
    })
    .sort((a, b) => a.top - b.top || a.height - b.height);

  // A cluster is a run of blocks connected by overlap. Width is divided within
  // a cluster, so an event that overlaps nothing still spans the full width.
  const clusters = [];
  let current = [];
  let clusterBottom = -Infinity;
  for (const b of blocks) {
    if (current.length && b.top >= clusterBottom) {
      clusters.push(current);
      current = [];
      clusterBottom = -Infinity;
    }
    current.push(b);
    clusterBottom = Math.max(clusterBottom, b.bottom);
  }
  if (current.length) clusters.push(current);

  const out = [];
  for (const cluster of clusters) {
    // Greedy: reuse the first column whose last block has already ended.
    const columns = [];
    for (const b of cluster) {
      let col = columns.findIndex((lastBottom) => b.top >= lastBottom);
      if (col === -1) {
        col = columns.length;
        columns.push(b.bottom);
      } else {
        columns[col] = b.bottom;
      }
      b.col = col;
    }
    const count = columns.length;
    for (const b of cluster) {
      out.push({
        event: b.event,
        top: b.top,
        height: b.height,
        // Fractions of the available width, so the caller stays unit-agnostic.
        leftPct: (b.col / count) * 100,
        widthPct: (1 / count) * 100,
        gapPx: b.col === count - 1 ? 0 : gapPx,
        columns: count,
      });
    }
  }
  return out;
}
