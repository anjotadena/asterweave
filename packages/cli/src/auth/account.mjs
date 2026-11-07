// Asterweave account plane. Phase A has no hosted backend: this plane is always unavailable,
// is informational only, and never blocks anything.

/** @returns {{plane: 'asterweave', status: 'unavailable', code: 'ACCOUNT_UNAVAILABLE', reason: string, remediation: null}} */
export function probeAccount() {
  return { plane: "asterweave", status: "unavailable", code: "ACCOUNT_UNAVAILABLE", reason: "no hosted backend configured", remediation: null };
}
