/**
 * R-itin-20 notice copy (T-7.5 / IT-4).
 *
 * Every form fixture in the screen suites produces exactly ONE conflict, so
 * the plural branch, `NAMED_LIMIT` and the "and N more" tail had no coverage
 * at all: setting the limit to 1 AND deleting the tail left the whole
 * form-conflict suite green. The PR body's "up to three items are named, then
 * 'and N more'" was an unverified claim about dead-to-tests code.
 */
import { conflictMessage } from "./ConflictNotice";
import type { ConflictHit } from "../conflicts";

const hit = (title: string, timeLabel = "10:00 – 12:30"): ConflictHit => ({
  itemId: `id-${title}`,
  title,
  timeLabel,
});

describe("conflictMessage (R-itin-20)", () => {
  it("one conflict names it with the list card's own time caption", () => {
    expect(conflictMessage([hit("Museum")])).toBe(
      "Overlaps Museum (10:00 – 12:30) — that's allowed, just so you know.",
    );
  });

  it("two and three conflicts are all named, comma-joined, with no tail", () => {
    expect(conflictMessage([hit("Museum"), hit("Lunch")])).toBe(
      "Overlaps Museum (10:00 – 12:30), Lunch (10:00 – 12:30) — that's allowed, just so you know.",
    );
    const three = conflictMessage([hit("A"), hit("B"), hit("C")]);
    expect(three).toContain("A (10:00 – 12:30), B (10:00 – 12:30), C (10:00 – 12:30)");
    expect(three).not.toContain("more");
  });

  it("beyond three, the extras are COUNTED rather than silently dropped", () => {
    const four = conflictMessage([hit("A"), hit("B"), hit("C"), hit("D")]);
    expect(four).toContain("and 1 more");
    expect(four).not.toContain("D (");

    const six = conflictMessage([1, 2, 3, 4, 5, 6].map((n) => hit(`Item ${n}`)));
    expect(six).toContain("and 3 more");
  });

  it("a hit with no time caption degrades to the bare title", () => {
    expect(conflictMessage([hit("All-day thing", "")])).toBe(
      "Overlaps All-day thing — that's allowed, just so you know.",
    );
  });

  it("the copy always states that the overlap is ALLOWED (R-ib-17, non-blocking)", () => {
    for (const count of [1, 2, 5]) {
      const message = conflictMessage(
        Array.from({ length: count }, (_, i) => hit(`Item ${i}`)),
      );
      expect(message).toContain("that's allowed");
    }
  });
});
