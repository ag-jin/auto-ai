export function fee(subtotalCents) {
  return Math.round(subtotalCents * 0.1);
}
