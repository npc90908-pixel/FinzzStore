// Minimum customer top-up is a business rule, not an admin-tunable fallback.
// Keep this floor applied on reads and writes so an old stored setting cannot
// silently re-enable smaller deposits.
export const MINIMUM_TOPUP_AMOUNT = 1_000;

export function normalizeDepositPolicy(policy = {}) {
  const candidate = Number(policy.min_amount);
  const minAmount = Number.isSafeInteger(candidate)
    ? Math.max(MINIMUM_TOPUP_AMOUNT, candidate)
    : MINIMUM_TOPUP_AMOUNT;
  return { ...policy, min_amount: minAmount };
}
