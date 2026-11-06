import React from 'react';
import type { SceneTiming } from '../lib/timeline';
import { Evidence } from './evidence';
import { Approval, Close2, Council, Night, Owner, Poison, Refusal, Testnet } from './v2';

export const SCENES: Record<string, React.FC<{ s: SceneTiming }>> = {
  night: Night, poison: Poison, owner: Owner, evidence: Evidence, council: Council, approval: Approval, refusal: Refusal, testnet: Testnet, close: Close2,
};
