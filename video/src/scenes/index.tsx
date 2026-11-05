import React from 'react';
import type { SceneTiming } from '../lib/timeline';
import { Hook, Problem, Solution } from './act1';
import { Evidence } from './evidence';
import { Gate, Pipeline, Verify } from './trust';
import { Close, Proof } from './finale';

export const SCENES: Record<string, React.FC<{ s: SceneTiming }>> = {
  hook: Hook, problem: Problem, solution: Solution, evidence: Evidence, pipeline: Pipeline, gate: Gate, verify: Verify, proof: Proof, close: Close,
};
