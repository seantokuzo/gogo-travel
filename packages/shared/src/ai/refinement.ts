/**
 * Server-side refinement errors (contracts spec §3.7 rule 2): AI output
 * schemas carry no numeric range or cross-field rules; each module's paired
 * `refine<X>()` enforces them AFTER `client.messages.parse()` returns.
 * A thrown `AiRefinementError` is treated like a parse failure by the
 * server pipeline (retry once → `AI_UPSTREAM`).
 */
export class AiRefinementError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`AI output failed refinement: ${issues.join("; ")}`);
    this.name = "AiRefinementError";
    this.issues = issues;
  }
}
