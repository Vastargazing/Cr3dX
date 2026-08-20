"""Blind executable reference model for Cr3dX specification v0.4.8.

This is a specification model, not an adapter to production contracts.  It models
the post-verification state machine and makes the verifier's success/failure an
explicit generated input.  No production source, ABI, test, or behavior informed
this file.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from enum import Enum, IntEnum
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from Crypto.Hash import keccak


ZERO_ADDRESS = "0x" + "00" * 20


class ModelError(Exception):
    """Base error carrying a stable model oracle tag."""

    tag = "MODEL_ERROR"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.tag)


class VerificationReverted(ModelError):
    tag = "VERIFICATION_REVERTED"


class SourceTransactionFailed(ModelError):
    # Model label: the package requires a named error but does not give its ABI name.
    tag = "SOURCE_TRANSACTION_FAILED"


class NoRelevantEvidence(ModelError):
    tag = "NoRelevantEvidence"


class EvidenceAlreadyRecorded(ModelError):
    tag = "EvidenceAlreadyRecorded"


class UnknownEvidence(ModelError):
    tag = "UnknownEvidence"


class NotDefaultable(ModelError):
    tag = "NotDefaultable"


class InvalidBatchSize(ModelError):
    tag = "INVALID_BATCH_SIZE"


class InvalidDealTerms(ModelError):
    tag = "INVALID_DEAL_TERMS"


class LimitExceeded(ModelError):
    tag = "LIMIT_EXCEEDED"


class Unauthorized(ModelError):
    tag = "UNAUTHORIZED"


class Kind(IntEnum):
    FUNDING = 0
    REPAYMENT = 1


class EvidenceState(Enum):
    VERIFIED_PENDING = "VERIFIED_PENDING"
    APPLIED = "APPLIED"
    REJECTED_PERMANENT = "REJECTED_PERMANENT"


class RejectionReason(Enum):
    NONE = "NONE"
    WRONG_INVESTOR = "WRONG_INVESTOR"
    WRONG_RECIPIENT = "WRONG_RECIPIENT"


class DealStatus(Enum):
    CREATED = "CREATED"
    FINANCED = "FINANCED"
    DEFAULTED = "DEFAULTED"
    PAID_LATE = "PAID_LATE"
    PAID_ON_TIME = "PAID_ON_TIME"


class Result(Enum):
    PAID_ON_TIME = "PAID_ON_TIME"
    PAID_LATE = "PAID_LATE"
    DEFAULTED = "DEFAULTED"


def _word(value: int) -> bytes:
    if value < 0 or value >= 1 << 256:
        raise ValueError("value does not fit an ABI word")
    return value.to_bytes(32, "big")


def _address_word(value: str) -> bytes:
    raw = bytes.fromhex(value.removeprefix("0x"))
    if len(raw) != 20:
        raise ValueError(f"not an address: {value}")
    return b"\x00" * 12 + raw


def _keccak(data: bytes) -> str:
    digest = keccak.new(digest_bits=256)
    digest.update(data)
    return "0x" + digest.hexdigest()


def terms_hash(
    borrower: str,
    designated_investor: str,
    required_funding: int,
    face_value: int,
    due_block: int,
) -> str:
    """keccak256(abi.encode(borrower, investor, funding, face, dueBlock))."""

    return _keccak(
        _address_word(borrower)
        + _address_word(designated_investor)
        + _word(required_funding)
        + _word(face_value)
        + _word(due_block)
    )


def make_deal_id(
    creditcoin_chain_id: int,
    deals_address: str,
    deal_seq: int,
    terms_hash_value: str,
) -> str:
    raw_terms = bytes.fromhex(terms_hash_value.removeprefix("0x"))
    return _keccak(
        _word(creditcoin_chain_id)
        + _address_word(deals_address)
        + _word(deal_seq)
        + raw_terms
    )


def make_evidence_id(
    chain_key: int,
    block_height: int,
    tx_index: int,
    kind: Kind,
    event_nonce: int,
) -> str:
    return _keccak(
        _word(chain_key)
        + _word(block_height)
        + _word(tx_index)
        + _word(int(kind))
        + _word(event_nonce)
    )


@dataclass(frozen=True)
class SourceLog:
    emitter: str
    kind: Optional[Kind]
    deal_id: str
    counterparty: str
    recipient: str
    amount: int
    event_nonce: int


@dataclass(frozen=True)
class SourceTx:
    height: int
    tx_index: int
    verified: bool
    status: int
    logs: Tuple[SourceLog, ...]
    # Deliberately ignored, because neither field is covered by canonical roots.
    uncovered_from: str = ZERO_ADDRESS
    uncovered_gas_used: int = 0


@dataclass
class Evidence:
    evidence_id: str
    kind: Kind
    deal_id: str
    counterparty: str
    recipient: str
    amount: int
    block_height: int
    tx_index: int
    event_nonce: int
    state: EvidenceState = EvidenceState.VERIFIED_PENDING
    rejection_reason: RejectionReason = RejectionReason.NONE


@dataclass
class Deal:
    deal_id: str
    deal_seq: int
    borrower: str
    designated_investor: str
    required_funding: int
    face_value: int
    due_block: int
    terms_hash: str
    investor: Optional[str] = None
    funded_amount: int = 0
    repaid_amount: int = 0
    on_time_repaid: int = 0
    status: DealStatus = DealStatus.CREATED

    @property
    def outstanding(self) -> int:
        return max(self.face_value - self.repaid_amount, 0)


@dataclass
class CreditOutcome:
    result: Result
    closed_at_block: int


@dataclass
class BorrowerCredit:
    reserved: int = 0
    exposure: int = 0
    paid_on_time: int = 0
    paid_late: int = 0
    defaulted: int = 0


class VerifierModel:
    """Immutable verified-fact store with atomic submissions."""

    def __init__(self, chain_key: int, gateway_address: str) -> None:
        self.chain_key = chain_key
        self.gateway_address = gateway_address.lower()
        self.evidence: Dict[str, Evidence] = {}
        self.trace: List[Tuple[str, int]] = []

    def seen(self, evidence_id: str) -> bool:
        return evidence_id in self.evidence

    def get_evidence(self, evidence_id: str) -> Evidence:
        if evidence_id not in self.evidence:
            raise UnknownEvidence()
        return self.evidence[evidence_id]

    def evidence_id_of(
        self, height: int, tx_index: int, kind: Kind, event_nonce: int
    ) -> str:
        return make_evidence_id(
            self.chain_key, height, tx_index, kind, event_nonce
        )

    def submit_evidence(self, tx: SourceTx) -> List[str]:
        return self.submit_evidence_batch([tx])

    def submit_evidence_batch(self, txs: Sequence[SourceTx]) -> List[str]:
        if not 1 <= len(txs) <= 10:
            raise InvalidBatchSize()

        staged: List[Evidence] = []
        staged_ids: set[str] = set()
        staged_trace: List[Tuple[str, int]] = []

        for tx in txs:
            staged_trace.append(("verify", tx.height))
            if not tx.verified:
                raise VerificationReverted()

            # This trace point is deliberately unreachable before successful verify.
            staged_trace.append(("calculateTxIndex", tx.height))
            tx_index = tx.tx_index

            if tx.status != 1:
                raise SourceTransactionFailed()

            tx_evidence: List[Evidence] = []
            for log in tx.logs:
                if log.emitter.lower() != self.gateway_address or log.kind is None:
                    continue
                evidence_id = make_evidence_id(
                    self.chain_key,
                    tx.height,
                    tx_index,
                    log.kind,
                    log.event_nonce,
                )
                if evidence_id in self.evidence or evidence_id in staged_ids:
                    raise EvidenceAlreadyRecorded()
                staged_ids.add(evidence_id)
                tx_evidence.append(
                    Evidence(
                        evidence_id=evidence_id,
                        kind=log.kind,
                        deal_id=log.deal_id,
                        counterparty=log.counterparty,
                        recipient=log.recipient,
                        amount=log.amount,
                        block_height=tx.height,
                        tx_index=tx_index,
                        event_nonce=log.event_nonce,
                    )
                )

            if not tx_evidence:
                raise NoRelevantEvidence()
            staged.extend(tx_evidence)

        # Commit only after every transaction, log, and duplicate check succeeds.
        self.trace.extend(staged_trace)
        for item in staged:
            self.evidence[item.evidence_id] = item
        return [item.evidence_id for item in staged]


class Cr3dXModel:
    """Reference state machine for Deals + Credit and their verifier boundary."""

    BASE_SCORE = 500
    MIN_SCORE = 300
    MAX_SCORE = 850

    def __init__(
        self,
        *,
        creditcoin_chain_id: int,
        deals_address: str,
        gateway_address: str,
        chain_key: int = 1,
        base_limit: int = 5_000_000_000,
        attestation_grace_period: int = 600,
    ) -> None:
        self.creditcoin_chain_id = creditcoin_chain_id
        self.deals_address = deals_address
        self.base_limit = base_limit
        self.attestation_grace_period = attestation_grace_period
        self.attested_height = 0
        self.verifier = VerifierModel(chain_key, gateway_address)
        self.deals: Dict[str, Deal] = {}
        self.deal_order: Dict[str, List[str]] = {}
        self.outcomes: Dict[str, CreditOutcome] = {}
        self.credit: Dict[str, BorrowerCredit] = {}
        self.deal_seq = 0

    def clone(self) -> "Cr3dXModel":
        return deepcopy(self)

    def set_attested_height(self, height: int) -> None:
        if height < self.attested_height:
            raise ValueError("attested source height is monotone in this model")
        self.attested_height = height

    def _account(self, borrower: str) -> BorrowerCredit:
        return self.credit.setdefault(borrower, BorrowerCredit())

    def score_of(self, borrower: str) -> int:
        account = self._account(borrower)
        raw = (
            self.BASE_SCORE
            + 25 * account.paid_on_time
            - 50 * account.paid_late
            - 200 * account.defaulted
        )
        return min(self.MAX_SCORE, max(self.MIN_SCORE, raw))

    def limit_of(self, borrower: str) -> int:
        return self.base_limit * self.score_of(borrower) // self.BASE_SCORE

    def used_of(self, borrower: str) -> int:
        account = self._account(borrower)
        return account.reserved + account.exposure

    def available_limit_of(self, borrower: str) -> int:
        used = self.used_of(borrower)
        limit = self.limit_of(borrower)
        return 0 if used >= limit else limit - used

    def reserved_of(self, borrower: str) -> int:
        return self._account(borrower).reserved

    def exposure_of(self, borrower: str) -> int:
        return self._account(borrower).exposure

    def create_deal(
        self,
        *,
        borrower: str,
        designated_investor: str,
        required_funding: int,
        face_value: int,
        due_block: int,
    ) -> str:
        if not (0 < required_funding <= face_value):
            raise InvalidDealTerms()
        if face_value > self.available_limit_of(borrower):
            raise LimitExceeded()

        seq = self.deal_seq
        digest = terms_hash(
            borrower,
            designated_investor,
            required_funding,
            face_value,
            due_block,
        )
        deal_id = make_deal_id(
            self.creditcoin_chain_id, self.deals_address, seq, digest
        )
        self.deal_seq += 1
        self.deals[deal_id] = Deal(
            deal_id=deal_id,
            deal_seq=seq,
            borrower=borrower,
            designated_investor=designated_investor,
            required_funding=required_funding,
            face_value=face_value,
            due_block=due_block,
            terms_hash=digest,
        )
        self.deal_order.setdefault(borrower, []).append(deal_id)
        self._account(borrower).reserved += face_value
        return deal_id

    def _counter_delta(self, borrower: str, result: Result, delta: int) -> None:
        account = self._account(borrower)
        field = {
            Result.PAID_ON_TIME: "paid_on_time",
            Result.PAID_LATE: "paid_late",
            Result.DEFAULTED: "defaulted",
        }[result]
        setattr(account, field, getattr(account, field) + delta)

    def _write_outcome(self, deal: Deal, result: Result) -> bool:
        previous = self.outcomes.get(deal.deal_id)
        if previous is not None and previous.result == result:
            return False
        if previous is not None:
            self._counter_delta(deal.borrower, previous.result, -1)
        self._counter_delta(deal.borrower, result, 1)
        self.outcomes[deal.deal_id] = CreditOutcome(result, self.attested_height)
        deal.status = DealStatus(result.value)
        return True

    def canonical_result(self, deal_id: str) -> Optional[Result]:
        deal = self.deals[deal_id]
        if deal.on_time_repaid >= deal.face_value:
            return Result.PAID_ON_TIME
        if deal.repaid_amount >= deal.face_value:
            return Result.PAID_LATE
        current = self.outcomes.get(deal_id)
        if current is not None and current.result == Result.DEFAULTED:
            return Result.DEFAULTED
        return None

    def _recompute_outcome(self, deal: Deal) -> None:
        result = self.canonical_result(deal.deal_id)
        if result is not None:
            self._write_outcome(deal, result)

    def mark_defaulted(self, deal_id: str) -> None:
        deal = self.deals.get(deal_id)
        if (
            deal is None
            or deal.status != DealStatus.FINANCED
            or self.attested_height
            <= deal.due_block + self.attestation_grace_period
        ):
            raise NotDefaultable()
        self._write_outcome(deal, Result.DEFAULTED)

    def apply_evidence(
        self, evidence_id: str
    ) -> Tuple[EvidenceState, RejectionReason]:
        evidence = self.verifier.get_evidence(evidence_id)
        if evidence.state in (
            EvidenceState.APPLIED,
            EvidenceState.REJECTED_PERMANENT,
        ):
            return evidence.state, evidence.rejection_reason

        deal = self.deals.get(evidence.deal_id)
        if deal is None:
            return evidence.state, evidence.rejection_reason

        if evidence.kind == Kind.FUNDING:
            if evidence.recipient.lower() != deal.borrower.lower():
                evidence.state = EvidenceState.REJECTED_PERMANENT
                evidence.rejection_reason = RejectionReason.WRONG_RECIPIENT
                return evidence.state, evidence.rejection_reason
            if evidence.counterparty.lower() != deal.designated_investor.lower():
                evidence.state = EvidenceState.REJECTED_PERMANENT
                evidence.rejection_reason = RejectionReason.WRONG_INVESTOR
                return evidence.state, evidence.rejection_reason

            before = deal.funded_amount
            deal.funded_amount += evidence.amount
            if before < deal.required_funding <= deal.funded_amount:
                deal.status = DealStatus.FINANCED
                deal.investor = deal.designated_investor
                account = self._account(deal.borrower)
                account.reserved -= deal.face_value
                account.exposure += deal.face_value
            evidence.state = EvidenceState.APPLIED
            return evidence.state, evidence.rejection_reason

        # Recipient is checked before the potentially temporary funding precondition.
        if evidence.recipient.lower() != deal.designated_investor.lower():
            evidence.state = EvidenceState.REJECTED_PERMANENT
            evidence.rejection_reason = RejectionReason.WRONG_RECIPIENT
            return evidence.state, evidence.rejection_reason
        if deal.status == DealStatus.CREATED:
            return evidence.state, evidence.rejection_reason

        old_outstanding = deal.outstanding
        deal.repaid_amount += evidence.amount
        if evidence.block_height <= deal.due_block:
            deal.on_time_repaid += evidence.amount
        new_outstanding = deal.outstanding
        account = self._account(deal.borrower)
        account.exposure -= old_outstanding - new_outstanding
        evidence.state = EvidenceState.APPLIED
        self._recompute_outcome(deal)
        return evidence.state, evidence.rejection_reason

    def submit_and_apply(self, tx: SourceTx) -> List[str]:
        return self.submit_and_apply_batch([tx])

    def submit_and_apply_batch(self, txs: Sequence[SourceTx]) -> List[str]:
        ids = self.verifier.submit_evidence_batch(txs)
        for kind in (Kind.FUNDING, Kind.REPAYMENT):
            for evidence_id in ids:
                if self.verifier.evidence[evidence_id].kind == kind:
                    self.apply_evidence(evidence_id)
        return ids

    def full_recount_counters(self, borrower: str) -> Tuple[int, int, int]:
        counts = {result: 0 for result in Result}
        for deal_id in self.deal_order.get(borrower, []):
            outcome = self.outcomes.get(deal_id)
            if outcome is not None:
                counts[outcome.result] += 1
        return (
            counts[Result.PAID_ON_TIME],
            counts[Result.PAID_LATE],
            counts[Result.DEFAULTED],
        )

    def recomputed_score(self, borrower: str) -> int:
        on_time, late, defaulted = self.full_recount_counters(borrower)
        raw = self.BASE_SCORE + 25 * on_time - 50 * late - 200 * defaulted
        return min(self.MAX_SCORE, max(self.MIN_SCORE, raw))

    def recomputed_exposure(self, borrower: str) -> int:
        return sum(
            deal.outstanding
            for deal in self.deals.values()
            if deal.borrower == borrower
            and deal.status in (DealStatus.FINANCED, DealStatus.DEFAULTED)
        )

    def economic_state(self) -> Tuple[Tuple[object, ...], ...]:
        """One shared INV-3/INV-20 economic projection.

        Evidence state and closedAtBlock are intentionally excluded.
        """

        deal_rows: List[Tuple[object, ...]] = []
        for deal_id, deal in sorted(self.deals.items()):
            outcome = self.outcomes.get(deal_id)
            deal_rows.append(
                (
                    "deal",
                    deal_id,
                    deal.status.value,
                    deal.funded_amount,
                    deal.repaid_amount,
                    deal.on_time_repaid,
                    deal.outstanding,
                    outcome.result.value if outcome else None,
                )
            )
        borrower_rows: List[Tuple[object, ...]] = []
        for borrower in sorted(self.credit):
            borrower_rows.append(
                (
                    "borrower",
                    borrower,
                    self.reserved_of(borrower),
                    self.exposure_of(borrower),
                    self.score_of(borrower),
                )
            )
        return tuple(deal_rows + borrower_rows)

    def assert_internal_invariants(self) -> None:
        for borrower, account in self.credit.items():
            assert account.reserved >= 0
            assert account.exposure >= 0
            assert account.exposure == self.recomputed_exposure(borrower)
            assert self.score_of(borrower) == self.recomputed_score(borrower)

        for deal_id, deal in self.deals.items():
            assert deal.outstanding >= 0
            outcome = self.outcomes.get(deal_id)
            if outcome is not None:
                assert deal.status.value == outcome.result.value
                assert self.canonical_result(deal_id) == outcome.result
            else:
                assert deal.status in (DealStatus.CREATED, DealStatus.FINANCED)

    # A model witness for the absence of any administrative mutation surface.
    def administrative_mutation(self, *_: object, **__: object) -> None:
        raise Unauthorized()


def permutations_of(items: Sequence[object]) -> Iterable[Tuple[object, ...]]:
    """Local import keeps the public harness dependency surface small."""

    from itertools import permutations

    return permutations(items)
