import { createHash } from 'node:crypto';

/** Stable native vault identity. Never accepts or stores a plaintext credential. */
export const acquisitionSecretId = (owner: string, operationId: string, inputName: string): string =>
  `acq-${createHash('sha256').update(`${owner}\0${operationId}\0${inputName}`).digest('hex')}`;
