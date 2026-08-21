import type {Hex, WorkerState} from './types.js';

export function enrollDeal(input: {
  state: WorkerState;
  dealId: string;
  observedSourceHead: number;
  effectiveFromSourceBlock?: number;
  reason?: string;
  now: Date;
}): WorkerState['enrollments'][string] {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.dealId)) throw new Error('Enrollment requires a bytes32 dealId');
  if (!Number.isSafeInteger(input.observedSourceHead) || input.observedSourceHead < 0) throw new Error('Invalid canonical source head');
  const retroactive = input.effectiveFromSourceBlock !== undefined;
  const effective = input.effectiveFromSourceBlock ?? input.observedSourceHead + 1;
  if (!Number.isSafeInteger(effective) || effective < 0) throw new Error('Invalid effective source block');
  if (retroactive && !input.reason?.trim()) throw new Error('Explicit --effective-from enrollment requires an operator reason');
  const dealId = input.dealId as Hex;
  const key = dealId.toLowerCase();
  const at = input.now.toISOString();
  input.state.enrollments[key] = {dealId, effectiveFromSourceBlock: effective, enrolledAt: at};
  input.state.enrollmentHistory.push({
    at,
    dealId,
    effectiveFromSourceBlock: effective,
    observedSourceHead: input.observedSourceHead,
    retroactive,
    reason: retroactive ? input.reason!.trim() : 'ordinary enrollment effective after observed canonical head',
  });
  return input.state.enrollments[key]!;
}
