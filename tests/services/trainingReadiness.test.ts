import { assessTrainingReadiness } from '../../src/services/trainingReadiness.js';

test('self-report and execution success alone never produce a trusted training example', () => {
  const assessment = assessTrainingReadiness({ payloadAvailable: true,
    attribution: { identity: { modelId: 'claimed', source: 'self_reported', verified: false } },
  });
  expect(assessment.tier).toBe('unverified');
  expect(assessment.eligible).toBe(false);
  expect(assessment.reasons).toContain('untrusted_model_attribution');
  expect(assessment.reasons).toContain('training_consent_missing');
  expect(assessment.reasons).toContain('reviewed_outcome_missing');
});

test('conflicted attribution remains ineligible even with a claimed trusted source', () => {
  expect(assessTrainingReadiness({ payloadAvailable: true, attribution: {
    identity: { modelId: 'model', source: 'host_reported', verified: true }, conflictReason: 'conflict',
  } }).tier).toBe('conflicted');
});

test('missing attribution and unavailable payload have explicit exclusion reasons', () => {
  const result = assessTrainingReadiness({ payloadAvailable: false });
  expect(result.tier).toBe('excluded');
  expect(result.reasons).toContain('payload_unavailable');
  expect(result.eligible).toBe(false);
});

test('trusted eligibility requires all server-side evidence gates', () => {
  const record = { payloadAvailable: true, attribution: {
    identity: { modelId: 'observed', source: 'gateway_observed', verified: true },
  } };
  expect(assessTrainingReadiness(record).tier).toBe('unverified');
  const evidence = { consent: true, outcomeReviewed: true, discoveryAvailable: true,
    redactionReviewed: true, causalCorrelationVerified: true };
  expect(assessTrainingReadiness(record, evidence)).toEqual({ tier: 'trusted', eligible: true, reasons: [] });
  for (const field of Object.keys(evidence)) {
    expect(assessTrainingReadiness(record, { ...evidence, [field]: false }).eligible).toBe(false);
  }
});
