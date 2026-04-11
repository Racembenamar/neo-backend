/**
 * Tier & Points Business Logic Service
 * All point calculations and tier management live here.
 */

export interface TierConfig {
  tier1Threshold: number;
  tier2Threshold: number;
  tier3Threshold: number;
  tier4Threshold: number;
  tier5Threshold: number;
  tier1Pct: number;
  tier2Pct: number;
  tier3Pct: number;
  tier4Pct: number;
  tier5Pct: number;
  pointsPerDt: number;
}

export function getTierPct(tier: number, config: TierConfig): number {
  if (tier >= 5) return config.tier5Pct;
  if (tier === 4) return config.tier4Pct;
  if (tier === 3) return config.tier3Pct;
  if (tier === 2) return config.tier2Pct;
  return config.tier1Pct;
}

export function getNextTierThreshold(tier: number, config: TierConfig): number | null {
  if (tier === 1) return config.tier2Threshold;
  if (tier === 2) return config.tier3Threshold;
  if (tier === 3) return config.tier4Threshold;
  if (tier === 4) return config.tier5Threshold;
  return null; // already max tier
}

export function calculatePointsEarned(
  totalAmount: number,
  tier: number,
  config: TierConfig
): number {
  const pct = getTierPct(tier, config);
  // Points = totalAmount * (pct / 100) * pointsPerDt
  // Example: 20 DT * 5% * 50 = 50 points at tier 1
  return Math.floor(totalAmount * (pct / 100) * config.pointsPerDt);
}

export function checkPendingUpgrade(
  newTotalPoints: number,
  currentTier: number,
  config: TierConfig
): boolean {
  const threshold = getNextTierThreshold(currentTier, config);
  if (threshold === null) return false; // already tier 3
  return newTotalPoints >= threshold;
}

export function pointsToDt(points: number, pointsPerDt: number): number {
  return points / pointsPerDt;
}

export function dtToPoints(dt: number, pointsPerDt: number): number {
  return Math.floor(dt * pointsPerDt);
}
