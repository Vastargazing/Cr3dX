#!/usr/bin/env python3
"""Export the frozen blind Phase A oracle as implementation-neutral JSON.

This exporter imports the frozen v0.4.8 model read-only. It has no production
adapter and does not inspect or name any implementation checkout.
"""

from __future__ import annotations

import hashlib
import json
import random
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence


PHASE_A = Path(
    "/home/va/Documents/Codex/2026-08-20/cr3dx-v048-blind-phase-a-2/outputs/"
    "cr3dx-v0.4.8-phase-a"
)
MODEL_DIR = PHASE_A / "model"
sys.path.insert(0, str(MODEL_DIR))

from reference_model import (  # noqa: E402
    Cr3dXModel,
    EvidenceState,
    Kind,
    ModelError,
    SourceLog,
    SourceTx,
    make_deal_id,
    terms_hash,
)


OUTPUT = Path(__file__).with_name("expectation-corpus.json")


def addr(n: int) -> str:
    return "0x" + f"{n:040x}"


ACTORS = {
    "BORROWER_0": addr(0xB0),
    "BORROWER_1": addr(0xB1),
    "INVESTOR_0": addr(0x1A),
    "INVESTOR_1": addr(0x1B),
    "OTHER_0": addr(0xBAD),
    "GATEWAY_0": addr(0x600D),
    "FOREIGN_GATEWAY_0": addr(0xF0),
    "DEALS_RUNTIME": addr(0xDEA15),
}
ACTOR_BY_ADDRESS = {value.lower(): key for key, value in ACTORS.items()}


FULL_SCOPE = {
    "name": "full_phase_a_observable",
    "include": [
        "attested_height",
        "deals.*.{borrower,designated_investor,investor,required_funding,face_value,due_block,status,funded_amount,repaid_amount,on_time_repaid,outstanding}",
        "evidence.*.{kind,deal,counterparty,recipient,amount,block_height,tx_index,event_nonce,state,rejection_reason}",
        "borrowers.*.{reserved,exposure,score,limit,available_limit,paid_on_time_count,paid_late_count,defaulted_count}",
        "outcomes.*.{result,closed_at_block}",
        "expected_call",
    ],
    "excluded_by_spec_or_adapter_boundary": [
        "raw runtime dealId and evidenceId values (symbolic handles are compared)",
        "sourceTxHash",
        "uncovered RPC wrapper fields from and gasUsed",
        "local Creditcoin block.number and block.timestamp",
        "model-internal verifier trace",
    ],
}

ECONOMIC_SCOPE = {
    "name": "economic_state_INV_3_INV_20",
    "include": [
        "deals.*.{status,funded_amount,repaid_amount,on_time_repaid,outstanding}",
        "borrowers.*.{reserved,exposure,score}",
        "outcomes.*.result",
        "expected_call when the relation names call success/failure",
    ],
    "excluded_by_spec_or_adapter_boundary": [
        "evidence state and rejection reason",
        "outcomes.*.closed_at_block",
        "attested_height",
        "fixed deal terms and symbolic/raw identifiers",
        "sourceTxHash",
        "uncovered RPC wrapper fields from and gasUsed",
    ],
}

CLASSIFICATION_SCOPE = {
    "name": "evidence_decision_time_classification_INV_19",
    "include": [
        "target evidence state",
        "target evidence rejection_reason",
        "expected_call",
        "economic fields changed by an APPLIED decision",
    ],
    "excluded_by_spec_or_adapter_boundary": [
        "continuous reclassification of stored pending evidence between calls",
        "unrelated evidence records",
        "outcomes.*.closed_at_block unless the decision changes outcome",
        "raw runtime identifiers",
    ],
}

EXTRACTION_SCOPE = {
    "name": "verified_evidence_extraction_and_order",
    "include": [
        "expected_call.return.evidence",
        "evidence.*.{kind,deal,counterparty,recipient,amount,block_height,tx_index,event_nonce}",
        "atomic absence of all staged records on failure",
    ],
    "excluded_by_spec_or_adapter_boundary": [
        "raw runtime evidenceId bytes (symbolic handles are compared)",
        "sourceTxHash",
        "uncovered RPC wrapper fields from and gasUsed",
        "later application classification unless requested by the action",
    ],
}

SCOPE_BY_NAME = {
    scope["name"]: scope
    for scope in (FULL_SCOPE, ECONOMIC_SCOPE, CLASSIFICATION_SCOPE, EXTRACTION_SCOPE)
}


def symbolic_actor(address: Optional[str]) -> Optional[str]:
    if address is None:
        return None
    return ACTOR_BY_ADDRESS.get(address.lower(), "UNMAPPED_ACTOR")


def log_dto(
    kind: Optional[str],
    deal: str,
    amount: int,
    nonce: int,
    *,
    counterparty: Optional[str] = None,
    recipient: Optional[str] = None,
    emitter: str = "GATEWAY_0",
) -> Dict[str, Any]:
    if counterparty is None:
        counterparty = "INVESTOR_0" if kind == "FUNDING" else "BORROWER_0"
    if recipient is None:
        recipient = "BORROWER_0" if kind == "FUNDING" else "INVESTOR_0"
    return {
        "emitter": emitter,
        "kind": kind,
        "deal": deal,
        "counterparty": counterparty,
        "recipient": recipient,
        "amount": amount,
        "event_nonce": nonce,
    }


def tx_dto(
    height: int,
    tx_index: int,
    logs: Sequence[Dict[str, Any]],
    *,
    proof_verified: bool = True,
    status: int = 1,
    uncovered_from: str = "OTHER_0",
    uncovered_gas_used: int = 999,
) -> Dict[str, Any]:
    return {
        "height": height,
        "tx_index": tx_index,
        "proof_verified": proof_verified,
        "source_transaction_status": status,
        "logs": list(logs),
        "uncovered_wrapper_fields": {
            "from": uncovered_from,
            "gas_used": uncovered_gas_used,
        },
    }


class TraceBuilder:
    def __init__(
        self,
        trace_id: str,
        category_order: int,
        category: str,
        provenance_class: str,
        construction: Dict[str, Any],
        provenance_links: Sequence[str],
        *,
        metamorphic: Optional[Dict[str, Any]] = None,
        base_limit: int = 10_000,
    ) -> None:
        self.trace_id = trace_id
        self.category_order = category_order
        self.category = category
        self.provenance_class = provenance_class
        self.construction = construction
        self.provenance_links = list(dict.fromkeys(provenance_links))
        self.metamorphic = deepcopy(metamorphic)
        self.model = Cr3dXModel(
            creditcoin_chain_id=102031,
            deals_address=ACTORS["DEALS_RUNTIME"],
            gateway_address=ACTORS["GATEWAY_0"],
            chain_key=1,
            base_limit=base_limit,
            attestation_grace_period=600,
        )
        self.actions: List[Dict[str, Any]] = []
        self.deal_to_raw: Dict[str, str] = {}
        self.raw_to_deal: Dict[str, str] = {}
        self.planned_deals: Dict[str, Dict[str, Any]] = {}
        self.evidence_to_raw: Dict[str, str] = {}
        self.raw_to_evidence: Dict[str, str] = {}

    def plan_deal(
        self,
        handle: str = "D0",
        *,
        borrower: str = "BORROWER_0",
        investor: str = "INVESTOR_0",
        required_funding: int = 100,
        face_value: int = 1_100,
        due_block: int = 100,
        sequence: Optional[int] = None,
    ) -> str:
        if sequence is None:
            sequence = self.model.deal_seq + len(
                [h for h in self.planned_deals if h not in self.deal_to_raw]
            )
        plan = {
            "borrower": borrower,
            "designated_investor": investor,
            "required_funding": required_funding,
            "face_value": face_value,
            "due_block": due_block,
            "sequence": sequence,
        }
        digest = terms_hash(
            ACTORS[borrower],
            ACTORS[investor],
            required_funding,
            face_value,
            due_block,
        )
        raw = make_deal_id(
            self.model.creditcoin_chain_id,
            self.model.deals_address,
            sequence,
            digest,
        )
        self.planned_deals[handle] = plan
        self.deal_to_raw[handle] = raw
        self.raw_to_deal[raw] = handle
        return handle

    def _raw_deal(self, handle: str) -> str:
        if handle not in self.deal_to_raw:
            raise KeyError(f"deal handle is not planned: {handle}")
        return self.deal_to_raw[handle]

    def _source_log(self, item: Dict[str, Any]) -> SourceLog:
        kind = None if item["kind"] is None else Kind[item["kind"]]
        return SourceLog(
            emitter=ACTORS[item["emitter"]],
            kind=kind,
            deal_id=self._raw_deal(item["deal"]),
            counterparty=ACTORS[item["counterparty"]],
            recipient=ACTORS[item["recipient"]],
            amount=item["amount"],
            event_nonce=item["event_nonce"],
        )

    def _source_tx(self, item: Dict[str, Any]) -> SourceTx:
        uncovered = item["uncovered_wrapper_fields"]
        return SourceTx(
            height=item["height"],
            tx_index=item["tx_index"],
            verified=item["proof_verified"],
            status=item["source_transaction_status"],
            logs=tuple(self._source_log(log) for log in item["logs"]),
            uncovered_from=ACTORS[uncovered["from"]],
            uncovered_gas_used=uncovered["gas_used"],
        )

    def _assign_evidence(self, raw_ids: Sequence[str]) -> List[str]:
        handles: List[str] = []
        for raw in raw_ids:
            if raw not in self.raw_to_evidence:
                handle = f"E{len(self.raw_to_evidence)}"
                self.raw_to_evidence[raw] = handle
                self.evidence_to_raw[handle] = raw
            handles.append(self.raw_to_evidence[raw])
        return handles

    def _snapshot(self) -> Dict[str, Any]:
        deals: Dict[str, Any] = {}
        for raw, deal in self.model.deals.items():
            handle = self.raw_to_deal[raw]
            deals[handle] = {
                "borrower": symbolic_actor(deal.borrower),
                "designated_investor": symbolic_actor(deal.designated_investor),
                "investor": symbolic_actor(deal.investor),
                "required_funding": deal.required_funding,
                "face_value": deal.face_value,
                "due_block": deal.due_block,
                "status": deal.status.value,
                "funded_amount": deal.funded_amount,
                "repaid_amount": deal.repaid_amount,
                "on_time_repaid": deal.on_time_repaid,
                "outstanding": deal.outstanding,
            }

        evidence: Dict[str, Any] = {}
        for raw, item in self.model.verifier.evidence.items():
            handle = self.raw_to_evidence[raw]
            evidence[handle] = {
                "kind": item.kind.name,
                "deal": self.raw_to_deal[item.deal_id],
                "counterparty": symbolic_actor(item.counterparty),
                "recipient": symbolic_actor(item.recipient),
                "amount": item.amount,
                "block_height": item.block_height,
                "tx_index": item.tx_index,
                "event_nonce": item.event_nonce,
                "state": item.state.value,
                "rejection_reason": item.rejection_reason.value,
            }

        borrowers: Dict[str, Any] = {}
        for raw, account in self.model.credit.items():
            handle = symbolic_actor(raw)
            assert handle is not None
            borrowers[handle] = {
                "reserved": account.reserved,
                "exposure": account.exposure,
                "score": self.model.score_of(raw),
                "limit": self.model.limit_of(raw),
                "available_limit": self.model.available_limit_of(raw),
                "paid_on_time_count": account.paid_on_time,
                "paid_late_count": account.paid_late,
                "defaulted_count": account.defaulted,
            }

        outcomes: Dict[str, Any] = {}
        for raw, outcome in self.model.outcomes.items():
            outcomes[self.raw_to_deal[raw]] = {
                "result": outcome.result.value,
                "closed_at_block": outcome.closed_at_block,
            }

        return {
            "attested_height": self.model.attested_height,
            "deals": dict(sorted(deals.items())),
            "evidence": dict(sorted(evidence.items())),
            "borrowers": dict(sorted(borrowers.items())),
            "outcomes": dict(sorted(outcomes.items())),
        }

    def _record(
        self,
        action: str,
        inputs: Dict[str, Any],
        expected_call: Dict[str, Any],
        scope: Dict[str, Any],
    ) -> None:
        self.model.assert_internal_invariants()
        self.actions.append(
            {
                "step": len(self.actions),
                "action": action,
                "inputs": deepcopy(inputs),
                "expected_call": expected_call,
                "expected_state_after": self._snapshot(),
                "comparison_scope": deepcopy(scope),
            }
        )

    def _run(
        self,
        action: str,
        inputs: Dict[str, Any],
        operation: Any,
        *,
        scope: Dict[str, Any] = FULL_SCOPE,
        map_evidence_result: bool = False,
    ) -> Optional[Any]:
        try:
            result = operation()
            if map_evidence_result:
                result = {"evidence": self._assign_evidence(result)}
            elif result is None:
                result = None
            expected = {"status": "ok", "return": result}
            self._record(action, inputs, expected, scope)
            return result
        except ModelError as error:
            expected = {"status": "named_failure", "name": error.tag}
            self._record(action, inputs, expected, scope)
            return None

    def set_attested_height(self, height: int, *, scope: Dict[str, Any] = FULL_SCOPE) -> None:
        self._run(
            "set_attested_height",
            {"height": height},
            lambda: self.model.set_attested_height(height),
            scope=scope,
        )

    def create_deal(
        self,
        handle: str = "D0",
        *,
        borrower: str = "BORROWER_0",
        investor: str = "INVESTOR_0",
        required_funding: int = 100,
        face_value: int = 1_100,
        due_block: int = 100,
        scope: Dict[str, Any] = FULL_SCOPE,
    ) -> None:
        if handle not in self.planned_deals:
            self.plan_deal(
                handle,
                borrower=borrower,
                investor=investor,
                required_funding=required_funding,
                face_value=face_value,
                due_block=due_block,
                sequence=self.model.deal_seq,
            )
        inputs = {
            "deal": handle,
            "borrower": borrower,
            "designated_investor": investor,
            "required_funding": required_funding,
            "face_value": face_value,
            "due_block": due_block,
        }

        def operation() -> Dict[str, str]:
            raw = self.model.create_deal(
                borrower=ACTORS[borrower],
                designated_investor=ACTORS[investor],
                required_funding=required_funding,
                face_value=face_value,
                due_block=due_block,
            )
            if raw != self.deal_to_raw[handle]:
                raise AssertionError("planned symbolic deal did not match model identity")
            return {"deal": handle}

        self._run("create_deal", inputs, operation, scope=scope)

    def submit_single(
        self,
        tx: Dict[str, Any],
        *,
        application: str = "new_evidence_two_phase",
        scope: Dict[str, Any] = FULL_SCOPE,
    ) -> None:
        source = self._source_tx(tx)
        if application == "new_evidence_two_phase":
            operation = lambda: self.model.submit_and_apply(source)
        elif application == "store_only":
            operation = lambda: self.model.verifier.submit_evidence(source)
        else:
            raise ValueError(application)
        self._run(
            "submit_single",
            {"application": application, "transaction": tx},
            operation,
            scope=scope,
            map_evidence_result=True,
        )

    def submit_batch(
        self,
        txs: Sequence[Dict[str, Any]],
        *,
        application: str = "new_evidence_two_phase",
        scope: Dict[str, Any] = FULL_SCOPE,
    ) -> None:
        sources = [self._source_tx(tx) for tx in txs]
        if application == "new_evidence_two_phase":
            operation = lambda: self.model.submit_and_apply_batch(sources)
        elif application == "store_only":
            operation = lambda: self.model.verifier.submit_evidence_batch(sources)
        else:
            raise ValueError(application)
        self._run(
            "submit_batch",
            {"application": application, "transactions": list(txs)},
            operation,
            scope=scope,
            map_evidence_result=True,
        )

    def apply_evidence(
        self,
        handle: str,
        *,
        scope: Dict[str, Any] = CLASSIFICATION_SCOPE,
    ) -> None:
        raw = self.evidence_to_raw.get(handle, "0x" + "00" * 32)

        def operation() -> Dict[str, str]:
            state, reason = self.model.apply_evidence(raw)
            return {"state": state.value, "rejection_reason": reason.value}

        self._run("apply_evidence", {"evidence": handle}, operation, scope=scope)

    def read_evidence(self, handle: str) -> None:
        raw = self.evidence_to_raw.get(handle, "0x" + "00" * 32)

        def operation() -> Dict[str, str]:
            item = self.model.verifier.get_evidence(raw)
            return {"evidence": handle, "state": item.state.value}

        self._run(
            "read_evidence",
            {"evidence": handle},
            operation,
            scope=EXTRACTION_SCOPE,
        )

    def mark_defaulted(self, deal: str = "D0", *, scope: Dict[str, Any] = FULL_SCOPE) -> None:
        raw = self.deal_to_raw.get(deal, "0x" + "ff" * 32)
        self._run(
            "mark_defaulted",
            {"deal": deal},
            lambda: self.model.mark_defaulted(raw),
            scope=scope,
        )

    def pending_handles(self) -> List[str]:
        return [
            self.raw_to_evidence[raw]
            for raw, item in self.model.verifier.evidence.items()
            if item.state == EvidenceState.VERIFIED_PENDING
        ]

    def finish(self) -> Dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "category_order": self.category_order,
            "category": self.category,
            "provenance_class": self.provenance_class,
            "construction_provenance": self.construction,
            "provenance_links": self.provenance_links,
            "metamorphic": self.metamorphic,
            "actions": self.actions,
        }


def explicit(description: str) -> Dict[str, Any]:
    return {"type": "explicit_construction", "description": description}


def relation(
    row: str,
    equivalence_class: str,
    variant: str,
    *,
    relation_name: str = "equal_at_final_step_in_declared_scope",
    scope: Dict[str, Any] = ECONOMIC_SCOPE,
) -> Dict[str, Any]:
    return {
        "phase_a_matrix_row": row,
        "relation": relation_name,
        "equivalence_class": equivalence_class,
        "variant": variant,
        "compare_at": "final_step",
        "comparison_scope": deepcopy(scope),
    }


def basic_create(builder: TraceBuilder, **overrides: Any) -> None:
    builder.create_deal(**overrides)


def funding_tx(deal: str, amount: int, nonce: int, *, height: int = 50, tx_index: Optional[int] = None, **log_overrides: Any) -> Dict[str, Any]:
    if tx_index is None:
        tx_index = nonce
    return tx_dto(height, tx_index, [log_dto("FUNDING", deal, amount, nonce, **log_overrides)])


def repayment_tx(deal: str, amount: int, nonce: int, *, height: int, tx_index: Optional[int] = None, **log_overrides: Any) -> Dict[str, Any]:
    if tx_index is None:
        tx_index = nonce
    return tx_dto(height, tx_index, [log_dto("REPAYMENT", deal, amount, nonce, **log_overrides)])


def add_independently_derived_metamorphic(traces: List[Dict[str, Any]]) -> None:
    # M15: uncovered wrapper fields are irrelevant.
    for index, (source_actor, gas) in enumerate((("OTHER_0", 1), ("BORROWER_1", 2**200))):
        b = TraceBuilder(
            f"ind-meta-uncovered-fields-v{index}", 1, "independently_derived_metamorphic_permutations",
            "independently_derived", explicit("Hold covered funding fact fixed; mutate only uncovered from/gasUsed."),
            ["metamorphic-test-matrix:M15", "INV-15"],
            metamorphic=relation("M15_uncovered_fields", "uncovered-fields", f"variant-{index}", scope=FULL_SCOPE),
        )
        basic_create(b)
        tx = funding_tx("D0", 100, 1)
        tx["uncovered_wrapper_fields"] = {"from": source_actor, "gas_used": gas}
        b.submit_single(tx, scope=FULL_SCOPE)
        traces.append(b.finish())

    # M14: closedAtBlock may differ while economic state is equal.
    direct = TraceBuilder(
        "ind-meta-closedat-direct-late", 1, "independently_derived_metamorphic_permutations",
        "independently_derived", explicit("Reach PAID_LATE directly at attested height 701."),
        ["metamorphic-test-matrix:M14", "INV-3", "INV-20"],
        metamorphic=relation("M14_closedAt_timing", "closedat-excluded", "direct-late"),
    )
    basic_create(direct); direct.submit_single(funding_tx("D0", 100, 1)); direct.set_attested_height(701); direct.submit_single(repayment_tx("D0", 1_100, 2, height=110), scope=ECONOMIC_SCOPE)
    traces.append(direct.finish())
    refined = TraceBuilder(
        "ind-meta-closedat-default-refine", 1, "independently_derived_metamorphic_permutations",
        "independently_derived", explicit("Write DEFAULTED at 701, then refine to PAID_LATE at 800."),
        ["metamorphic-test-matrix:M14", "INV-3", "INV-20"],
        metamorphic=relation("M14_closedAt_timing", "closedat-excluded", "default-then-late"),
    )
    basic_create(refined); refined.submit_single(funding_tx("D0", 100, 1)); refined.set_attested_height(701); refined.mark_defaulted(); refined.set_attested_height(800); refined.submit_single(repayment_tx("D0", 1_100, 2, height=110), scope=ECONOMIC_SCOPE)
    traces.append(refined.finish())

    # M16: early pending versus late permanent rejection, same economics.
    early = TraceBuilder(
        "ind-meta-classification-early-pending", 1, "independently_derived_metamorphic_permutations",
        "independently_derived", explicit("Submit wrong-investor funding before D0 exists and do not retry after creation."),
        ["metamorphic-test-matrix:M16", "INV-3", "INV-19"],
        metamorphic=relation("M16_early_late_classification", "classification-excluded", "early-pending"),
    )
    early.plan_deal(); early.submit_single(funding_tx("D0", 100, 1, counterparty="OTHER_0"), application="store_only", scope=CLASSIFICATION_SCOPE); early.apply_evidence("E0"); early.create_deal(scope=ECONOMIC_SCOPE)
    traces.append(early.finish())
    late = TraceBuilder(
        "ind-meta-classification-late-rejected", 1, "independently_derived_metamorphic_permutations",
        "independently_derived", explicit("Create D0 before submitting the same wrong-investor funding fact."),
        ["metamorphic-test-matrix:M16", "INV-3", "INV-19"],
        metamorphic=relation("M16_early_late_classification", "classification-excluded", "late-rejected"),
    )
    basic_create(late); late.submit_single(funding_tx("D0", 100, 1, counterparty="OTHER_0"), scope=ECONOMIC_SCOPE)
    traces.append(late.finish())

    # M12: default declaration before payment versus rejected after payment.
    for payment_height, label in ((90, "timely"), (110, "late")):
        before = TraceBuilder(
            f"ind-meta-default-before-{label}", 1, "independently_derived_metamorphic_permutations",
            "independently_derived", explicit(f"Declare default when eligible, then deliver full {label} repayment."),
            ["metamorphic-test-matrix:M12", "INV-4", "INV-20", "INV-22"],
            metamorphic=relation("M12_default_timing", f"default-timing-{label}", "default-before-payment"),
        )
        basic_create(before); before.submit_single(funding_tx("D0", 100, 1)); before.set_attested_height(701); before.mark_defaulted(); before.submit_single(repayment_tx("D0", 1_100, 2, height=payment_height), scope=ECONOMIC_SCOPE)
        traces.append(before.finish())
        after = TraceBuilder(
            f"ind-meta-default-after-{label}", 1, "independently_derived_metamorphic_permutations",
            "independently_derived", explicit(f"Deliver full {label} repayment, then attempt default at eligible height."),
            ["metamorphic-test-matrix:M12", "INV-4", "INV-20", "INV-22"],
            metamorphic=relation("M12_default_timing", f"default-timing-{label}", "payment-before-default"),
        )
        basic_create(after); after.submit_single(funding_tx("D0", 100, 1)); after.set_attested_height(701); after.submit_single(repayment_tx("D0", 1_100, 2, height=payment_height)); after.mark_defaulted(scope=ECONOMIC_SCOPE)
        traces.append(after.finish())

    # M05/M06/M07: one batch versus split delivery with explicit retry.
    together = TraceBuilder(
        "ind-meta-batch-grouping-together", 1, "independently_derived_metamorphic_permutations",
        "independently_derived", explicit("Funding and repayment are newly created in one call."),
        ["metamorphic-test-matrix:M05", "metamorphic-test-matrix:M07", "INV-3"],
        metamorphic=relation("M05_batch_grouping", "batch-grouping-retry-closure", "one-batch"),
    )
    basic_create(together); together.submit_batch([repayment_tx("D0", 1_100, 1, height=90), funding_tx("D0", 100, 2, height=60)], scope=ECONOMIC_SCOPE)
    traces.append(together.finish())
    split = TraceBuilder(
        "ind-meta-batch-grouping-split-retry", 1, "independently_derived_metamorphic_permutations",
        "independently_derived", explicit("Repayment is stored pending, funding arrives separately, then E0 is explicitly retried."),
        ["metamorphic-test-matrix:M05", "metamorphic-test-matrix:M06", "metamorphic-test-matrix:M07", "INV-19"],
        metamorphic=relation("M05_batch_grouping", "batch-grouping-retry-closure", "split-with-explicit-retry"),
    )
    basic_create(split); split.submit_single(repayment_tx("D0", 1_100, 1, height=90)); split.submit_single(funding_tx("D0", 100, 2, height=60), scope=CLASSIFICATION_SCOPE); split.apply_evidence("E0", scope=ECONOMIC_SCOPE)
    traces.append(split.finish())


def add_two_phase_and_order(traces: List[Dict[str, Any]]) -> None:
    # M01: transaction order in one registry submission.
    for label, txs in (
        ("repayment-first", [repayment_tx("D0", 1_100, 1, height=50), funding_tx("D0", 100, 2, height=60)]),
        ("funding-first", [funding_tx("D0", 100, 2, height=60), repayment_tx("D0", 1_100, 1, height=50)]),
    ):
        b = TraceBuilder(
            f"two-phase-transaction-order-{label}", 2, "two_phase_funding_before_repayment",
            "spec_prescribed", explicit("Permute input transaction order; newly created facts use funding phase then repayment phase."),
            ["metamorphic-test-matrix:M01", "section-9:same-call-funding-repayment", "INV-3"],
            metamorphic=relation("M01_transaction_order", "same-call-two-phase", label),
        )
        basic_create(b); b.submit_batch(txs, scope=ECONOMIC_SCOPE); traces.append(b.finish())

    # M03: log order in one verified transaction.
    fund = log_dto("FUNDING", "D0", 100, 1)
    repay = log_dto("REPAYMENT", "D0", 1_100, 2)
    for label, logs in (("repayment-first", [repay, fund]), ("funding-first", [fund, repay])):
        b = TraceBuilder(
            f"two-phase-log-order-{label}", 2, "two_phase_funding_before_repayment",
            "spec_prescribed", explicit("Permute relevant log order inside one verified transaction."),
            ["metamorphic-test-matrix:M03", "INV-3", "INV-17"],
            metamorphic=relation("M03_log_order", "same-tx-log-permutation", label),
        )
        basic_create(b); b.submit_single(tx_dto(90, 7, logs), scope=ECONOMIC_SCOPE); traces.append(b.finish())

    # M04: stable transaction-then-log return order.
    for label, txs in (
        ("A-then-B", [tx_dto(51, 9, [log_dto("FUNDING", "D0", 10, 3)]), tx_dto(50, 7, [log_dto("FUNDING", "D0", 20, 1), log_dto("REPAYMENT", "D0", 30, 2)])]),
        ("B-then-A", [tx_dto(50, 7, [log_dto("FUNDING", "D0", 20, 1), log_dto("REPAYMENT", "D0", 30, 2)]), tx_dto(51, 9, [log_dto("FUNDING", "D0", 10, 3)])]),
    ):
        b = TraceBuilder(
            f"two-phase-stable-id-order-{label}", 2, "two_phase_funding_before_repayment",
            "spec_prescribed", explicit("Return symbolic evidence handles in transaction order then log order."),
            ["metamorphic-test-matrix:M04", "INV-17"],
            metamorphic=relation("M04_stable_identifier_order", "stable-id-order", label, relation_name="output_order_tracks_input_permutation", scope=EXTRACTION_SCOPE),
        )
        basic_create(b); b.submit_batch(txs, application="store_only", scope=EXTRACTION_SCOPE); traces.append(b.finish())


def add_classification(traces: List[Dict[str, Any]]) -> None:
    # M06/M11: stored pending is not implicitly retried; retry timing variants.
    variants = (
        ("retry-before-funding", True, 0),
        ("retry-immediately-after", False, 0),
        ("retry-much-later", False, 1_000),
    )
    for label, retry_before, later_height in variants:
        b = TraceBuilder(
            f"classification-explicit-retry-{label}", 3, "classification_decision_time_and_explicit_re_evaluation",
            "spec_prescribed", explicit("Correct repayment is pending on CREATED; only named apply_evidence re-evaluates it."),
            ["metamorphic-test-matrix:M06", "metamorphic-test-matrix:M11", "section-9:pending-explicit-retry", "INV-19"],
            metamorphic=relation("M11_explicit_retry_timing", "retry-timing", label),
        )
        basic_create(b); b.submit_single(repayment_tx("D0", 1_100, 1, height=90), scope=CLASSIFICATION_SCOPE)
        if retry_before: b.apply_evidence("E0")
        b.submit_single(funding_tx("D0", 100, 2), scope=CLASSIFICATION_SCOPE)
        if later_height: b.set_attested_height(later_height, scope=CLASSIFICATION_SCOPE)
        b.apply_evidence("E0", scope=ECONOMIC_SCOPE); traces.append(b.finish())

    # Unknown deal may later be created.
    b = TraceBuilder(
        "classification-unknown-deal-create-retry", 3, "classification_decision_time_and_explicit_re_evaluation",
        "spec_prescribed", explicit("Submit funding for planned D0 before D0 exists; create and retry explicitly."),
        ["INV-19", "section-9:evidence-state-machine"],
    )
    b.plan_deal(); b.submit_single(funding_tx("D0", 100, 1), application="store_only", scope=CLASSIFICATION_SCOPE); b.apply_evidence("E0"); b.create_deal(); b.apply_evidence("E0"); traces.append(b.finish())

    # Permanent reasons and recipient-before-investor priority.
    for trace_id, kind, overrides, expected_link in (
        ("classification-funding-wrong-investor", "FUNDING", {"counterparty": "OTHER_0"}, "WRONG_INVESTOR"),
        ("classification-funding-wrong-recipient", "FUNDING", {"recipient": "OTHER_0"}, "WRONG_RECIPIENT"),
        ("classification-repayment-wrong-recipient-created", "REPAYMENT", {"recipient": "OTHER_0"}, "WRONG_RECIPIENT"),
        ("classification-funding-dual-mismatch-recipient-wins", "FUNDING", {"counterparty": "OTHER_0", "recipient": "OTHER_0"}, "recipient-before-investor"),
    ):
        b = TraceBuilder(
            trace_id, 3, "classification_decision_time_and_explicit_re_evaluation",
            "spec_prescribed", explicit("Classify immutable mismatch at the decision call."),
            ["INV-19", f"section-9:{expected_link}"],
        )
        basic_create(b)
        tx = funding_tx("D0", 100, 1, **overrides) if kind == "FUNDING" else repayment_tx("D0", 100, 1, height=90, **overrides)
        b.submit_single(tx, scope=CLASSIFICATION_SCOPE); traces.append(b.finish())

    # Terminal idempotence and pending no-op retry in one trace.
    b = TraceBuilder(
        "classification-terminal-and-pending-idempotence", 3, "classification_decision_time_and_explicit_re_evaluation",
        "spec_prescribed", explicit("Repeat apply on rejected, applied, and pending evidence."),
        ["section-9:repeat-applyEvidence", "INV-2", "INV-19"],
    )
    basic_create(b); b.submit_single(funding_tx("D0", 10, 1, recipient="OTHER_0")); b.apply_evidence("E0"); b.submit_single(funding_tx("D0", 100, 2)); b.apply_evidence("E1"); b.plan_deal("D1", borrower="BORROWER_1", sequence=1); b.submit_single(repayment_tx("D1", 10, 3, height=90), application="store_only"); b.apply_evidence("E2"); b.apply_evidence("E2"); traces.append(b.finish())


def add_accounting_and_metamorphic(traces: List[Dict[str, Any]]) -> None:
    # M02: all six cumulative-funding permutations.
    from itertools import permutations
    for index, order in enumerate(permutations((60, 50, 40))):
        label = "-".join(map(str, order))
        b = TraceBuilder(
            f"accounting-funding-permutation-{index}-{label}", 4, "accounting_boundaries",
            "spec_prescribed", explicit("Apply funding amounts 60, 50, 40 at threshold 100 in a fixed permutation."),
            ["metamorphic-test-matrix:M02", "section-9:all-six-funding-orders", "INV-3", "INV-11", "INV-18"],
            metamorphic=relation("M02_cumulative_funding", "funding-60-50-40", label),
        )
        basic_create(b)
        for nonce, amount in enumerate(order, 1): b.submit_single(funding_tx("D0", amount, nonce), scope=ECONOMIC_SCOPE)
        traces.append(b.finish())

    # M08: full late + full timely in both orders.
    for label, heights in (("late-then-timely", (110, 90)), ("timely-then-late", (90, 110))):
        b = TraceBuilder(
            f"accounting-repayment-full-order-{label}", 4, "accounting_boundaries",
            "spec_prescribed", explicit("Face 1100; apply full repayments at heights 110 and 90 in both orders."),
            ["metamorphic-test-matrix:M08", "section-9:INV-20-regression", "INV-12", "INV-20"],
            metamorphic=relation("M08_repayment_delivery", "full-late-timely", label),
        )
        basic_create(b); b.submit_single(funding_tx("D0", 100, 1))
        for nonce, height in enumerate(heights, 2): b.submit_single(repayment_tx("D0", 1_100, nonce, height=height), scope=ECONOMIC_SCOPE)
        traces.append(b.finish())

    # M09 splitting: one full late versus two late halves.
    for label, amounts in (("one", (1_100,)), ("split", (500, 600))):
        b = TraceBuilder(
            f"accounting-repayment-splitting-{label}", 4, "accounting_boundaries",
            "spec_prescribed", explicit("Hold total and timing fixed while partitioning repayment."),
            ["metamorphic-test-matrix:M09", "INV-6"],
            metamorphic=relation("M09_repayment_splitting", "late-split-1100", label),
        )
        basic_create(b); b.submit_single(funding_tx("D0", 100, 1))
        for nonce, amount in enumerate(amounts, 2): b.submit_single(repayment_tx("D0", amount, nonce, height=110), scope=ECONOMIC_SCOPE)
        traces.append(b.finish())

    # M10 overpayment: one versus split, same full amount.
    for label, amounts in (("one", (1_600,)), ("split", (1_100, 500))):
        b = TraceBuilder(
            f"accounting-overpayment-{label}", 4, "accounting_boundaries",
            "spec_prescribed", explicit("Hold overpayment total 1600 fixed while partitioning delivery."),
            ["metamorphic-test-matrix:M10", "section-9:overpayment", "INV-9", "INV-20"],
            metamorphic=relation("M10_overpayment", "overpayment-1600", label),
        )
        basic_create(b); b.submit_single(funding_tx("D0", 100, 1))
        for nonce, amount in enumerate(amounts, 2): b.submit_single(repayment_tx("D0", amount, nonce, height=110), scope=ECONOMIC_SCOPE)
        traces.append(b.finish())

    # M13 default memory under partial repayment order.
    for label, facts in (("A-then-B", ((100, 110), (200, 90))), ("B-then-A", ((200, 90), (100, 110)))):
        b = TraceBuilder(
            f"accounting-default-memory-{label}", 4, "accounting_boundaries",
            "spec_prescribed", explicit("Declare default, then permute two partial repayments below face value."),
            ["metamorphic-test-matrix:M13", "section-9:partial-after-default", "INV-4", "INV-20"],
            metamorphic=relation("M13_default_memory", "default-partial-order", label),
        )
        basic_create(b); b.submit_single(funding_tx("D0", 100, 1)); b.set_attested_height(701); b.mark_defaulted()
        for nonce, (amount, height) in enumerate(facts, 2): b.submit_single(repayment_tx("D0", amount, nonce, height=height), scope=ECONOMIC_SCOPE)
        traces.append(b.finish())

    # Hard limit and saturating available capacity.
    b = TraceBuilder(
        "accounting-hard-limit-reservations", 4, "accounting_boundaries",
        "spec_prescribed", explicit("Reserve 600 and 400 of base limit 1000; reject a third face value 1."),
        ["section-9:unfunded-deals-exhaust-limit", "INV-10", "INV-13"], base_limit=1_000,
    )
    b.create_deal("D0", required_funding=10, face_value=600); b.create_deal("D1", required_funding=10, face_value=400); b.create_deal("D2", required_funding=1, face_value=1); traces.append(b.finish())

    # Past-due creation/funding and strict default threshold.
    b = TraceBuilder(
        "accounting-past-due-funding-strict-default", 4, "accounting_boundaries",
        "spec_prescribed", explicit("Create after due block, fund, reject at due+grace equality, allow at +1."),
        ["section-9:past-due-funding", "INV-11", "INV-14", "INV-22"],
    )
    b.set_attested_height(700); b.create_deal(due_block=100); b.submit_single(funding_tx("D0", 100, 1, height=650)); b.mark_defaulted(); b.set_attested_height(701); b.mark_defaulted(); traces.append(b.finish())

    # Exposure above reduced limit remains valid and saturating.
    b = TraceBuilder(
        "accounting-exposure-above-limit-after-default", 4, "accounting_boundaries",
        "spec_prescribed", explicit("Fully expose 1000, then default lowers score/limit while exposure remains."),
        ["section-9:exposure-above-limit", "INV-5", "INV-9", "INV-10"], base_limit=1_000,
    )
    b.create_deal(required_funding=100, face_value=1_000); b.submit_single(funding_tx("D0", 100, 1)); b.set_attested_height(701); b.mark_defaulted(); traces.append(b.finish())

    # Funding continues after threshold and after paid closure.
    b = TraceBuilder(
        "accounting-valid-funding-after-threshold-and-payment", 4, "accounting_boundaries",
        "spec_prescribed", explicit("Cross threshold, close paid, then apply later valid funding in full."),
        ["section-9:post-threshold-funding", "INV-11", "INV-18"],
    )
    basic_create(b); b.submit_single(funding_tx("D0", 110, 1)); b.submit_single(repayment_tx("D0", 1_100, 2, height=90)); b.submit_single(funding_tx("D0", 40, 3), scope=ECONOMIC_SCOPE); traces.append(b.finish())

    # Fixed-seed independently derived traces.
    for seed in (0, 7, 42):
        rng = random.Random(seed)
        b = TraceBuilder(
            f"accounting-fixed-seed-{seed:03d}", 4, "accounting_boundaries",
            "independently_derived", {"type": "fixed_seed", "seed": seed, "generator": "12 actions from funding/repayment/height/default/retry"},
            ["test-catalog:independently-derived-fuzz-dimensions", "INV-2", "INV-4", "INV-5", "INV-9", "INV-21", "INV-22"],
        )
        basic_create(b, face_value=500)
        nonce = 1
        for _ in range(12):
            choice = rng.choice(("fund", "repay", "height", "default", "retry"))
            if choice == "fund":
                b.submit_single(funding_tx("D0", rng.randint(0, 250), nonce, height=rng.randint(1, 250))); nonce += 1
            elif choice == "repay":
                b.submit_single(repayment_tx("D0", rng.randint(0, 300), nonce, height=rng.randint(1, 250))); nonce += 1
            elif choice == "height":
                b.set_attested_height(b.model.attested_height + rng.randint(0, 300))
            elif choice == "default":
                b.mark_defaulted()
            else:
                pending = b.pending_handles()
                if pending: b.apply_evidence(rng.choice(pending))
                else: b.set_attested_height(b.model.attested_height)
        traces.append(b.finish())


def add_named_errors(traces: List[Dict[str, Any]]) -> None:
    cases = []

    b = TraceBuilder("errors-verification-reverted", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Proof verification fails before txIndex use."), ["section-9:failed-proof", "INV-8", "INV-16"]); basic_create(b); tx = funding_tx("D0", 100, 1); tx["proof_verified"] = False; b.submit_single(tx, application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())
    b = TraceBuilder("errors-source-transaction-failed", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Verified source transaction has status zero."), ["section-9:status-zero", "INV-8"]); basic_create(b); tx = funding_tx("D0", 100, 1); tx["source_transaction_status"] = 0; b.submit_single(tx, application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())
    b = TraceBuilder("errors-no-relevant-log", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Verified transaction contains no relevant topic."), ["section-9:no-relevant-log", "INV-17"]); basic_create(b); b.submit_single(tx_dto(50, 1, [log_dto(None, "D0", 100, 1)]), application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())
    b = TraceBuilder("errors-foreign-emitter", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Matching-shaped event is emitted by a foreign address."), ["section-9:foreign-emitter", "INV-8", "INV-17"]); basic_create(b); b.submit_single(funding_tx("D0", 100, 1, emitter="FOREIGN_GATEWAY_0"), application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())

    b = TraceBuilder("errors-duplicate-inside-batch-atomic", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Two identical event coordinates appear within one submitted batch."), ["section-9:atomic-duplicate-in-batch", "INV-2"]); basic_create(b); duplicate = log_dto("FUNDING", "D0", 60, 1); b.submit_batch([tx_dto(50, 7, [duplicate, duplicate])], application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())
    b = TraceBuilder("errors-duplicate-against-store-atomic", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("A later batch stages a new fact then encounters an already stored ID; neither staged fact commits."), ["section-9:duplicate", "INV-2"]); basic_create(b); first = funding_tx("D0", 60, 1, height=50, tx_index=7); b.submit_single(first, application="store_only", scope=EXTRACTION_SCOPE); b.submit_batch([funding_tx("D0", 40, 2, height=51, tx_index=8), first], application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())

    b = TraceBuilder("errors-unknown-evidence-read-apply", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Read and apply a symbolic evidence handle not recorded by the verifier."), ["section-9:unknown-evidence", "INV-2"]); b.read_evidence("E_UNKNOWN"); b.apply_evidence("E_UNKNOWN"); cases.append(b.finish())
    b = TraceBuilder("errors-mark-default-unknown", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Default declaration for unknown symbolic deal."), ["section-9:unknown-deal-default", "INV-22"]); b.mark_defaulted("D_UNKNOWN"); cases.append(b.finish())
    b = TraceBuilder("errors-mark-default-created", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Default declaration from CREATED at high attested height."), ["section-9:default-created", "INV-22"]); basic_create(b); b.set_attested_height(10_000); b.mark_defaulted(); cases.append(b.finish())
    b = TraceBuilder("errors-mark-default-paid", 5, "named_errors_and_atomicity", "spec_prescribed", explicit("Default declaration from PAID_ON_TIME."), ["section-9:default-paid", "INV-22"]); basic_create(b); b.submit_single(funding_tx("D0", 100, 1)); b.submit_single(repayment_tx("D0", 1_100, 2, height=90)); b.set_attested_height(10_000); b.mark_defaulted(); cases.append(b.finish())
    b = TraceBuilder("errors-empty-batch", 5, "named_errors_and_atomicity", "independently_derived", explicit("Submit zero transactions to the batch boundary."), ["test-catalog:additional-negative", "verifier-batch-boundary"]); b.submit_batch([], application="store_only", scope=EXTRACTION_SCOPE); cases.append(b.finish())

    traces.extend(cases)


def add_spec_prescribed_mandatory(traces: List[Dict[str, Any]]) -> None:
    # Late partial plus timely full, both orders.
    for label, facts in (("late-partial-first", ((500, 110), (1_100, 90))), ("timely-full-first", ((1_100, 90), (500, 110)))):
        b = TraceBuilder(
            f"mandatory-late-partial-timely-full-{label}", 6, "specification_prescribed_mandatory_cases",
            "spec_prescribed", explicit("Section 9 mandatory late partial plus timely full repayment order."),
            ["section-9:late-partial-timely-full", "INV-12", "INV-20"],
            metamorphic=relation("section9_late_partial_timely_full", "late-partial-timely-full", label),
        )
        basic_create(b); b.submit_single(funding_tx("D0", 100, 1))
        for nonce, (amount, height) in enumerate(facts, 2): b.submit_single(repayment_tx("D0", amount, nonce, height=height), scope=ECONOMIC_SCOPE)
        traces.append(b.finish())

    # Closed deal repayment and PAID_LATE -> PAID_ON_TIME -> no downgrade.
    b = TraceBuilder(
        "mandatory-closed-repayment-refinement-no-downgrade", 6, "specification_prescribed_mandatory_cases",
        "spec_prescribed", explicit("Close late, refine on timely evidence, then deliver more late evidence."),
        ["section-9:closed-repayment", "section-9:paid-late-refinement", "section-9:no-downgrade", "INV-4", "INV-21"],
    )
    basic_create(b); b.submit_single(funding_tx("D0", 100, 1)); b.submit_single(repayment_tx("D0", 1_100, 2, height=110)); b.submit_single(repayment_tx("D0", 1_100, 3, height=90)); b.submit_single(repayment_tx("D0", 500, 4, height=110)); traces.append(b.finish())

    # One transaction with two relevant events.
    b = TraceBuilder(
        "mandatory-one-transaction-two-events", 6, "specification_prescribed_mandatory_cases",
        "spec_prescribed", explicit("One verified successful source transaction contains two relevant gateway logs."),
        ["section-9:two-events-one-transaction", "INV-17"],
    )
    basic_create(b); b.submit_single(tx_dto(50, 7, [log_dto("FUNDING", "D0", 60, 1), log_dto("FUNDING", "D0", 50, 2)]), application="store_only", scope=EXTRACTION_SCOPE); traces.append(b.finish())

    # changed/same closedAtBlock.
    b = TraceBuilder(
        "mandatory-closedat-same-and-change", 6, "specification_prescribed_mandatory_cases",
        "spec_prescribed", explicit("Same canonical value preserves closedAtBlock; refinement updates it."),
        ["section-9:closedAtBlock", "INV-4"],
    )
    basic_create(b); b.submit_single(funding_tx("D0", 100, 1)); b.set_attested_height(10); b.submit_single(repayment_tx("D0", 1_100, 2, height=110)); b.set_attested_height(20); b.submit_single(repayment_tx("D0", 1, 3, height=110)); b.submit_single(repayment_tx("D0", 1_100, 4, height=90)); traces.append(b.finish())


def semantic_key(trace: Dict[str, Any]) -> str:
    material = {
        "actions": [
            {"action": item["action"], "inputs": item["inputs"]}
            for item in trace["actions"]
        ]
    }
    return hashlib.sha256(
        json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def deduplicate(traces: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    kept: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for trace in traces:
        key = semantic_key(trace)
        if key not in kept:
            kept[key] = trace
            order.append(key)
            continue
        existing = kept[key]
        existing["provenance_links"] = sorted(
            set(existing["provenance_links"]) | set(trace["provenance_links"])
        )
        existing.setdefault("deduplicated_trace_ids", []).append(trace["trace_id"])
    return [kept[key] for key in order]


def economic_projection(state: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "deals": {
            handle: {
                key: item[key]
                for key in (
                    "status", "funded_amount", "repaid_amount", "on_time_repaid", "outstanding"
                )
            }
            for handle, item in state["deals"].items()
        },
        "borrowers": {
            handle: {key: item[key] for key in ("reserved", "exposure", "score")}
            for handle, item in state["borrowers"].items()
        },
        "outcomes": {
            handle: item["result"] for handle, item in state["outcomes"].items()
        },
    }


def validate(traces: Sequence[Dict[str, Any]]) -> None:
    ids = [trace["trace_id"] for trace in traces]
    if len(ids) != len(set(ids)):
        raise AssertionError("duplicate trace identifier")
    for trace in traces:
        if not trace["actions"]:
            raise AssertionError(f"empty trace: {trace['trace_id']}")
        for index, action in enumerate(trace["actions"]):
            if action["step"] != index:
                raise AssertionError("unstable step index")
            if "expected_call" not in action or "expected_state_after" not in action:
                raise AssertionError("missing per-step oracle")
            if "comparison_scope" not in action:
                raise AssertionError("missing per-step scope")

    # Validate equal-in-economic-scope equivalence classes with two or more variants.
    classes: Dict[str, List[Dict[str, Any]]] = {}
    for trace in traces:
        meta = trace.get("metamorphic")
        if meta and meta["relation"] == "equal_at_final_step_in_declared_scope" and meta["comparison_scope"]["name"] == ECONOMIC_SCOPE["name"]:
            classes.setdefault(meta["equivalence_class"], []).append(trace)
    for name, members in classes.items():
        if len(members) < 2:
            continue
        projections = [economic_projection(item["actions"][-1]["expected_state_after"]) for item in members]
        if any(value != projections[0] for value in projections[1:]):
            raise AssertionError(f"metamorphic class diverged: {name}")

    rows = {
        trace["metamorphic"]["phase_a_matrix_row"]
        for trace in traces
        if trace.get("metamorphic")
    }
    required_rows = {
        "M01_transaction_order", "M02_cumulative_funding", "M03_log_order",
        "M04_stable_identifier_order", "M05_batch_grouping", "M11_explicit_retry_timing",
        "M12_default_timing", "M13_default_memory", "M14_closedAt_timing",
        "M15_uncovered_fields", "M16_early_late_classification",
        "M08_repayment_delivery", "M09_repayment_splitting", "M10_overpayment",
    }
    # M06 and M07 are retained as provenance links on M05/M11 traces.
    if not required_rows <= rows:
        raise AssertionError(f"missing representable matrix rows: {sorted(required_rows - rows)}")


def build_corpus() -> Dict[str, Any]:
    traces: List[Dict[str, Any]] = []
    add_independently_derived_metamorphic(traces)
    add_two_phase_and_order(traces)
    add_classification(traces)
    add_accounting_and_metamorphic(traces)
    add_named_errors(traces)
    add_spec_prescribed_mandatory(traces)
    traces = deduplicate(traces)
    traces.sort(key=lambda item: (item["category_order"], item["trace_id"]))
    validate(traces)

    provenance_counts: Dict[str, int] = {}
    category_counts: Dict[str, int] = {}
    for trace in traces:
        provenance_counts[trace["provenance_class"]] = provenance_counts.get(trace["provenance_class"], 0) + 1
        category_counts[trace["category"]] = category_counts.get(trace["category"], 0) + 1

    return {
        "schema": "cr3dx.phase_b0.expectation_corpus.v1",
        "specification": {
            "version": "v0.4.8",
            "provenance": "cbc382b39fabd9a34b218fe6ff35699e18bdca4a",
            "normative_package_sha256": "c8119bb3b8aba49348bc467ccb085bf4ad4afc98781463e3c644d091b12c7b80",
            "phase_a_payload_snapshot": "c79858076b9323d9aeb0344b50bd3a4ac7845397411559f3a49f6b8864628546",
            "phase_a_manifest_sha256": "74337c98d1deff88bdc54bf3b7627f4c7cafb11f1a0350f39728be60b91ad851",
        },
        "blind_boundary": "No Cr3dXDeals or Cr3dXCredit implementation material was inspected; corpus derived only from frozen Phase A oracle artifacts.",
        "symbolic_handle_policy": {
            "actors": sorted(key for key in ACTORS if key != "DEALS_RUNTIME"),
            "deal_pattern": "D<number>",
            "evidence_pattern": "E<number>",
            "raw_runtime_identifiers_are_expectations": False,
        },
        "semantic_action_dto": {
            "set_attested_height": "Set the model-visible attested source height.",
            "create_deal": "Create immutable deal terms and bind a symbolic deal handle.",
            "submit_single": "Verify one semantic source transaction, extract relevant events, then optionally apply only newly created evidence in funding/repayment phases.",
            "submit_batch": "Atomically verify/extract an ordered transaction list, then optionally apply only newly created evidence in two stable phases.",
            "apply_evidence": "Explicitly classify or re-evaluate one stored symbolic evidence item.",
            "mark_defaulted": "Permissionless default decision using attested source height.",
            "read_evidence": "Read-only lookup used only for the prescribed unknown-evidence oracle.",
        },
        "comparison_scopes": SCOPE_BY_NAME,
        "fixed_seeds": [0, 7, 42],
        "trace_count": len(traces),
        "trace_counts_by_provenance": dict(sorted(provenance_counts.items())),
        "trace_counts_by_category": dict(sorted(category_counts.items())),
        "traces": traces,
    }


def main() -> None:
    corpus = build_corpus()
    payload = json.dumps(corpus, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    OUTPUT.write_text(payload, encoding="utf-8")
    print(json.dumps({
        "output": str(OUTPUT),
        "trace_count": corpus["trace_count"],
        "by_provenance": corpus["trace_counts_by_provenance"],
        "by_category": corpus["trace_counts_by_category"],
        "fixed_seeds": corpus["fixed_seeds"],
    }, sort_keys=True))


if __name__ == "__main__":
    main()
