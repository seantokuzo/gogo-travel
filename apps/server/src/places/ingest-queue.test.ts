/**
 * Ingest queue + triggers (places spec §3.1.3, R-places-1/7 enqueue half):
 * serial drain, queued-key collapse, the never-throws contract, and the
 * one-enqueue-per-cell-per-hour search-miss throttle.
 */
import { describe, expect, it, vi } from "vitest";
import { regionCellAt, regionCellsForDestination } from "@gogo/shared/region-grid";
import { createPlacesIngestQueue } from "./ingest-queue.js";

const LISBON = { lat: 38.722252, lng: -9.139337 };
const HOUR_MS = 3_600_000;

function recordingDeps(overrides: { fail?: Set<string> } = {}) {
  const ran: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const warn = vi.fn<(message: string) => void>();
  const ingestCell = vi.fn(async (cell: { key: string }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve(); // yield, so overlap would be observable
    inFlight -= 1;
    if (overrides.fail?.has(cell.key)) throw new Error(`boom ${cell.key}`);
    ran.push(cell.key);
  });
  return { ingestCell, warn, ran, maxInFlight: () => maxInFlight };
}

describe("createPlacesIngestQueue", () => {
  it("destination trigger runs the 9 destination cells, center first, serially", async () => {
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });

    queue.enqueueDestination(LISBON.lat, LISBON.lng);
    await queue.idle();

    const expected = regionCellsForDestination(LISBON.lat, LISBON.lng).map((c) => c.key);
    expect(deps.ran).toEqual(expected);
    expect(deps.ran[0]).toBe("r:77:-19");
    expect(deps.maxInFlight()).toBe(1); // serial drain — no stampede
  });

  it("collapses duplicate cells while queued (two trips, one metro)", async () => {
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });

    // Same destination twice, synchronously — before the drain can finish.
    queue.enqueueDestination(LISBON.lat, LISBON.lng);
    queue.enqueueDestination(LISBON.lat, LISBON.lng);
    await queue.idle();

    // First cell may re-run (it was already dequeued when the second enqueue
    // landed — freshness gate no-ops it downstream); queued keys collapse.
    expect(deps.ran.length).toBeLessThanOrEqual(10);
    expect(new Set(deps.ran).size).toBe(9);
  });

  it("a failing job is logged and the drain continues (never dies)", async () => {
    const cells = regionCellsForDestination(LISBON.lat, LISBON.lng);
    const failing = cells[1]!.key;
    const deps = recordingDeps({ fail: new Set([failing]) });
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });

    queue.enqueueDestination(LISBON.lat, LISBON.lng);
    await queue.idle();

    expect(deps.ran).toHaveLength(8); // all but the failing cell completed
    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn.mock.calls[0]?.[0]).toContain(failing);
  });

  it("NEVER throws from enqueueDestination — invalid coords log-and-drop (R-places-1)", async () => {
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });

    expect(() => queue.enqueueDestination(Number.NaN, 999)).not.toThrow();
    await queue.idle();
    expect(deps.ingestCell).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it("throttles search-miss enqueues to one per cell per hour (R-places-7, §3.1.3)", async () => {
    let nowMs = 1_000_000;
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({
      ingestCell: deps.ingestCell,
      logger: { warn: deps.warn },
      now: () => new Date(nowMs),
      searchMissThrottleMs: HOUR_MS,
    });
    const cell = regionCellAt(LISBON.lat, LISBON.lng);

    queue.enqueueSearchMiss([cell]);
    await queue.idle();
    expect(deps.ran).toEqual([cell.key]);

    // Within the hour: swallowed.
    nowMs += HOUR_MS - 1;
    queue.enqueueSearchMiss([cell]);
    await queue.idle();
    expect(deps.ran).toEqual([cell.key]);

    // At the hour boundary: allowed again.
    nowMs += 1;
    queue.enqueueSearchMiss([cell]);
    await queue.idle();
    expect(deps.ran).toEqual([cell.key, cell.key]);
  });

  it("destination cells outrank queued search-miss cells (two-tier drain)", async () => {
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });
    const backfillA = regionCellAt(41.9028, 12.4964); // Rome
    const backfillB = regionCellAt(-33.8688, 151.2093); // Sydney

    // A starts draining immediately; B is still queued when the destination
    // trigger lands — the 9 destination cells must jump ahead of B.
    queue.enqueueSearchMiss([backfillA, backfillB]);
    queue.enqueueDestination(LISBON.lat, LISBON.lng);
    await queue.idle();

    const destinationKeys = regionCellsForDestination(LISBON.lat, LISBON.lng).map((c) => c.key);
    expect(deps.ran).toEqual([backfillA.key, ...destinationKeys, backfillB.key]);
  });

  it("a destination enqueue PROMOTES a cell already queued as search-miss (no double run)", async () => {
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });
    const blocker = regionCellAt(41.9028, 12.4964); // keeps the drain busy
    const lisbonCenter = regionCellAt(LISBON.lat, LISBON.lng);

    queue.enqueueSearchMiss([blocker, lisbonCenter]);
    queue.enqueueDestination(LISBON.lat, LISBON.lng); // includes lisbonCenter
    await queue.idle();

    // The center cell ran exactly once, from the destination tier.
    expect(deps.ran.filter((key) => key === lisbonCenter.key)).toHaveLength(1);
    expect(deps.ran).toHaveLength(1 + 9); // blocker + the 9 destination cells
  });

  it("throttle is per cell — a second cell is not blocked by the first", async () => {
    const deps = recordingDeps();
    const queue = createPlacesIngestQueue({ ingestCell: deps.ingestCell, logger: { warn: deps.warn } });
    const a = regionCellAt(38.6, -9.4);
    const b = regionCellAt(48.85, 2.35);

    queue.enqueueSearchMiss([a]);
    queue.enqueueSearchMiss([b]);
    await queue.idle();
    expect(new Set(deps.ran)).toEqual(new Set([a.key, b.key]));
  });
});
