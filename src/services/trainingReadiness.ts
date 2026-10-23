export interface TrainingReadinessInput {
  payloadAvailable: boolean;
  attribution?: {
    identity: { modelId: string | null; source: string; verified: boolean };
    conflictReason?: string;
  };
}

/** Evidence must come from persisted server-side reviews/adapters, never request metadata. */
export interface TrainingEvidence {
  consent?: boolean;
  outcomeReviewed?: boolean;
  discoveryAvailable?: boolean;
  redactionReviewed?: boolean;
  causalCorrelationVerified?: boolean;
}

export function assessTrainingReadiness(record: TrainingReadinessInput, evidence: TrainingEvidence = {}) {
  const identity = record.attribution?.identity;
  const conflicted = Boolean(record.attribution?.conflictReason);
  const known = Boolean(identity?.modelId);
  const trusted = known && identity?.verified === true &&
    ['host_reported', 'gateway_observed'].includes(identity.source) &&
    evidence.causalCorrelationVerified === true && !conflicted;
  const tier: 'trusted' | 'unverified' | 'unknown' | 'conflicted' | 'excluded' =
    !record.payloadAvailable ? 'excluded' : conflicted ? 'conflicted' : trusted ? 'trusted' : known ? 'unverified' : 'unknown';
  const reasons: string[] = [];
  if (!record.payloadAvailable) reasons.push('payload_unavailable');
  if (conflicted) reasons.push('attribution_conflicted');
  if (!trusted) reasons.push('untrusted_model_attribution');
  if (!evidence.consent) reasons.push('training_consent_missing');
  if (!evidence.outcomeReviewed) reasons.push('reviewed_outcome_missing');
  if (!evidence.discoveryAvailable) reasons.push('discovery_context_missing');
  if (!evidence.redactionReviewed) reasons.push('redaction_review_missing');
  return { tier, eligible: reasons.length === 0, reasons };
}
