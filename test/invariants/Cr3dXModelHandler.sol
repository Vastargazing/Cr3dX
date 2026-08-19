// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Cr3dXReferenceModel} from "./Cr3dXReferenceModel.sol";

/// @notice Ограниченный генератор абстрактных действий для stateful-фаззинга модели.
/// @dev Не знает ABI будущих Cr3dXDeals/Cr3dXCredit и не импортирует их.
contract Cr3dXModelHandler {
    Cr3dXReferenceModel public immutable model;

    uint256 private _dealNonce;
    uint256 private _evidenceNonce;

    constructor(Cr3dXReferenceModel model_) {
        model = model_;
    }

    function createDeal(uint256 borrowerSeed, uint256 investorSeed, uint256 faceSeed, uint256 dueSeed)
        external
    {
        address borrower = _borrower(borrowerSeed);
        address investor = _investor(investorSeed);
        uint256 available = model.availableLimitOf(borrower);
        if (available == 0) return;

        uint256 ceiling = available < 1_000 ? available : 1_000;
        uint256 faceValue = 1 + (faceSeed % ceiling);
        uint256 requiredFunding = 1 + (uint256(keccak256(abi.encode(faceSeed))) % faceValue);
        bytes32 dealId = keccak256(abi.encode("ordinary-deal", address(this), _dealNonce++));
        model.createDeal(dealId, borrower, investor, requiredFunding, faceValue, uint64(dueSeed));
    }

    /// @notice Создаёт предсказуемый dealId, чтобы доказательство могло появиться раньше сделки.
    function createPlannedDeal(uint256 planSeed) external {
        uint256 plan = planSeed % 16;
        bytes32 dealId = _plannedDealId(plan);
        address borrower = _borrower(plan);
        uint256 faceValue = 100 + plan * 10;
        uint256 available = model.availableLimitOf(borrower);
        if (faceValue > available) return;
        model.createDeal(dealId, borrower, _investor(plan), faceValue - 1, faceValue, uint64(100 + plan));
    }

    function submitFunding(uint256 dealSeed, uint256 amountSeed, bool wrongInvestor, bool wrongRecipient)
        external
    {
        bytes32 dealId = _pickDeal(dealSeed);
        if (dealId == bytes32(0)) return;
        Cr3dXReferenceModel.Deal memory deal = model.getDeal(dealId);

        address counterparty = wrongInvestor ? _different(deal.designatedInvestor) : deal.designatedInvestor;
        address recipient = wrongRecipient ? _different(deal.borrower) : deal.borrower;
        uint256 amount = amountSeed % (deal.requiredFunding * 2 + 1);
        _register(Cr3dXReferenceModel.EvidenceKind.FUNDING, dealId, counterparty, recipient, amount, 0);
    }

    function submitRepayment(uint256 dealSeed, uint256 amountSeed, uint256 heightSeed, bool wrongRecipient)
        external
    {
        bytes32 dealId = _pickDeal(dealSeed);
        if (dealId == bytes32(0)) return;
        Cr3dXReferenceModel.Deal memory deal = model.getDeal(dealId);

        address expected = deal.investor == address(0) ? deal.designatedInvestor : deal.investor;
        address recipient = wrongRecipient ? _different(expected) : expected;
        uint256 amount = amountSeed % (deal.faceValue * 2 + 1);
        _register(
            Cr3dXReferenceModel.EvidenceKind.REPAYMENT,
            dealId,
            _borrower(amountSeed),
            recipient,
            amount,
            uint64(heightSeed)
        );
    }

    function submitUnknownFunding(uint256 planSeed, uint256 amountSeed, bool wrongRecipient) external {
        uint256 plan = planSeed % 16;
        address borrower = _borrower(plan);
        address recipient = wrongRecipient ? _different(borrower) : borrower;
        _register(
            Cr3dXReferenceModel.EvidenceKind.FUNDING,
            _plannedDealId(plan),
            _investor(plan),
            recipient,
            amountSeed % 400,
            uint64(plan)
        );
    }

    function submitUnknownRepayment(uint256 planSeed, uint256 amountSeed, bool wrongRecipient) external {
        uint256 plan = planSeed % 16;
        address expected = _investor(plan);
        address recipient = wrongRecipient ? _different(expected) : expected;
        _register(
            Cr3dXReferenceModel.EvidenceKind.REPAYMENT,
            _plannedDealId(plan),
            _borrower(amountSeed),
            recipient,
            amountSeed % 400,
            uint64(plan)
        );
    }

    function retryEvidence(uint256 evidenceSeed) external {
        uint256 count = model.evidenceCount();
        if (count == 0) return;
        model.retryEvidence(model.evidenceIdAt(evidenceSeed % count));
    }

    function duplicateEvidence(uint256 evidenceSeed) external {
        uint256 count = model.evidenceCount();
        if (count == 0) return;
        bytes32 evidenceId = model.evidenceIdAt(evidenceSeed % count);
        Cr3dXReferenceModel.Evidence memory item = model.evidence(evidenceId);
        model.registerVerifiedEvidence(
            evidenceId,
            item.kind,
            item.dealId,
            item.counterparty,
            item.recipient,
            item.amount,
            item.blockHeight
        );
    }

    function drainPending() external {
        model.drainPending();
    }

    function advanceAttestedHeight(uint256 deltaSeed) external {
        uint64 current = model.attestedHeight();
        uint64 delta = uint64(deltaSeed % 2_000);
        if (type(uint64).max - current < delta) model.advanceAttestedHeight(type(uint64).max);
        else model.advanceAttestedHeight(current + delta);
    }

    function markDefaulted(uint256 dealSeed) external {
        bytes32 dealId = _pickDeal(dealSeed);
        if (dealId != bytes32(0)) model.markDefaulted(dealId);
    }

    function _register(
        Cr3dXReferenceModel.EvidenceKind kind,
        bytes32 dealId,
        address counterparty,
        address recipient,
        uint256 amount,
        uint64 blockHeight
    ) private {
        bytes32 evidenceId = keccak256(abi.encode("model-evidence", address(this), _evidenceNonce++));
        model.registerVerifiedEvidence(evidenceId, kind, dealId, counterparty, recipient, amount, blockHeight);
    }

    function _pickDeal(uint256 seed) private view returns (bytes32) {
        uint256 count = model.dealCount();
        return count == 0 ? bytes32(0) : model.dealIdAt(seed % count);
    }

    function _plannedDealId(uint256 plan) private pure returns (bytes32) {
        return keccak256(abi.encode("planned-deal", plan));
    }

    function _borrower(uint256 seed) private pure returns (address) {
        return address(uint160(0xB000 + (seed % 8) + 1));
    }

    function _investor(uint256 seed) private pure returns (address) {
        return address(uint160(0xA000 + (seed % 8) + 1));
    }

    function _different(address account) private pure returns (address) {
        address candidate = address(uint160(uint256(uint160(account)) ^ 1));
        return candidate == address(0) ? address(1) : candidate;
    }
}
