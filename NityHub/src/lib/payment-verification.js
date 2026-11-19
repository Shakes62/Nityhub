/** Only the owner of the exact successful Paystack transaction may receive credit. */
export function verifiedWalletDepositMatchesOwner(paymentData, reference, userId) {
  const amount = paymentData?.amount
  return (
    String(paymentData?.metadata?.userId || "").trim() === String(userId || "").trim() &&
    Boolean(String(userId || "").trim()) &&
    String(paymentData?.reference || "").trim() === String(reference || "").trim() &&
    Boolean(String(reference || "").trim()) &&
    String(paymentData?.currency || "").toUpperCase() === "GHS" &&
    Number.isSafeInteger(amount) &&
    amount > 0
  )
}
