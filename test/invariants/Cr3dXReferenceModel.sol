// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Независимая исполняемая модель Cr3dX, построенная только по спецификации v0.4.2.
/// @dev Это не интерфейс продуктовых контрактов и не заготовка их реализации. Публичные методы
///      здесь являются абстрактными действиями машины состояний для фаззинга фазы A.
contract Cr3dXReferenceModel {
    uint16 public constant BASE_SCORE = 500;
    uint16 public constant MIN_SCORE = 300;
    uint16 public constant MAX_SCORE = 850;

    enum DealStatus {
        NONE,
        CREATED,
        FINANCED,
        DEFAULTED,
        PAID_LATE,
        PAID_ON_TIME
    }

    enum EvidenceKind {
        FUNDING,
        REPAYMENT
    }

    enum EvidenceState {
        UNSEEN,
        VERIFIED_PENDING,
        APPLIED,
        REJECTED_PERMANENT
    }

    enum RejectionReason {
        NONE,
        WRONG_INVESTOR,
        ALREADY_FUNDED,
        WRONG_RECIPIENT
    }

    enum Outcome {
        NONE,
        PAID_ON_TIME,
        PAID_LATE,
        DEFAULTED
    }

    struct Deal {
        bool exists;
        address borrower;
        address designatedInvestor;
        address investor;
        uint256 requiredFunding;
        uint256 fundedAmount;
        uint256 faceValue;
        uint256 repaidAmount;
        uint256 onTimeRepaid;
        uint64 dueBlock;
        DealStatus status;
        bool reserveActive;
        uint8 fundingThresholdCrossings;
    }

    struct Evidence {
        EvidenceKind kind;
        bytes32 dealId;
        address counterparty;
        address recipient;
        uint256 amount;
        uint64 blockHeight;
        EvidenceState state;
        RejectionReason rejectionReason;
        bool verifierAccepted;
        uint8 appliedCount;
    }

    struct CreditOutcome {
        bool exists;
        Outcome result;
        uint64 closedAtBlock;
    }

    struct BorrowerState {
        uint256 reserved;
        uint256 exposure;
        uint64 paidOnTimeCount;
        uint64 paidLateCount;
        uint64 defaultedCount;
    }

    uint256 public immutable baseLimit;
    uint64 public immutable attestationGracePeriod;
    uint64 public attestedHeight;

    mapping(bytes32 => Deal) private _deals;
    mapping(bytes32 => Evidence) private _evidence;
    mapping(bytes32 => CreditOutcome) private _outcomes;
    mapping(address => BorrowerState) private _borrowers;
    mapping(address => bytes32[]) private _borrowerDeals;
    mapping(address => bool) private _knownBorrower;

    bytes32[] private _dealIds;
    bytes32[] private _evidenceIds;
    address[] private _borrowerIds;

    constructor(uint256 baseLimit_, uint64 attestationGracePeriod_) {
        // Деление в формуле лимита выполняется после умножения. Ограничение сохраняет модель
        // в области, где сама тестовая арифметика не добавляет неописанное переполнение.
        require(baseLimit_ <= type(uint256).max / MAX_SCORE, "model base limit too large");
        baseLimit = baseLimit_;
        attestationGracePeriod = attestationGracePeriod_;
    }

    // -------------------------------------------------------------------------
    // Абстрактные действия
    // -------------------------------------------------------------------------

    function createDeal(
        bytes32 dealId,
        address borrower,
        address designatedInvestor,
        uint256 requiredFunding,
        uint256 faceValue,
        uint64 dueBlock
    ) external returns (bool created) {
        if (dealId == bytes32(0) || borrower == address(0) || _deals[dealId].exists) {
            return false;
        }
        if (requiredFunding == 0 || requiredFunding > faceValue) return false;
        if (faceValue > availableLimitOf(borrower)) return false;

        _rememberBorrower(borrower);
        _deals[dealId] = Deal({
            exists: true,
            borrower: borrower,
            designatedInvestor: designatedInvestor,
            investor: address(0),
            requiredFunding: requiredFunding,
            fundedAmount: 0,
            faceValue: faceValue,
            repaidAmount: 0,
            onTimeRepaid: 0,
            dueBlock: dueBlock,
            status: DealStatus.CREATED,
            reserveActive: true,
            fundingThresholdCrossings: 0
        });
        _dealIds.push(dealId);
        _borrowerDeals[borrower].push(dealId);
        _borrowers[borrower].reserved += faceValue;
        return true;
    }

    /// @notice Вводит в бизнес-модель только факт, уже принятый абстрактным верификатором.
    /// @dev Повтор идентификатора оставляет модель неизменной. Revert/no-op внешнего API —
    ///      отдельная неоднозначность; INV-2 требует лишь отсутствия повторного учёта.
    function registerVerifiedEvidence(
        bytes32 evidenceId,
        EvidenceKind kind,
        bytes32 dealId,
        address counterparty,
        address recipient,
        uint256 amount,
        uint64 blockHeight
    ) external returns (EvidenceState state) {
        if (evidenceId == bytes32(0)) return EvidenceState.UNSEEN;
        if (_evidence[evidenceId].state != EvidenceState.UNSEEN) return _evidence[evidenceId].state;

        _evidence[evidenceId] = Evidence({
            kind: kind,
            dealId: dealId,
            counterparty: counterparty,
            recipient: recipient,
            amount: amount,
            blockHeight: blockHeight,
            state: EvidenceState.VERIFIED_PENDING,
            rejectionReason: RejectionReason.NONE,
            verifierAccepted: true,
            appliedCount: 0
        });
        _evidenceIds.push(evidenceId);
        _tryApply(evidenceId);
        return _evidence[evidenceId].state;
    }

    function retryEvidence(bytes32 evidenceId) external returns (EvidenceState state) {
        _tryApply(evidenceId);
        return _evidence[evidenceId].state;
    }

    /// @notice Доводит ожидающие факты до неподвижной точки.
    /// @dev Нужен для сравнения экономических итогов после одинакового множества фактов,
    ///      когда порядок доставки временно оставил погашение до фандинга в PENDING.
    function drainPending() external {
        uint256 n = _evidenceIds.length;
        for (uint256 pass = 0; pass <= n; pass++) {
            bool changed;
            for (uint256 i = 0; i < n; i++) {
                bytes32 evidenceId = _evidenceIds[i];
                EvidenceState beforeState = _evidence[evidenceId].state;
                _tryApply(evidenceId);
                if (_evidence[evidenceId].state != beforeState) changed = true;
            }
            if (!changed) return;
        }
    }

    function advanceAttestedHeight(uint64 newHeight) external {
        if (newHeight > attestedHeight) attestedHeight = newHeight;
    }

    function markDefaulted(bytes32 dealId) external returns (bool marked) {
        Deal storage deal = _deals[dealId];
        if (deal.status != DealStatus.FINANCED) return false;
        if (uint256(attestedHeight) <= uint256(deal.dueBlock) + attestationGracePeriod) return false;

        deal.status = DealStatus.DEFAULTED;
        _setOutcome(dealId, Outcome.DEFAULTED);
        return true;
    }

    // -------------------------------------------------------------------------
    // Прямые независимые оракулы
    // -------------------------------------------------------------------------

    function outstandingOf(bytes32 dealId) public view returns (uint256) {
        Deal storage deal = _deals[dealId];
        return deal.repaidAmount >= deal.faceValue ? 0 : deal.faceValue - deal.repaidAmount;
    }

    function exposureByFullRecalculation(address borrower) public view returns (uint256 total) {
        bytes32[] storage ids = _borrowerDeals[borrower];
        for (uint256 i = 0; i < ids.length; i++) {
            Deal storage deal = _deals[ids[i]];
            if (deal.status == DealStatus.FINANCED || deal.status == DealStatus.DEFAULTED) {
                total += outstandingOf(ids[i]);
            }
        }
    }

    function reservedByFullRecalculation(address borrower) public view returns (uint256 total) {
        bytes32[] storage ids = _borrowerDeals[borrower];
        for (uint256 i = 0; i < ids.length; i++) {
            Deal storage deal = _deals[ids[i]];
            if (deal.reserveActive) total += deal.faceValue;
        }
    }

    function countersByFullRecalculation(address borrower)
        public
        view
        returns (uint64 paidOnTime, uint64 paidLate, uint64 defaulted)
    {
        bytes32[] storage ids = _borrowerDeals[borrower];
        for (uint256 i = 0; i < ids.length; i++) {
            CreditOutcome storage outcome = _outcomes[ids[i]];
            if (!outcome.exists) continue;
            if (outcome.result == Outcome.PAID_ON_TIME) paidOnTime++;
            else if (outcome.result == Outcome.PAID_LATE) paidLate++;
            else if (outcome.result == Outcome.DEFAULTED) defaulted++;
        }
    }

    function scoreOf(address borrower) public view returns (uint16) {
        BorrowerState storage state = _borrowers[borrower];
        return _score(state.paidOnTimeCount, state.paidLateCount, state.defaultedCount);
    }

    function scoreByFullRecalculation(address borrower) public view returns (uint16) {
        (uint64 paidOnTime, uint64 paidLate, uint64 defaulted) = countersByFullRecalculation(borrower);
        return _score(paidOnTime, paidLate, defaulted);
    }

    function limitOf(address borrower) public view returns (uint256) {
        return baseLimit * scoreOf(borrower) / BASE_SCORE;
    }

    function availableLimitOf(address borrower) public view returns (uint256) {
        BorrowerState storage state = _borrowers[borrower];
        uint256 used = state.reserved + state.exposure;
        uint256 limit = limitOf(borrower);
        return used >= limit ? 0 : limit - used;
    }

    /// @notice Классификация итога напрямую из накопленных сумм и дефолтного флага.
    function canonicalOutcomeOf(bytes32 dealId) public view returns (Outcome) {
        Deal storage deal = _deals[dealId];
        if (deal.onTimeRepaid >= deal.faceValue && deal.exists) return Outcome.PAID_ON_TIME;
        if (deal.repaidAmount >= deal.faceValue && deal.exists) return Outcome.PAID_LATE;
        if (deal.status == DealStatus.DEFAULTED) return Outcome.DEFAULTED;
        return Outcome.NONE;
    }

    /// @notice Буквальный оракул общего критерия из 3.3.
    /// @dev Для погашения до фандинга он использует неизменяемый designatedInvestor.
    ///      Это намеренно выявляет конфликт с частным правилом «инвестор не зафиксирован — PENDING».
    function canEverBecomeApplicable(bytes32 evidenceId) public view returns (bool) {
        Evidence storage item = _evidence[evidenceId];
        if (item.state != EvidenceState.VERIFIED_PENDING) return false;
        Deal storage deal = _deals[item.dealId];
        if (!deal.exists) return true;

        if (item.kind == EvidenceKind.FUNDING) {
            if (item.recipient != deal.borrower) return false;
            if (item.counterparty != deal.designatedInvestor) return false;
            return deal.fundedAmount < deal.requiredFunding;
        }

        address onlyPossibleInvestor = deal.investor == address(0) ? deal.designatedInvestor : deal.investor;
        return item.recipient == onlyPossibleInvestor;
    }

    // -------------------------------------------------------------------------
    // Наблюдаемое состояние для тестов
    // -------------------------------------------------------------------------

    function getDeal(bytes32 dealId) external view returns (Deal memory) {
        return _deals[dealId];
    }

    function evidence(bytes32 evidenceId) external view returns (Evidence memory) {
        return _evidence[evidenceId];
    }

    function getOutcome(bytes32 dealId) external view returns (CreditOutcome memory) {
        return _outcomes[dealId];
    }

    function borrowerState(address borrower) external view returns (BorrowerState memory) {
        return _borrowers[borrower];
    }

    function dealCount() external view returns (uint256) {
        return _dealIds.length;
    }

    function dealIdAt(uint256 index) external view returns (bytes32) {
        return _dealIds[index];
    }

    function evidenceCount() external view returns (uint256) {
        return _evidenceIds.length;
    }

    function evidenceIdAt(uint256 index) external view returns (bytes32) {
        return _evidenceIds[index];
    }

    function borrowerCount() external view returns (uint256) {
        return _borrowerIds.length;
    }

    function borrowerAt(uint256 index) external view returns (address) {
        return _borrowerIds[index];
    }

    // -------------------------------------------------------------------------
    // Внутренние переходы модели
    // -------------------------------------------------------------------------

    function _tryApply(bytes32 evidenceId) private {
        Evidence storage item = _evidence[evidenceId];
        if (item.state != EvidenceState.VERIFIED_PENDING) return;

        Deal storage deal = _deals[item.dealId];
        if (!deal.exists) return;

        if (item.kind == EvidenceKind.FUNDING) _applyFunding(item, deal);
        else _applyRepayment(item, deal);
    }

    function _applyFunding(Evidence storage item, Deal storage deal) private {
        // Порядок проверок следует явному списку 4.3; обе первые причины постоянны.
        if (item.recipient != deal.borrower) {
            _reject(item, RejectionReason.WRONG_RECIPIENT);
            return;
        }
        if (item.counterparty != deal.designatedInvestor) {
            _reject(item, RejectionReason.WRONG_INVESTOR);
            return;
        }
        if (deal.fundedAmount >= deal.requiredFunding) {
            _reject(item, RejectionReason.ALREADY_FUNDED);
            return;
        }

        item.state = EvidenceState.APPLIED;
        item.appliedCount++;
        deal.fundedAmount += item.amount;

        if (deal.fundedAmount >= deal.requiredFunding) {
            deal.status = DealStatus.FINANCED;
            deal.investor = deal.designatedInvestor;
            deal.fundingThresholdCrossings++;
            deal.reserveActive = false;

            BorrowerState storage borrower = _borrowers[deal.borrower];
            borrower.reserved -= deal.faceValue;
            borrower.exposure += deal.faceValue;
        }
    }

    function _applyRepayment(Evidence storage item, Deal storage deal) private {
        // Это буквальное частное правило 4.3. Его конфликт с общим критерием 3.3
        // для заведомо неверного получателя зафиксирован в SPEC_AMBIGUITIES.md.
        if (deal.investor == address(0)) return;
        if (item.recipient != deal.investor) {
            _reject(item, RejectionReason.WRONG_RECIPIENT);
            return;
        }

        uint256 beforeOutstanding = outstandingOf(item.dealId);
        bool countedInExposure = deal.status == DealStatus.FINANCED || deal.status == DealStatus.DEFAULTED;

        item.state = EvidenceState.APPLIED;
        item.appliedCount++;
        deal.repaidAmount += item.amount;
        if (item.blockHeight <= deal.dueBlock) deal.onTimeRepaid += item.amount;

        if (countedInExposure) {
            uint256 afterOutstanding = outstandingOf(item.dealId);
            _borrowers[deal.borrower].exposure -= beforeOutstanding - afterOutstanding;
        }

        if (deal.onTimeRepaid >= deal.faceValue) {
            deal.status = DealStatus.PAID_ON_TIME;
            _setOutcome(item.dealId, Outcome.PAID_ON_TIME);
        } else if (deal.repaidAmount >= deal.faceValue) {
            deal.status = DealStatus.PAID_LATE;
            _setOutcome(item.dealId, Outcome.PAID_LATE);
        }
    }

    function _reject(Evidence storage item, RejectionReason reason) private {
        item.state = EvidenceState.REJECTED_PERMANENT;
        item.rejectionReason = reason;
    }

    function _setOutcome(bytes32 dealId, Outcome next) private {
        Deal storage deal = _deals[dealId];
        CreditOutcome storage current = _outcomes[dealId];
        if (current.exists && current.result == next) return;

        BorrowerState storage borrower = _borrowers[deal.borrower];
        if (current.exists) _decrementCounter(borrower, current.result);
        _incrementCounter(borrower, next);

        current.exists = true;
        current.result = next;
        current.closedAtBlock = attestedHeight;
    }

    function _incrementCounter(BorrowerState storage borrower, Outcome result) private {
        if (result == Outcome.PAID_ON_TIME) borrower.paidOnTimeCount++;
        else if (result == Outcome.PAID_LATE) borrower.paidLateCount++;
        else if (result == Outcome.DEFAULTED) borrower.defaultedCount++;
    }

    function _decrementCounter(BorrowerState storage borrower, Outcome result) private {
        if (result == Outcome.PAID_ON_TIME) borrower.paidOnTimeCount--;
        else if (result == Outcome.PAID_LATE) borrower.paidLateCount--;
        else if (result == Outcome.DEFAULTED) borrower.defaultedCount--;
    }

    function _score(uint64 paidOnTime, uint64 paidLate, uint64 defaulted) private pure returns (uint16) {
        int256 raw = int256(uint256(BASE_SCORE));
        raw += int256(uint256(paidOnTime)) * 25;
        raw -= int256(uint256(paidLate)) * 50;
        raw -= int256(uint256(defaulted)) * 200;
        if (raw < int256(uint256(MIN_SCORE))) return MIN_SCORE;
        if (raw > int256(uint256(MAX_SCORE))) return MAX_SCORE;
        return uint16(uint256(raw));
    }

    function _rememberBorrower(address borrower) private {
        if (_knownBorrower[borrower]) return;
        _knownBorrower[borrower] = true;
        _borrowerIds.push(borrower);
    }
}
