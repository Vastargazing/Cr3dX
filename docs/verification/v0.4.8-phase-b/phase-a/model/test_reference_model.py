"""Model, negative, prescribed, fuzz, and metamorphic tests for v0.4.8."""

from __future__ import annotations

import random
import unittest
from itertools import permutations

from reference_model import (
    Cr3dXModel,
    DealStatus,
    EvidenceAlreadyRecorded,
    EvidenceState,
    InvalidBatchSize,
    Kind,
    LimitExceeded,
    NoRelevantEvidence,
    NotDefaultable,
    RejectionReason,
    Result,
    SourceLog,
    SourceTransactionFailed,
    SourceTx,
    Unauthorized,
    UnknownEvidence,
    VerificationReverted,
    make_evidence_id,
)


def addr(n: int) -> str:
    return "0x" + f"{n:040x}"


BORROWER = addr(0xB0)
INVESTOR = addr(0x1A)
OTHER = addr(0xBAD)
GATEWAY = addr(0x600D)
DEALS = addr(0xDEA15)


class ReferenceModelTest(unittest.TestCase):
    def model(self, *, base_limit: int = 10_000) -> Cr3dXModel:
        return Cr3dXModel(
            creditcoin_chain_id=102031,
            deals_address=DEALS,
            gateway_address=GATEWAY,
            base_limit=base_limit,
            attestation_grace_period=600,
        )

    def deal(
        self,
        model: Cr3dXModel,
        *,
        required: int = 100,
        face: int = 1_100,
        due: int = 100,
        borrower: str = BORROWER,
        investor: str = INVESTOR,
    ) -> str:
        return model.create_deal(
            borrower=borrower,
            designated_investor=investor,
            required_funding=required,
            face_value=face,
            due_block=due,
        )

    def log(
        self,
        deal_id: str,
        kind: Kind,
        amount: int,
        nonce: int,
        *,
        counterparty: str = INVESTOR,
        recipient: str | None = None,
        emitter: str = GATEWAY,
    ) -> SourceLog:
        if recipient is None:
            recipient = BORROWER if kind == Kind.FUNDING else INVESTOR
        return SourceLog(
            emitter=emitter,
            kind=kind,
            deal_id=deal_id,
            counterparty=counterparty,
            recipient=recipient,
            amount=amount,
            event_nonce=nonce,
        )

    def tx(
        self,
        height: int,
        tx_index: int,
        *logs: SourceLog,
        verified: bool = True,
        status: int = 1,
        uncovered_from: str = OTHER,
        uncovered_gas_used: int = 999,
    ) -> SourceTx:
        return SourceTx(
            height=height,
            tx_index=tx_index,
            verified=verified,
            status=status,
            logs=tuple(logs),
            uncovered_from=uncovered_from,
            uncovered_gas_used=uncovered_gas_used,
        )

    def fund(
        self,
        model: Cr3dXModel,
        deal_id: str,
        amount: int,
        nonce: int,
        *,
        height: int = 50,
        tx_index: int | None = None,
        counterparty: str = INVESTOR,
        recipient: str = BORROWER,
    ) -> str:
        if tx_index is None:
            tx_index = nonce
        return model.submit_and_apply(
            self.tx(
                height,
                tx_index,
                self.log(
                    deal_id,
                    Kind.FUNDING,
                    amount,
                    nonce,
                    counterparty=counterparty,
                    recipient=recipient,
                ),
            )
        )[0]

    def repay(
        self,
        model: Cr3dXModel,
        deal_id: str,
        amount: int,
        nonce: int,
        *,
        height: int,
        tx_index: int | None = None,
        recipient: str = INVESTOR,
    ) -> str:
        if tx_index is None:
            tx_index = nonce
        return model.submit_and_apply(
            self.tx(
                height,
                tx_index,
                self.log(
                    deal_id,
                    Kind.REPAYMENT,
                    amount,
                    nonce,
                    counterparty=BORROWER,
                    recipient=recipient,
                ),
            )
        )[0]

    # Identity, verification boundary, stable order, and atomic negative witnesses.

    def test_identity_binds_terms_deployment_sequence_and_event_coordinates(self) -> None:
        m = self.model()
        d1 = self.deal(m)
        d2 = self.deal(m)
        self.assertNotEqual(d1, d2)
        other = self.model()
        d3 = self.deal(other, due=101)
        self.assertNotEqual(d1, d3)
        e1 = make_evidence_id(1, 50, 7, Kind.FUNDING, 1)
        self.assertNotEqual(e1, make_evidence_id(1, 50, 7, Kind.REPAYMENT, 1))
        self.assertNotEqual(e1, make_evidence_id(1, 50, 7, Kind.FUNDING, 2))

    def test_verify_precedes_tx_index_and_failed_verify_commits_nothing(self) -> None:
        m = self.model()
        d = self.deal(m)
        with self.assertRaises(VerificationReverted):
            m.verifier.submit_evidence(
                self.tx(50, 7, self.log(d, Kind.FUNDING, 100, 1), verified=False)
            )
        self.assertEqual([], m.verifier.trace)
        self.assertEqual({}, m.verifier.evidence)
        m.verifier.submit_evidence(
            self.tx(50, 7, self.log(d, Kind.FUNDING, 100, 1))
        )
        self.assertEqual([("verify", 50), ("calculateTxIndex", 50)], m.verifier.trace)

    def test_failed_source_transaction_named_model_error_is_atomic(self) -> None:
        m = self.model()
        d = self.deal(m)
        with self.assertRaises(SourceTransactionFailed) as caught:
            m.verifier.submit_evidence(
                self.tx(50, 1, self.log(d, Kind.FUNDING, 100, 1), status=0)
            )
        self.assertEqual("SOURCE_TRANSACTION_FAILED", caught.exception.tag)
        self.assertFalse(m.verifier.evidence)

    def test_foreign_emitter_and_no_relevant_log_named_error(self) -> None:
        m = self.model()
        d = self.deal(m)
        with self.assertRaises(NoRelevantEvidence) as caught:
            m.verifier.submit_evidence(
                self.tx(
                    50,
                    1,
                    self.log(d, Kind.FUNDING, 100, 1, emitter=OTHER),
                )
            )
        self.assertEqual("NoRelevantEvidence", caught.exception.tag)
        with self.assertRaises(NoRelevantEvidence):
            m.verifier.submit_evidence(
                self.tx(
                    51,
                    2,
                    SourceLog(GATEWAY, None, d, INVESTOR, BORROWER, 100, 2),
                )
            )
        self.assertFalse(m.verifier.evidence)

    def test_duplicate_inside_one_batch_reverts_atomically(self) -> None:
        m = self.model()
        d = self.deal(m)
        duplicate = self.log(d, Kind.FUNDING, 60, 1)
        with self.assertRaises(EvidenceAlreadyRecorded) as caught:
            m.verifier.submit_evidence_batch(
                [self.tx(50, 7, duplicate, duplicate)]
            )
        self.assertEqual("EvidenceAlreadyRecorded", caught.exception.tag)
        self.assertFalse(m.verifier.evidence)

    def test_duplicate_against_store_reverts_whole_later_batch(self) -> None:
        m = self.model()
        d = self.deal(m)
        first = self.tx(50, 7, self.log(d, Kind.FUNDING, 60, 1))
        m.verifier.submit_evidence(first)
        before = set(m.verifier.evidence)
        with self.assertRaises(EvidenceAlreadyRecorded):
            m.verifier.submit_evidence_batch(
                [
                    self.tx(51, 8, self.log(d, Kind.FUNDING, 40, 2)),
                    first,
                ]
            )
        self.assertEqual(before, set(m.verifier.evidence))

    def test_batch_size_and_unknown_identifiers_have_named_oracles(self) -> None:
        m = self.model()
        with self.assertRaises(InvalidBatchSize):
            m.verifier.submit_evidence_batch([])
        with self.assertRaises(InvalidBatchSize):
            m.verifier.submit_evidence_batch([self.tx(i, i) for i in range(11)])
        with self.assertRaises(UnknownEvidence) as got:
            m.verifier.get_evidence("0x" + "00" * 32)
        self.assertEqual("UnknownEvidence", got.exception.tag)
        with self.assertRaises(UnknownEvidence):
            m.apply_evidence("0x" + "00" * 32)

    def test_all_relevant_logs_create_one_evidence_in_stable_log_order(self) -> None:
        m = self.model()
        d = self.deal(m)
        tx = self.tx(
            50,
            7,
            self.log(d, Kind.REPAYMENT, 5, 9),
            self.log(d, Kind.FUNDING, 100, 4),
            self.log(d, Kind.FUNDING, 1, 8, emitter=OTHER),
        )
        ids = m.verifier.submit_evidence(tx)
        self.assertEqual(
            [
                make_evidence_id(1, 50, 7, Kind.REPAYMENT, 9),
                make_evidence_id(1, 50, 7, Kind.FUNDING, 4),
            ],
            ids,
        )

    def test_batch_identifier_order_is_transaction_then_log_order(self) -> None:
        m = self.model()
        d = self.deal(m)
        tx_a = self.tx(51, 9, self.log(d, Kind.FUNDING, 10, 3))
        tx_b = self.tx(
            50,
            7,
            self.log(d, Kind.FUNDING, 20, 1),
            self.log(d, Kind.REPAYMENT, 30, 2),
        )
        ids = m.verifier.submit_evidence_batch([tx_a, tx_b])
        self.assertEqual(
            [
                make_evidence_id(1, 51, 9, Kind.FUNDING, 3),
                make_evidence_id(1, 50, 7, Kind.FUNDING, 1),
                make_evidence_id(1, 50, 7, Kind.REPAYMENT, 2),
            ],
            ids,
        )

    def test_log_permutations_preserve_economics_and_return_their_own_order(self) -> None:
        states = []
        for order in permutations((Kind.FUNDING, Kind.REPAYMENT)):
            m = self.model()
            d = self.deal(m)
            logs = {
                Kind.FUNDING: self.log(d, Kind.FUNDING, 100, 1),
                Kind.REPAYMENT: self.log(
                    d,
                    Kind.REPAYMENT,
                    1_100,
                    2,
                    counterparty=BORROWER,
                    recipient=INVESTOR,
                ),
            }
            ids = m.submit_and_apply(self.tx(90, 7, *(logs[k] for k in order)))
            expected = [
                make_evidence_id(1, 90, 7, kind, logs[kind].event_nonce)
                for kind in order
            ]
            self.assertEqual(expected, ids)
            states.append(m.economic_state())
        self.assertEqual(states[0], states[1])

    def test_uncovered_from_and_gas_used_are_metamorphically_irrelevant(self) -> None:
        states = []
        for from_value, gas in ((OTHER, 1), (addr(42), 2**200)):
            m = self.model()
            d = self.deal(m)
            m.submit_and_apply(
                self.tx(
                    50,
                    7,
                    self.log(d, Kind.FUNDING, 100, 1),
                    uncovered_from=from_value,
                    uncovered_gas_used=gas,
                )
            )
            states.append(m.economic_state())
        self.assertEqual(states[0], states[1])

    # Evidence decision-time classification and retry behavior.

    def test_unknown_deal_waits_then_can_apply_after_creation(self) -> None:
        source = self.model()
        predicted = self.deal(source)
        m = self.model()
        eid = m.verifier.submit_evidence(
            self.tx(50, 1, self.log(predicted, Kind.FUNDING, 100, 1))
        )[0]
        self.assertEqual(EvidenceState.VERIFIED_PENDING, m.apply_evidence(eid)[0])
        created = self.deal(m)
        self.assertEqual(predicted, created)
        self.assertEqual(EvidenceState.APPLIED, m.apply_evidence(eid)[0])

    def test_recipient_precedes_investor_for_dual_mismatch(self) -> None:
        m = self.model()
        d = self.deal(m)
        eid = self.fund(
            m,
            d,
            100,
            1,
            counterparty=OTHER,
            recipient=OTHER,
        )
        evidence = m.verifier.get_evidence(eid)
        self.assertEqual(EvidenceState.REJECTED_PERMANENT, evidence.state)
        self.assertEqual(RejectionReason.WRONG_RECIPIENT, evidence.rejection_reason)

    def test_wrong_investor_funding_is_permanently_rejected(self) -> None:
        m = self.model()
        d = self.deal(m)
        eid = self.fund(m, d, 100, 1, counterparty=OTHER)
        evidence = m.verifier.get_evidence(eid)
        self.assertEqual(EvidenceState.REJECTED_PERMANENT, evidence.state)
        self.assertEqual(RejectionReason.WRONG_INVESTOR, evidence.rejection_reason)

    def test_wrong_recipient_for_both_kinds_is_permanently_rejected(self) -> None:
        m = self.model()
        d = self.deal(m)
        funding = self.fund(m, d, 100, 1, recipient=OTHER)
        repayment = self.repay(m, d, 1_100, 2, height=90, recipient=OTHER)
        self.assertEqual(
            RejectionReason.WRONG_RECIPIENT,
            m.verifier.get_evidence(funding).rejection_reason,
        )
        self.assertEqual(
            RejectionReason.WRONG_RECIPIENT,
            m.verifier.get_evidence(repayment).rejection_reason,
        )

    def test_correct_repayment_before_funding_waits_and_needs_explicit_retry(self) -> None:
        m = self.model()
        d = self.deal(m)
        repayment = self.repay(m, d, 1_100, 1, height=90)
        self.assertEqual(
            EvidenceState.VERIFIED_PENDING,
            m.verifier.get_evidence(repayment).state,
        )
        self.fund(m, d, 100, 2)
        self.assertEqual(0, m.deals[d].repaid_amount)
        self.assertEqual(
            EvidenceState.VERIFIED_PENDING,
            m.verifier.get_evidence(repayment).state,
        )
        m.apply_evidence(repayment)
        self.assertEqual(DealStatus.PAID_ON_TIME, m.deals[d].status)

    def test_terminal_apply_idempotence_and_pending_rechecks_without_revert(self) -> None:
        m = self.model()
        d = self.deal(m)
        pending = self.repay(m, d, 10, 1, height=90)
        snapshot = m.economic_state()
        self.assertEqual(EvidenceState.VERIFIED_PENDING, m.apply_evidence(pending)[0])
        self.assertEqual(snapshot, m.economic_state())
        rejected = self.fund(m, d, 10, 2, recipient=OTHER)
        snapshot = m.economic_state()
        self.assertEqual(
            EvidenceState.REJECTED_PERMANENT, m.apply_evidence(rejected)[0]
        )
        self.assertEqual(snapshot, m.economic_state())
        applied = self.fund(m, d, 100, 3)
        snapshot = m.economic_state()
        self.assertEqual(EvidenceState.APPLIED, m.apply_evidence(applied)[0])
        self.assertEqual(snapshot, m.economic_state())

    def test_inv19_is_decision_time_not_continuous_storage_rule(self) -> None:
        m = self.model()
        d = self.deal(m)
        pending = self.repay(m, d, 10, 1, height=90)
        self.fund(m, d, 100, 2)
        # Preconditions now hold, but there was no decision call for the old item.
        self.assertEqual(
            EvidenceState.VERIFIED_PENDING,
            m.verifier.get_evidence(pending).state,
        )

    # Funding, reserve, hard limit, due-block and two-phase witnesses.

    def test_cumulative_partial_funding_crosses_once_then_has_no_cap(self) -> None:
        m = self.model()
        d = self.deal(m, required=100, face=1_100)
        self.fund(m, d, 60, 1)
        self.assertEqual(1_100, m.reserved_of(BORROWER))
        self.assertEqual(0, m.exposure_of(BORROWER))
        self.fund(m, d, 50, 2)
        self.assertEqual(0, m.reserved_of(BORROWER))
        self.assertEqual(1_100, m.exposure_of(BORROWER))
        self.fund(m, d, 40, 3)
        self.assertEqual(150, m.deals[d].funded_amount)
        self.assertEqual(1_100, m.exposure_of(BORROWER))

    def test_all_six_funding_permutations_end_at_150(self) -> None:
        observed = []
        for order in permutations((60, 50, 40)):
            m = self.model()
            d = self.deal(m, required=100, face=1_100)
            for nonce, amount in enumerate(order, 1):
                self.fund(m, d, amount, nonce)
            observed.append(m.economic_state())
            self.assertEqual(150, m.deals[d].funded_amount)
            m.assert_internal_invariants()
        self.assertTrue(all(state == observed[0] for state in observed))

    def test_two_stable_phases_apply_funding_before_repayment_in_both_tx_orders(self) -> None:
        states = []
        for repayment_first in (True, False):
            m = self.model()
            d = self.deal(m, required=100, face=1_100)
            funding = self.tx(60, 2, self.log(d, Kind.FUNDING, 100, 2))
            repayment = self.tx(
                50,
                1,
                self.log(
                    d,
                    Kind.REPAYMENT,
                    1_100,
                    1,
                    counterparty=BORROWER,
                    recipient=INVESTOR,
                ),
            )
            m.submit_and_apply_batch(
                [repayment, funding] if repayment_first else [funding, repayment]
            )
            states.append(m.economic_state())
            self.assertEqual(DealStatus.PAID_ON_TIME, m.deals[d].status)
        self.assertEqual(states[0], states[1])

    def test_past_due_creation_and_funding_allowed_then_default_threshold_is_strict(self) -> None:
        m = self.model()
        m.set_attested_height(1_000)
        d = self.deal(m, due=100)
        self.fund(m, d, 100, 1, height=900)
        self.assertEqual(DealStatus.FINANCED, m.deals[d].status)
        m.mark_defaulted(d)
        self.assertEqual(DealStatus.DEFAULTED, m.deals[d].status)

        n = self.model()
        d2 = self.deal(n, due=100)
        self.fund(n, d2, 100, 1)
        n.set_attested_height(700)
        with self.assertRaises(NotDefaultable):
            n.mark_defaulted(d2)
        n.set_attested_height(701)
        n.mark_defaulted(d2)

    def test_hard_limit_reservation_and_no_reuse_by_unfunded_deals(self) -> None:
        m = self.model(base_limit=1_000)
        self.deal(m, required=10, face=600)
        with self.assertRaises(LimitExceeded):
            self.deal(m, required=10, face=401)
        self.deal(m, required=10, face=400)
        self.assertEqual(0, m.available_limit_of(BORROWER))

    def test_administrative_bypass_is_absent(self) -> None:
        m = self.model()
        with self.assertRaises(Unauthorized):
            m.administrative_mutation("setStatus", DealStatus.PAID_ON_TIME)

    # Canonical outcome, closedAtBlock, exposure, score, and status coupling.

    def test_on_time_branch_precedes_late_branch(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        self.repay(m, d, 1_100, 2, height=110)
        self.assertEqual(Result.PAID_LATE, m.outcomes[d].result)
        self.repay(m, d, 1_100, 3, height=90)
        self.assertEqual(Result.PAID_ON_TIME, m.outcomes[d].result)
        self.assertEqual(DealStatus.PAID_ON_TIME, m.deals[d].status)

    def test_partial_after_default_preserves_default_and_closed_at_block(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        m.set_attested_height(701)
        m.mark_defaulted(d)
        closed = m.outcomes[d].closed_at_block
        m.set_attested_height(800)
        self.repay(m, d, 100, 2, height=110)
        self.assertEqual(Result.DEFAULTED, m.outcomes[d].result)
        self.assertEqual(closed, m.outcomes[d].closed_at_block)

    def test_default_can_refine_to_late_or_on_time(self) -> None:
        for repayment_height, expected in ((110, Result.PAID_LATE), (90, Result.PAID_ON_TIME)):
            m = self.model()
            d = self.deal(m)
            self.fund(m, d, 100, 1)
            m.set_attested_height(701)
            m.mark_defaulted(d)
            m.set_attested_height(800)
            self.repay(m, d, 1_100, 2, height=repayment_height)
            self.assertEqual(expected, m.outcomes[d].result)
            self.assertEqual(800, m.outcomes[d].closed_at_block)

    def test_evidence_only_replay_cannot_invent_default_history(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        self.repay(m, d, 100, 2, height=110)
        self.assertNotIn(d, m.outcomes)
        self.assertIsNone(m.canonical_result(d))
        m.set_attested_height(701)
        m.mark_defaulted(d)
        self.assertEqual(Result.DEFAULTED, m.canonical_result(d))

    def test_closed_at_block_same_result_is_stable_and_changed_result_updates(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        m.set_attested_height(10)
        self.repay(m, d, 1_100, 2, height=110)
        self.assertEqual(10, m.outcomes[d].closed_at_block)
        m.set_attested_height(20)
        self.repay(m, d, 1, 3, height=110)
        self.assertEqual(10, m.outcomes[d].closed_at_block)
        self.repay(m, d, 1_100, 4, height=90)
        self.assertEqual(Result.PAID_ON_TIME, m.outcomes[d].result)
        self.assertEqual(20, m.outcomes[d].closed_at_block)

    def test_inv20_regression_late_and_timely_full_both_orders(self) -> None:
        states = []
        for order in ((110, 90), (90, 110)):
            m = self.model()
            d = self.deal(m)
            self.fund(m, d, 100, 1)
            for nonce, height in enumerate(order, 2):
                self.repay(m, d, 1_100, nonce, height=height)
            states.append(m.economic_state())
            self.assertEqual(2_200, m.deals[d].repaid_amount)
            self.assertEqual(1_100, m.deals[d].on_time_repaid)
            self.assertEqual(0, m.deals[d].outstanding)
            self.assertEqual(Result.PAID_ON_TIME, m.outcomes[d].result)
        self.assertEqual(states[0], states[1])

    def test_repayment_splitting_overpayment_and_mixed_timing_do_not_duplicate_score(self) -> None:
        m = self.model()
        d = self.deal(m, face=1_100)
        self.fund(m, d, 100, 1)
        self.repay(m, d, 500, 2, height=90)
        self.repay(m, d, 700, 3, height=110)
        self.repay(m, d, 2_000, 4, height=110)
        self.assertEqual(3_200, m.deals[d].repaid_amount)
        self.assertEqual(0, m.deals[d].outstanding)
        self.assertEqual(Result.PAID_LATE, m.outcomes[d].result)
        self.assertEqual(1, m.credit[BORROWER].paid_late)
        self.assertEqual(450, m.score_of(BORROWER))
        self.assertEqual(0, m.exposure_of(BORROWER))

    def test_closed_deal_still_accumulates_repayment_without_reserve_change(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        self.repay(m, d, 1_100, 2, height=90)
        reserve = m.reserved_of(BORROWER)
        self.repay(m, d, 500, 3, height=110)
        self.assertEqual(1_600, m.deals[d].repaid_amount)
        self.assertEqual(reserve, m.reserved_of(BORROWER))
        self.assertEqual(Result.PAID_ON_TIME, m.outcomes[d].result)

    def test_exposure_can_exceed_new_limit_and_available_saturates(self) -> None:
        m = self.model(base_limit=1_000)
        d = self.deal(m, required=100, face=1_000)
        self.fund(m, d, 100, 1)
        m.set_attested_height(701)
        m.mark_defaulted(d)
        self.assertEqual(300, m.score_of(BORROWER))
        self.assertEqual(600, m.limit_of(BORROWER))
        self.assertEqual(1_000, m.exposure_of(BORROWER))
        self.assertEqual(0, m.available_limit_of(BORROWER))

    def test_score_counter_cache_matches_full_recount_through_refinement(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        m.set_attested_height(701)
        m.mark_defaulted(d)
        self.assertEqual(m.recomputed_score(BORROWER), m.score_of(BORROWER))
        self.repay(m, d, 1_100, 2, height=110)
        self.assertEqual((0, 1, 0), m.full_recount_counters(BORROWER))
        self.assertEqual(m.recomputed_score(BORROWER), m.score_of(BORROWER))
        self.repay(m, d, 1_100, 3, height=90)
        self.assertEqual((1, 0, 0), m.full_recount_counters(BORROWER))
        self.assertEqual(m.recomputed_score(BORROWER), m.score_of(BORROWER))

    def test_score_clamps_once_after_signed_aggregate(self) -> None:
        m = self.model(base_limit=100_000)
        for index in range(5):
            borrower = BORROWER
            d = self.deal(m, required=1, face=1_000, due=100, borrower=borrower)
            self.fund(m, d, 1, 10 + index)
            m.set_attested_height(701 + index)
            m.mark_defaulted(d)
        self.assertEqual(300, m.score_of(BORROWER))
        self.assertEqual(m.recomputed_score(BORROWER), m.score_of(BORROWER))

    def test_status_and_outcome_never_diverge_across_all_outcome_transitions(self) -> None:
        m = self.model()
        d = self.deal(m)
        self.fund(m, d, 100, 1)
        m.set_attested_height(701)
        m.mark_defaulted(d)
        m.assert_internal_invariants()
        self.repay(m, d, 1_100, 2, height=110)
        m.assert_internal_invariants()
        self.repay(m, d, 1_100, 3, height=90)
        m.assert_internal_invariants()

    def test_mark_defaulted_only_financed_and_uses_attested_source_height(self) -> None:
        m = self.model()
        unknown = "0x" + "ab" * 32
        with self.assertRaises(NotDefaultable):
            m.mark_defaulted(unknown)
        d = self.deal(m)
        m.set_attested_height(10_000)
        with self.assertRaises(NotDefaultable):
            m.mark_defaulted(d)

        repeated = self.model()
        d2 = self.deal(repeated)
        self.fund(repeated, d2, 100, 10)
        repeated.set_attested_height(701)
        repeated.mark_defaulted(d2)
        with self.assertRaises(NotDefaultable):
            repeated.mark_defaulted(d2)
        self.fund(m, d, 100, 1)
        self.repay(m, d, 1_100, 2, height=110)
        with self.assertRaises(NotDefaultable):
            m.mark_defaulted(d)
        self.repay(m, d, 1_100, 3, height=90)
        with self.assertRaises(NotDefaultable):
            m.mark_defaulted(d)

    # Metamorphic scope witnesses.

    def test_inv3_allows_evidence_state_difference_when_economics_match(self) -> None:
        predicted_model = self.model()
        predicted_deal = self.deal(predicted_model)

        early = self.model()
        early_id = early.verifier.submit_evidence(
            self.tx(
                50,
                1,
                self.log(
                    predicted_deal,
                    Kind.FUNDING,
                    100,
                    1,
                    counterparty=OTHER,
                ),
            )
        )[0]
        early.apply_evidence(early_id)
        self.deal(early)

        late = self.model()
        late_deal = self.deal(late)
        late_id = late.submit_and_apply(
            self.tx(
                50,
                1,
                self.log(
                    late_deal,
                    Kind.FUNDING,
                    100,
                    1,
                    counterparty=OTHER,
                ),
            )
        )[0]
        self.assertEqual(early.economic_state(), late.economic_state())
        self.assertEqual(
            EvidenceState.VERIFIED_PENDING,
            early.verifier.get_evidence(early_id).state,
        )
        self.assertEqual(
            EvidenceState.REJECTED_PERMANENT,
            late.verifier.get_evidence(late_id).state,
        )

    def test_closed_at_block_excluded_from_economic_order_independence(self) -> None:
        direct = self.model()
        d1 = self.deal(direct)
        self.fund(direct, d1, 100, 1)
        direct.set_attested_height(701)
        self.repay(direct, d1, 1_100, 2, height=110)

        refined = self.model()
        d2 = self.deal(refined)
        self.fund(refined, d2, 100, 1)
        refined.set_attested_height(701)
        refined.mark_defaulted(d2)
        refined.set_attested_height(800)
        self.repay(refined, d2, 1_100, 2, height=110)

        self.assertEqual(direct.economic_state(), refined.economic_state())
        self.assertNotEqual(
            direct.outcomes[d1].closed_at_block,
            refined.outcomes[d2].closed_at_block,
        )

    def test_default_declaration_timing_does_not_change_final_payment_classification(self) -> None:
        for height, expected in ((90, Result.PAID_ON_TIME), (110, Result.PAID_LATE)):
            before = self.model()
            d1 = self.deal(before)
            self.fund(before, d1, 100, 1)
            before.set_attested_height(701)
            before.mark_defaulted(d1)
            self.repay(before, d1, 1_100, 2, height=height)

            without = self.model()
            d2 = self.deal(without)
            self.fund(without, d2, 100, 1)
            without.set_attested_height(701)
            self.repay(without, d2, 1_100, 2, height=height)
            with self.assertRaises(NotDefaultable):
                without.mark_defaulted(d2)

            self.assertEqual(expected, before.outcomes[d1].result)
            self.assertEqual(before.economic_state(), without.economic_state())

    def test_batch_grouping_with_explicit_retry_converges(self) -> None:
        together = self.model()
        d1 = self.deal(together)
        together.submit_and_apply_batch(
            [
                self.tx(
                    50,
                    1,
                    self.log(d1, Kind.REPAYMENT, 1_100, 1, counterparty=BORROWER),
                ),
                self.tx(60, 2, self.log(d1, Kind.FUNDING, 100, 2)),
            ]
        )

        split = self.model()
        d2 = self.deal(split)
        pending = split.submit_and_apply(
            self.tx(
                50,
                1,
                self.log(d2, Kind.REPAYMENT, 1_100, 1, counterparty=BORROWER),
            )
        )[0]
        split.submit_and_apply(
            self.tx(60, 2, self.log(d2, Kind.FUNDING, 100, 2))
        )
        split.apply_evidence(pending)
        self.assertEqual(together.economic_state(), split.economic_state())

    # Deterministic generated action sequences over the model oracle.

    def test_seeded_fuzz_sequences_preserve_continuous_invariants(self) -> None:
        for seed in range(100):
            rng = random.Random(seed)
            m = self.model(base_limit=100_000)
            d = self.deal(
                m,
                required=rng.randint(1, 200),
                face=rng.randint(500, 2_000),
                due=rng.randint(50, 150),
            )
            deal = m.deals[d]
            nonce = 1
            for _ in range(30):
                action = rng.choice(("fund", "repay", "default", "retry"))
                if action == "fund":
                    self.fund(m, d, rng.randint(0, 300), nonce, height=rng.randint(1, 250))
                    nonce += 1
                elif action == "repay":
                    self.repay(
                        m,
                        d,
                        rng.randint(0, 500),
                        nonce,
                        height=rng.randint(1, 250),
                    )
                    nonce += 1
                elif action == "default":
                    target = max(m.attested_height, deal.due_block + 601)
                    m.set_attested_height(target)
                    try:
                        m.mark_defaulted(d)
                    except NotDefaultable:
                        pass
                else:
                    pending = [
                        eid
                        for eid, ev in m.verifier.evidence.items()
                        if ev.state == EvidenceState.VERIFIED_PENDING
                    ]
                    if pending:
                        m.apply_evidence(rng.choice(pending))
                m.assert_internal_invariants()


if __name__ == "__main__":
    unittest.main(verbosity=2)
