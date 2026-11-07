import React from 'react';
import type { SceneTiming } from '../lib/timeline';
import { Ask, Crowd, Reveal, Signals } from './v3a';
import { Brake, Close3, Contract3, Council3, Swarm, Vault3 } from './v3b';

export const SCENES: Record<string, React.FC<{ s: SceneTiming }>> = {
  ask: Ask, crowd: Crowd, reveal: Reveal, signals: Signals, council: Council3, swarm: Swarm, contract: Contract3, vault: Vault3, brake: Brake, close: Close3,
};
