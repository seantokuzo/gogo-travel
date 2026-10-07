// Maestro `runScript` for subflows/create-minimal-trip.yaml (B-30).
//
// Computes the calendar cell to tap for END = D+1, where D is the host's
// local "today" (the simulator shares the host's clock and zone, and the
// start picker commits its unmodified `new Date()` seed = D). Exposes, on
// Maestro's `output` object:
//   output.endDayOfMonth  — "1".."31", the day number of D+1 (a string, ready
//                           to splice into the day-cell regex `^<n>$`)
//   output.endRollsMonth  — "true" when D+1 lands in the NEXT month (D is the
//                           last day of its month), so the inline calendar —
//                           which opens on D's month — needs one
//                           `DatePicker.NextMonth` tap before the day cell.
//
// ES5 ONLY (var, function, no arrow functions / let / const / template
// literals): Maestro's default JS engine is Rhino. `new Date(y, m, d + 1)`
// lets the Date constructor do the month/year/leap-day rollover, so the
// script has no calendar arithmetic of its own to get wrong.
var today = new Date();
var next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

output.endDayOfMonth = String(next.getDate());
output.endRollsMonth = next.getMonth() !== today.getMonth() ? "true" : "false";
