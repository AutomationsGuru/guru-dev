export function shareBudget(parentRemaining: number, ratio: number, floor: number): number {
  const share = Math.floor(parentRemaining * ratio);
  return Math.max(share, floor);
}
