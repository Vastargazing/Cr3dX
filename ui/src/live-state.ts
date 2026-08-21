import type { LiveState } from "./rpc";
import { ACCEPTED_SNAPSHOT } from "./snapshot";

export interface LiveDifference {
  field: string;
  accepted: string;
  observed: string;
}

export interface SuccessfulLiveRead {
  value: LiveState;
  differences: readonly LiveDifference[];
}

export type LiveObservationState =
  | { kind: "idle" }
  | { kind: "loading"; lastSuccessful?: SuccessfulLiveRead }
  | { kind: "fresh"; lastSuccessful: SuccessfulLiveRead }
  | { kind: "stale"; lastSuccessful: SuccessfulLiveRead; error: string }
  | { kind: "unavailable"; error: string };

type ComparableValue = string | number | bigint;

function text(value: ComparableValue): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

export function compareLiveToAcceptedSnapshot(value: LiveState): readonly LiveDifference[] {
  const fields: ReadonlyArray<readonly [string, ComparableValue, ComparableValue]> = [
    ["status", ACCEPTED_SNAPSHOT.status, value.status],
    ["score", ACCEPTED_SNAPSHOT.scoreAfter, value.score],
    ["fundedAmount", ACCEPTED_SNAPSHOT.fundedAmount, value.fundedAmount],
    ["repaidAmount", ACCEPTED_SNAPSHOT.repaidAmount, value.repaidAmount],
    ["onTimeRepaid", ACCEPTED_SNAPSHOT.onTimeRepaid, value.onTimeRepaid],
    ["outstanding", ACCEPTED_SNAPSHOT.outstanding, value.outstanding],
    ["reserved", ACCEPTED_SNAPSHOT.reserved, value.reserved],
    ["exposure", ACCEPTED_SNAPSHOT.exposure, value.exposure],
    ["limit", ACCEPTED_SNAPSHOT.limitAfter, value.limit],
    ["availableLimit", ACCEPTED_SNAPSHOT.limitAfter, value.availableLimit],
    ["repaymentEvidence", "APPLIED", value.repaymentEvidence],
    ["raceEvidence", "APPLIED", value.raceEvidence],
  ];

  return fields.flatMap(([field, accepted, observed]) =>
    accepted === observed ? [] : [{ field, accepted: text(accepted), observed: text(observed) }],
  );
}

function lastSuccessful(state: LiveObservationState): SuccessfulLiveRead | undefined {
  if (state.kind === "fresh" || state.kind === "stale") return state.lastSuccessful;
  if (state.kind === "loading") return state.lastSuccessful;
  return undefined;
}

export function beginLiveRead(state: LiveObservationState): LiveObservationState {
  const previous = lastSuccessful(state);
  return previous === undefined ? { kind: "loading" } : { kind: "loading", lastSuccessful: previous };
}

export function completeLiveRead(value: LiveState): LiveObservationState {
  return {
    kind: "fresh",
    lastSuccessful: { value, differences: compareLiveToAcceptedSnapshot(value) },
  };
}

export function failLiveRead(state: LiveObservationState, error: string): LiveObservationState {
  const previous = lastSuccessful(state);
  return previous === undefined
    ? { kind: "unavailable", error }
    : { kind: "stale", lastSuccessful: previous, error };
}

export interface LiveRefreshController {
  getState(): LiveObservationState;
  refresh(): Promise<void>;
}

export function createLiveRefreshController(
  reader: () => Promise<LiveState>,
  render: (state: LiveObservationState) => void,
): LiveRefreshController {
  let state: LiveObservationState = { kind: "idle" };

  return {
    getState: () => state,
    refresh: async () => {
      state = beginLiveRead(state);
      render(state);
      try {
        state = completeLiveRead(await reader());
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : "Unknown RPC error";
        state = failLiveRead(state, detail);
      }
      render(state);
    },
  };
}
