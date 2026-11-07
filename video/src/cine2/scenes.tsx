import React from 'react';
import type { CScene } from './timeline';
import { Ask, Crowd, Reveal, Signals, Rank } from './scenesA';
import { Council, Swarm, Contract, Vault, Brake, Community, Close } from './scenesB';

export const CINE_SCENES: Record<string, React.FC<{ s: CScene }>> = { ask: Ask, crowd: Crowd, reveal: Reveal, signals: Signals, rank: Rank, council: Council, swarm: Swarm, contract: Contract, vault: Vault, brake: Brake, community: Community, close: Close };
