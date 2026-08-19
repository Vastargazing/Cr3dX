// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Cr3dXCredit, Result} from "./Cr3dXCredit.sol";
import {Cr3dXVerifier} from "./Cr3dXVerifier.sol";
import {IBlockProver} from "./interfaces/IBlockProver.sol";
import {IChainInfo} from "./interfaces/IChainInfo.sol";
import {Attestcoin} from "./libraries/Attestcoin.sol";

/// @title Cr3dXDeals
/// @notice The canonical state of every credit relationship in Cr3dX, and the
///         only place where a proven source-chain fact acquires meaning.
///
/// @dev **The division of labour.** `Cr3dXVerifier` answers *what happened on
///      Sepolia*. This contract answers *what that means here*. The verifier
///      records immutable facts and knows nothing about deals; this contract
///      decides whether a fact is applicable, still waiting, or inapplicable
///      forever. The dependency runs one way: this contract holds the verifier's
///      address and reads from it, and the verifier never calls back. That is
///      what lets both be deployed without an initialiser that some privileged
///      address is entitled to call.
///
///      **Three things this contract deliberately cannot do.**
///
///      1. *Cancel a deal.* A created deal can accept funding forever. A cancel
///         function would let a borrower create a deal, cancel it after the
///         investor's money is already in flight on the source chain, and leave
///         a proven payment matched to nothing. Money that really moved would be
///         destroyed by a state change on the other chain.
///      2. *Release a reserve.* The reserve leaves only by becoming exposure,
///         once, when funding crosses the threshold. Any other release lets a
///         borrower open a deal, free its reserve, open a second deal against
///         the same limit, and then present the proof of the first deal's
///         funding. One limit would have secured two deals. Safe release needs
///         the ability to forbid funding on the source chain, which is the
///         protocol's outbound direction and does not exist yet.
///      3. *Anything administrative.* No owner, no pause, no override. INV-7 is
///         not a promise about restraint; there is no function to restrain.
///
///      Their absence is the product, not a gap in it.
///
///      **Funding from the designated investor is never refused.** Not for a
///      limit, not for a deadline, not because `dueBlock` has passed, not
///      because the amount is short of `requiredFunding`, and not because the
///      threshold has already been crossed. Every one of those checks looks like
///      diligence and every one of them destroys money that has already moved:
///      the payment happened on Sepolia and cannot be undone from here. Funding
///      accumulates without a ceiling.
///
///      What happens once is not the payment but the crossing. The reserve turns
///      into exposure at the instant the total first reaches the threshold, and
///      never again, so a deal cannot be financed twice however many payments
///      arrive.
///
///      **Order of delivery does not change the result.** Proofs arrive in
///      whatever order a worker manages to build them, which has nothing to do
///      with the order the payments happened in. So the outcome of a deal is
///      recomputed from the accumulated totals after every applied repayment
///      rather than latched by whichever repayment happened to cross the
///      threshold first. A late repayment delivered before an on-time one gives
///      the same final state as the reverse. See INV-20.
contract Cr3dXDeals {
    /// @notice Where a deal stands. `NONE` means no such deal.
    enum DealStatus {
        NONE,
        CREATED,
        FINANCED,
        DEFAULTED,
        PAID_LATE,
        PAID_ON_TIME
    }

    /// @notice Where a piece of evidence stands with respect to this registry.
    /// @dev `UNSEEN` means the verifier has no such fact. `VERIFIED_PENDING`
    ///      means the fact exists and could still become applicable. Neither is
    ///      stored: both are derived, so a proof that is waiting costs no
    ///      storage at all.
    enum EvidenceState {
        UNSEEN,
        VERIFIED_PENDING,
        APPLIED,
        REJECTED_PERMANENT
    }

    /// @notice Why a piece of evidence can never become applicable.
    ///
    /// @dev Exactly two, and both are a mismatch against a field that cannot
    ///      change: the designated investor and the recipient the deal's own
    ///      terms imply. A third may not be added quietly. The test is general:
    ///      a rejection is permanent if and only if no reachable future state of
    ///      the system would make the evidence applicable. Anything that merely
    ///      has not happened yet - the deal does not exist, the deal is not
    ///      financed - stays pending, because it can still happen.
    ///
    ///      There used to be a third, `ALREADY_FUNDED`, for funding that arrived
    ///      after the threshold was crossed. It made the funded total depend on
    ///      the order the proofs arrived in, which is what INV-3 forbids. Three
    ///      payments of 60, 50 and 40 against a threshold of 100 settle on 110,
    ///      150 or 100 depending only on which proof was built first, and every
    ///      one of those numbers describes money that really moved. See the note
    ///      on `_applyFunding`.
    enum RejectionReason {
        NONE,
        WRONG_INVESTOR,
        WRONG_RECIPIENT
    }

    /// @notice One credit relationship.
    ///
    /// @param borrower Who owes. Set at creation from `msg.sender`, immutable.
    /// @param dueBlock Source chain height by which repayment counts as on time.
    ///        A source height, never a Creditcoin one.
    /// @param status Where the deal stands.
    /// @param designatedInvestor The only account whose funding this deal
    ///        accepts. Immutable, which is why funding from anyone else is
    ///        rejected permanently rather than left pending.
    /// @param dealSeq Position in this registry's creation order, part of the
    ///        deal identifier.
    /// @param investor Who actually paid, recorded at the crossing. Zero until
    ///        then. Nothing in this contract reads it: repayment is checked
    ///        against `designatedInvestor`, which is known from creation, and
    ///        the two are provably the same address because funding is only
    ///        applied from the designated one. It is kept as the audit record of
    ///        the crossing, not as an input to any decision.
    /// @param requiredFunding Amount that must arrive before the deal is financed.
    /// @param fundedAmount Total proven funding applied so far.
    /// @param faceValue Amount owed back. Reserved against the limit at creation.
    /// @param repaidAmount Total proven repayment applied so far, uncapped.
    /// @param onTimeRepaid The part of it proven at or below `dueBlock`, uncapped.
    struct Deal {
        // slot 0: 20 + 8 + 1 = 29 bytes
        address borrower;
        uint64 dueBlock;
        DealStatus status;
        // slot 1: 20 + 12 = 32 bytes
        address designatedInvestor;
        uint96 dealSeq;
        // slot 2
        address investor;
        // slots 3 to 7
        uint256 requiredFunding;
        uint256 fundedAmount;
        uint256 faceValue;
        uint256 repaidAmount;
        uint256 onTimeRepaid;
    }

    /// @dev What this registry decided about a piece of evidence. Written only
    ///      for the two terminal outcomes; a pending proof leaves no trace.
    struct Application {
        EvidenceState state;
        RejectionReason reason;
    }

    /// @notice The only source of external facts this registry trusts.
    Cr3dXVerifier public immutable verifier;

    /// @notice The credit layer this registry writes to. Deployed by this contract.
    Cr3dXCredit public immutable credit;

    /// @notice Creditcoin's internal identifier for the source chain.
    /// @dev Read from the verifier rather than passed in again, so the two
    ///      cannot be deployed against different source chains.
    uint64 public immutable chainKey;

    /// @notice Slack, in source blocks, before a missed `dueBlock` becomes a default.
    ///
    /// @dev Sized against the largest jump the attested height can make in one
    ///      Creditcoin block, not against the lag observed on a quiet day: when
    ///      the attestor set catches up it can advance by `MaxCatchup` at once.
    ///
    ///      This constant prevents cosmetic false defaults. It does not carry
    ///      correctness. Correctness comes from counting timeliness by source
    ///      block height: a deal that did reach `DEFAULTED` still becomes
    ///      `PAID_ON_TIME` when the proof of an on-time payment arrives later.
    ///      If correctness rested on the grace period, one catch-up jump would
    ///      break it.
    uint64 public immutable attestationGracePeriod;

    /// @dev Creation counter. `uint96` so that it packs alongside the designated
    ///      investor; it is widened to a full word before it enters the deal
    ///      identifier, so the hash is unambiguous.
    uint96 private _nextDealSeq;

    mapping(bytes32 => Deal) private _deals;
    mapping(bytes32 => Application) private _applications;

    /// @notice `requiredFunding` was zero or exceeded `faceValue`.
    error InvalidTerms(uint256 requiredFunding, uint256 faceValue);
    /// @notice The verifier holds no fact under this identifier.
    error UnknownEvidence(bytes32 evidenceId);
    /// @notice The deal is not in `FINANCED`, so it cannot default.
    error NotDefaultable(bytes32 dealId, DealStatus status);
    /// @notice The attested source height has not passed `dueBlock` plus grace.
    error DefaultTooEarly(bytes32 dealId, uint64 attestedHeight, uint256 threshold);
    /// @notice The source chain has no attested height yet.
    error NoAttestedHeight(uint64 chainKey);

    /// @notice A deal was created and its face value reserved.
    event DealCreated(
        bytes32 indexed dealId,
        address indexed borrower,
        address indexed designatedInvestor,
        uint256 requiredFunding,
        uint256 faceValue,
        uint64 dueBlock,
        uint96 dealSeq
    );
    /// @notice Proven funding was added to a deal.
    event FundingApplied(bytes32 indexed dealId, bytes32 indexed evidenceId, uint256 amount, uint256 fundedAmount);
    /// @notice Funding crossed `requiredFunding`; the investor is now fixed.
    event DealFinanced(bytes32 indexed dealId, address indexed investor, uint256 fundedAmount);
    /// @notice Proven repayment was added to a deal.
    event RepaymentApplied(
        bytes32 indexed dealId,
        bytes32 indexed evidenceId,
        uint256 amount,
        uint256 repaidAmount,
        uint256 onTimeRepaid
    );
    /// @notice A financed deal passed its deadline plus grace without closing.
    event DealDefaulted(bytes32 indexed dealId, uint64 attestedHeight);
    /// @notice The deal's status settled on a closed value, or was refined upward.
    event DealSettled(bytes32 indexed dealId, DealStatus status);
    /// @notice A proven fact can never apply to this deal.
    event EvidenceRejected(bytes32 indexed evidenceId, bytes32 indexed dealId, RejectionReason reason);

    /// @param verifier_ The deployed `Cr3dXVerifier`.
    /// @param attestationGracePeriod_ Slack in source blocks before a default.
    /// @param baseLimit_ Credit line at the base score, in native token units.
    /// @dev The credit layer is constructed here rather than passed in. The two
    ///      contracts need each other's addresses, and the alternative to
    ///      constructing one from the other is an initialiser somebody is
    ///      entitled to call. That entitlement is exactly what INV-7 denies.
    constructor(Cr3dXVerifier verifier_, uint64 attestationGracePeriod_, uint256 baseLimit_) {
        verifier = verifier_;
        chainKey = verifier_.chainKey();
        attestationGracePeriod = attestationGracePeriod_;
        credit = new Cr3dXCredit(baseLimit_, chainKey);
    }

    // ------------------------------------------------------------------
    // deals
    // ------------------------------------------------------------------

    /// @notice Opens a deal against the caller's credit limit.
    ///
    /// @dev The caller is the borrower; there is no way to open a deal on
    ///      somebody else's limit. `faceValue` is reserved immediately, and the
    ///      reserve is what makes the limit real: it is held whether or not the
    ///      investor ever funds, and there is no path that returns it except
    ///      funding.
    ///
    ///      A `dueBlock` in the past is allowed. So is a designated investor who
    ///      never funds. Neither is a mistake this contract is entitled to
    ///      diagnose, and both cost only the borrower's own limit.
    ///
    /// @param designatedInvestor The only account whose funding this deal accepts.
    /// @param requiredFunding Amount that finances the deal, in native token units.
    /// @param faceValue Amount owed back, in native token units.
    /// @param dueBlock Source chain height up to which repayment counts as on time.
    /// @return dealId Identifier to be quoted at the gateway when paying.
    function createDeal(address designatedInvestor, uint256 requiredFunding, uint256 faceValue, uint64 dueBlock)
        external
        returns (bytes32 dealId)
    {
        if (requiredFunding == 0 || requiredFunding > faceValue) {
            revert InvalidTerms(requiredFunding, faceValue);
        }

        uint96 dealSeq = _nextDealSeq;
        _nextDealSeq = dealSeq + 1;

        dealId = dealIdOf(msg.sender, designatedInvestor, requiredFunding, faceValue, dueBlock, dealSeq);

        Deal storage deal = _deals[dealId];
        deal.borrower = msg.sender;
        deal.dueBlock = dueBlock;
        deal.status = DealStatus.CREATED;
        deal.designatedInvestor = designatedInvestor;
        deal.dealSeq = dealSeq;
        deal.requiredFunding = requiredFunding;
        deal.faceValue = faceValue;

        // Reserves the face value and enforces the limit. INV-10 lives there.
        credit.openDeal(dealId, msg.sender, faceValue);

        emit DealCreated(dealId, msg.sender, designatedInvestor, requiredFunding, faceValue, dueBlock, dealSeq);
    }

    /// @notice Declares a financed deal in default on the strength of the
    ///         attested source height. Callable by anyone.
    ///
    /// @dev Permissionless because a default is a fact about elapsed source
    ///      time, not a decision anyone is entitled to make. Whoever calls this
    ///      pays the gas and gets nothing for it, which is the correct incentive
    ///      shape: the investor cares, and there is no one to bribe.
    ///
    ///      Only from `FINANCED`. Not from `CREATED`, because a deal nobody
    ///      funded owes nobody anything. Not from a closed status, however far
    ///      the attested height has run: a paid deal does not become unpaid.
    ///
    ///      Default does not release exposure. The debt still exists; only the
    ///      chance of collecting it changed, and exposure measures debt.
    function markDefaulted(bytes32 dealId) external {
        Deal storage deal = _deals[dealId];
        DealStatus status = deal.status;
        if (status != DealStatus.FINANCED) revert NotDefaultable(dealId, status);

        uint64 attested = attestedSourceHeight();
        // Widened, because `dueBlock` near the top of its range plus the grace
        // period would otherwise wrap and declare an instant default.
        uint256 threshold = uint256(deal.dueBlock) + uint256(attestationGracePeriod);
        if (uint256(attested) <= threshold) revert DefaultTooEarly(dealId, attested, threshold);

        deal.status = DealStatus.DEFAULTED;
        credit.recordOutcome(dealId, Result.DEFAULTED);

        emit DealDefaulted(dealId, attested);
        emit DealSettled(dealId, DealStatus.DEFAULTED);
    }

    // ------------------------------------------------------------------
    // evidence
    // ------------------------------------------------------------------

    /// @notice Proves one source transaction and applies everything it produced.
    ///
    /// @dev The one-transaction path, and the ordinary way facts enter Cr3dX.
    ///      The verifier hands back the identifiers it just created, so this
    ///      contract can apply them immediately without the verifier knowing
    ///      that a registry exists.
    ///
    ///      Submitting straight to the verifier stays open to anyone, and
    ///      `applyEvidence` picks such facts up afterwards. Nothing here is a
    ///      privileged channel.
    ///
    /// @return ids Identifiers created by this submission, in log order.
    function submitAndApply(
        uint64 height,
        bytes calldata encodedTx,
        IBlockProver.MerkleProof calldata merkleProof,
        IBlockProver.ContinuityProof calldata continuityProof
    ) external returns (bytes32[] memory ids) {
        ids = verifier.submitEvidence(height, encodedTx, merkleProof, continuityProof);
        for (uint256 i = 0; i < ids.length; i++) {
            _apply(ids[i]);
        }
    }

    /// @notice The same, for up to ten transactions under one continuity proof.
    /// @dev The continuity proof is the expensive part of a submission, so
    ///      batching is where the gas is. The precompile's ceiling is ten.
    function submitAndApplyBatch(
        uint64[] calldata heights,
        bytes[] calldata encodedTxs,
        IBlockProver.MerkleProof[] calldata merkleProofs,
        IBlockProver.ContinuityProof calldata sharedContinuityProof
    ) external returns (bytes32[] memory ids) {
        ids = verifier.submitEvidenceBatch(heights, encodedTxs, merkleProofs, sharedContinuityProof);
        for (uint256 i = 0; i < ids.length; i++) {
            _apply(ids[i]);
        }
    }

    /// @notice Retries a verified fact that could not be applied when it arrived.
    ///
    /// @dev Permissionless, and idempotent by design. A repayment proven before
    ///      its deal was funded is not an error and must not revert; it waits
    ///      until the funding fixes the investor, and this is how it is driven
    ///      the rest of the way afterwards. Calling it on a fact that is already
    ///      applied or already rejected returns the state it is in and changes
    ///      nothing, so a worker that retries costs gas and nothing else.
    ///
    ///      The single reverting case is a fact the verifier never recorded.
    ///      Answering "pending" there would be a lie: an unverified identifier
    ///      is not waiting for anything, it does not exist.
    function applyEvidence(bytes32 evidenceId) external returns (EvidenceState state, RejectionReason reason) {
        state = _apply(evidenceId);
        reason = _applications[evidenceId].reason;
    }

    // ------------------------------------------------------------------
    // reads
    // ------------------------------------------------------------------

    /// @notice The identifier a deal with these terms would have.
    /// @dev Every component is widened to a full word before hashing, so the
    ///      encoding is reproducible without knowing which Solidity type each
    ///      field happens to have here. `address(this)` and the chain id are in
    ///      the preimage so that a proof aimed at one deployment of this
    ///      registry cannot be replayed against another.
    function dealIdOf(
        address borrower,
        address designatedInvestor,
        uint256 requiredFunding,
        uint256 faceValue,
        uint64 dueBlock,
        uint96 dealSeq
    ) public view returns (bytes32) {
        bytes32 termsHash = keccak256(
            abi.encode(borrower, designatedInvestor, requiredFunding, faceValue, uint256(dueBlock))
        );
        return keccak256(abi.encode(block.chainid, address(this), uint256(dealSeq), termsHash));
    }

    /// @notice One deal, as a struct.
    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return _deals[dealId];
    }

    /// @notice Whether a deal exists.
    function dealExists(bytes32 dealId) external view returns (bool) {
        return _deals[dealId].status != DealStatus.NONE;
    }

    /// @notice How many deals this registry has created.
    function dealCount() external view returns (uint256) {
        return _nextDealSeq;
    }

    /// @notice Debt still outstanding on a deal, floored at zero.
    /// @dev Overpayment does not push it negative and does not release exposure
    ///      a second time.
    function outstandingOf(bytes32 dealId) public view returns (uint256) {
        Deal storage deal = _deals[dealId];
        return _satSub(deal.faceValue, deal.repaidAmount);
    }

    /// @notice Where a piece of evidence stands.
    /// @dev `VERIFIED_PENDING` is derived rather than stored: if this registry
    ///      wrote nothing about a fact the verifier does hold, the fact is
    ///      waiting. That keeps a pending proof free of storage cost, which
    ///      matters because a proof can wait indefinitely.
    function evidenceStateOf(bytes32 evidenceId)
        external
        view
        returns (EvidenceState state, RejectionReason reason)
    {
        Application memory application = _applications[evidenceId];
        if (application.state != EvidenceState.UNSEEN) return (application.state, application.reason);
        if (verifier.seen(evidenceId)) return (EvidenceState.VERIFIED_PENDING, RejectionReason.NONE);
        return (EvidenceState.UNSEEN, RejectionReason.NONE);
    }

    /// @notice Highest attested source height, read from the ChainInfo precompile.
    /// @dev The only clock this contract may consult about the source chain.
    ///      Creditcoin's own `block.number` and `block.timestamp` say nothing
    ///      about Sepolia and appear nowhere in any deadline decision.
    function attestedSourceHeight() public view returns (uint64) {
        IChainInfo.HeightHashResult memory result =
            Attestcoin.CHAIN_INFO.get_latest_attestation_height_and_hash(chainKey);
        if (!result.exists) revert NoAttestedHeight(chainKey);
        return result.height;
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /// @dev Applies one verified fact, or leaves it waiting, or rejects it forever.
    function _apply(bytes32 evidenceId) private returns (EvidenceState) {
        Application memory application = _applications[evidenceId];
        // Terminal either way. INV-2: one identifier is counted at most once.
        if (application.state != EvidenceState.UNSEEN) return application.state;

        Cr3dXVerifier.VerifiedEvidence memory evidence = verifier.getEvidence(evidenceId);
        if (!evidence.recorded) revert UnknownEvidence(evidenceId);

        if (evidence.kind == Cr3dXVerifier.EvidenceKind.FUNDING) {
            return _applyFunding(evidenceId, evidence);
        }
        return _applyRepayment(evidenceId, evidence);
    }

    /// @dev Funding.
    ///
    ///      **Funding from the designated investor is always applied.** Not only
    ///      while the deal is short of its threshold: afterwards too. Refusing a
    ///      payment because the threshold was already crossed sounds like the
    ///      obvious guard against financing a deal twice, and it is instead a
    ///      way of making the funded total depend on which proof a worker
    ///      happened to build first. Payments of 60, 50 and 40 against a
    ///      threshold of 100 land on 110, 150 or 100 across the six delivery
    ///      orders, and all three of those numbers are wrong in the same way:
    ///      the money moved, so the total has to count it. That is INV-3.
    ///
    ///      What must not happen twice is not the payment, it is the crossing.
    ///      The reserve becomes exposure at the instant the total first reaches
    ///      the threshold, and the guard below is written as exactly that
    ///      instant rather than as a property of the current total.
    ///
    ///      The two permanent refusals are checked in the order the
    ///      specification lists them, so that a fact which trips both always
    ///      reports the same reason.
    function _applyFunding(bytes32 evidenceId, Cr3dXVerifier.VerifiedEvidence memory evidence)
        private
        returns (EvidenceState)
    {
        bytes32 dealId = evidence.dealId;
        Deal storage deal = _deals[dealId];

        // Not a rejection. The deal can still be created, and the payer may
        // simply have been faster than the borrower.
        if (deal.status == DealStatus.NONE) return EvidenceState.VERIFIED_PENDING;

        // Both checks are against fields fixed when the deal was created, so
        // neither can come true later.
        if (evidence.recipient != deal.borrower) return _reject(evidenceId, dealId, RejectionReason.WRONG_RECIPIENT);
        if (evidence.counterparty != deal.designatedInvestor) {
            return _reject(evidenceId, dealId, RejectionReason.WRONG_INVESTOR);
        }

        // Accumulates, before the threshold and after it. A short payment is not
        // refused and neither is a surplus one: the money moved, and refusing it
        // here would destroy it exactly as a deadline check would. A surplus is
        // a gift from the investor to the borrower; there is no path back to the
        // source chain, and inventing a refund here would be fiction.
        uint256 fundedBefore = deal.fundedAmount;
        uint256 funded = fundedBefore + evidence.amount;
        uint256 required = deal.requiredFunding;
        deal.fundedAmount = funded;
        _applications[evidenceId] = Application(EvidenceState.APPLIED, RejectionReason.NONE);
        emit FundingApplied(dealId, evidenceId, evidence.amount, funded);

        // The crossing, and only the crossing. `fundedAmount` never decreases,
        // so this is true for exactly one applied funding however many arrive
        // and in whatever order.
        if (fundedBefore < required && funded >= required) {
            // The investor is taken from the proven log, not from whoever sent
            // this transaction.
            address investor = evidence.counterparty;
            deal.investor = investor;
            deal.status = DealStatus.FINANCED;
            credit.markFinanced(dealId);
            emit DealFinanced(dealId, investor, funded);
        }

        return EvidenceState.APPLIED;
    }

    /// @dev Repayment. Applies in every status, including a closed one: a proven
    ///      payment does not stop being a fact because the outcome is written.
    function _applyRepayment(bytes32 evidenceId, Cr3dXVerifier.VerifiedEvidence memory evidence)
        private
        returns (EvidenceState)
    {
        bytes32 dealId = evidence.dealId;
        Deal storage deal = _deals[dealId];

        if (deal.status == DealStatus.NONE) return EvidenceState.VERIFIED_PENDING;

        // Checked against the designated investor, which is fixed at creation,
        // rather than against the investor the funding recorded. The two are the
        // same address once the deal is financed, because funding is only
        // applied from the designated one; they differ only in that the
        // designated one is known earlier. Comparing against the later field
        // would leave a payment that went to the wrong address waiting forever
        // for a fact that would refuse it.
        if (evidence.recipient != deal.designatedInvestor) {
            return _reject(evidenceId, dealId, RejectionReason.WRONG_RECIPIENT);
        }
        // Right address, wrong time. There is nothing to repay yet: the deal has
        // not been financed, so it owes nobody anything. This waits rather than
        // applying, because a deal that closed without ever being financed would
        // contradict the lifecycle and INV-1.
        if (deal.status == DealStatus.CREATED) return EvidenceState.VERIFIED_PENDING;

        // Who paid is not checked. The specification says the payer need not be
        // the borrower, and a debt settled by a third party is still settled.
        uint256 faceValue = deal.faceValue;
        uint256 outstandingBefore = _satSub(faceValue, deal.repaidAmount);

        // Whole amounts, never trimmed to the remaining balance. Trimming would
        // make the totals depend on the order the proofs arrived in, which is
        // exactly what INV-20 forbids.
        uint256 repaid = deal.repaidAmount + evidence.amount;
        deal.repaidAmount = repaid;

        uint256 onTime = deal.onTimeRepaid;
        // Timeliness is judged by the source height the payment was included at,
        // so a slow worker cannot turn an on-time payment into a late one.
        if (evidence.blockHeight <= deal.dueBlock) {
            onTime += evidence.amount;
            deal.onTimeRepaid = onTime;
        }

        _applications[evidenceId] = Application(EvidenceState.APPLIED, RejectionReason.NONE);
        emit RepaymentApplied(dealId, evidenceId, evidence.amount, repaid, onTime);

        uint256 outstandingAfter = _satSub(faceValue, repaid);
        if (outstandingBefore > outstandingAfter) {
            credit.reduceExposure(dealId, outstandingBefore - outstandingAfter);
        }

        _settle(dealId, deal);
        return EvidenceState.APPLIED;
    }

    /// @dev Recomputes the deal's closed status from the accumulated totals and
    ///      refines it if the new value is higher.
    ///
    ///      Derived, not latched. Both accumulators only grow, so the derived
    ///      classification only moves upward on its own; the guards below say
    ///      the same thing in terms of the lifecycle, which is what a reader
    ///      checking against the specification will be looking for.
    ///
    ///      The status and the credit outcome move in one transition here and
    ///      nowhere else, which is what INV-21 asks for.
    function _settle(bytes32 dealId, Deal storage deal) private {
        DealStatus current = deal.status;
        // Terminal: `onTimeRepaid` cannot shrink, so the condition that produced
        // this status cannot stop holding.
        if (current == DealStatus.PAID_ON_TIME) return;

        uint256 faceValue = deal.faceValue;
        DealStatus derived;
        if (deal.onTimeRepaid >= faceValue) {
            derived = DealStatus.PAID_ON_TIME;
        } else if (deal.repaidAmount >= faceValue) {
            derived = DealStatus.PAID_LATE;
        } else {
            // Threshold not crossed. `FINANCED` or `DEFAULTED` stands, and a
            // partially repaid defaulted deal stays defaulted.
            return;
        }
        if (derived == current) return;

        deal.status = derived;
        credit.recordOutcome(dealId, derived == DealStatus.PAID_ON_TIME ? Result.PAID_ON_TIME : Result.PAID_LATE);
        emit DealSettled(dealId, derived);
    }

    /// @dev Records a permanent refusal.
    function _reject(bytes32 evidenceId, bytes32 dealId, RejectionReason reason) private returns (EvidenceState) {
        _applications[evidenceId] = Application(EvidenceState.REJECTED_PERMANENT, reason);
        emit EvidenceRejected(evidenceId, dealId, reason);
        return EvidenceState.REJECTED_PERMANENT;
    }

    /// @dev Subtraction that floors at zero instead of reverting.
    function _satSub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
