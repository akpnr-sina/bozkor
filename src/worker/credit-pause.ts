/**
 * Without credit, how often the LLM jobs try one item. Every try reads its
 * inputs from the database first (a tender's document texts can be hundreds
 * of KB), so trying every run cost about 100 MB of egress a day.
 */
export const CREDIT_RETRY_MS = 30 * 60_000;

export type CreditOutcome = { stoppedBy: string | null; attempted: number };

export type CreditPause = {
  /**
   * A run's limits: as asked while the account has credit; none (skip the run)
   * for CREDIT_RETRY_MS after it ran out; then one item, to see whether it is back.
   */
  limits(limit: number, concurrency: number): { limit: number; concurrency: number } | null;
  /** After a run: "ran-out" the first time the account is found without credit, "back" when a call goes through again. */
  record(outcome: CreditOutcome): "ran-out" | "back" | null;
};

/** Shared by the LLM jobs, which spend from one account. */
export function createCreditPause(now: () => number = Date.now, retryMs = CREDIT_RETRY_MS): CreditPause {
  let outSince: number | null = null;
  return {
    limits(limit, concurrency) {
      if (outSince === null) return { limit, concurrency };
      if (now() - outSince < retryMs) return null;
      return { limit: 1, concurrency: 1 };
    },
    record({ stoppedBy, attempted }) {
      if (stoppedBy === "credit") {
        const first = outSince === null;
        outSince = now();
        return first ? "ran-out" : null;
      }
      // A call that went through, or failed for another reason, means the account has credit.
      if (outSince !== null && attempted > 0) {
        outSince = null;
        return "back";
      }
      return null;
    },
  };
}
