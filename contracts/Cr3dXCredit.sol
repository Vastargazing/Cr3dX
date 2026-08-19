// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IChainInfo} from "./interfaces/IChainInfo.sol";
import {Attestcoin} from "./libraries/Attestcoin.sol";

/// @notice How a deal ended, once it ended.
/// @dev `NONE` is the absence of an outcome, not an outcome. A deal that is
///      financed and still running has `NONE`, and so does a deal that was never
///      created. The three real values are the ones the specification names.
enum Result {
    NONE,
    PAID_ON_TIME,
    PAID_LATE,
    DEFAULTED
}

/// @title Cr3dXCredit
/// @notice Credit standing of a borrower: score, limit, reserve, exposure, and
///         the canonical outcome of every deal they ever opened.
///
/// @dev **Who may write here, and why it cannot be anyone else.**
///
///      Every mutating function is `onlyDeals`, and `deals` is the address that
///      deployed this contract. `Cr3dXDeals` constructs `Cr3dXCredit` from its
///      own constructor, so the pairing is fixed at deployment by construction
///      rather than wired up afterwards through a setter.
///
///      That is not a stylistic preference. The two contracts need each other's
///      addresses, and the usual answer to that circle is an initialiser that
///      some privileged address is entitled to call once. The moment such an
///      address exists, INV-7 - *no role, including the deployer, can change a
///      status, a proof, an outcome or a reserve* - stops being true, because
///      the deployer could point this contract at a registry of their own. There
///      is no owner here, no initialiser, and nothing to call before the first
///      deal. The cost is that this contract cannot be deployed on its own, and
///      that cost buys the product's central claim.
///
///      **What is canonical and what is a cache.** The canonical record is one
///      `DealRecord` per deal plus the ordered list of a borrower's deals. The
///      three counters are a derived cache, kept so that a score costs constant
///      gas. `scoreFromOutcomes` recomputes the same number by walking the
///      canonical list, and INV-5 is precisely the statement that the two agree.
///      Keeping the recomputation on chain rather than only in the tests means
///      the claim is checkable by anyone at any time, for free.
///
///      **Why the score is clamped once.** Clamping after every outcome would
///      make the result depend on the order the outcomes arrived in: a borrower
///      who defaults twice and then repays four times would land on a different
///      score than one who repaid four times and then defaulted twice, because
///      the floor at 300 would have swallowed part of the penalty. One clamp,
///      applied to the finished sum, makes the score a pure function of the
///      multiset of outcomes. That is INV-5, and it is also the economically
///      sane behaviour: a borrower pinned to the floor recovers cleanly instead
///      of being stuck there.
///
///      **Why the raw score is signed.** With three defaults the raw score is
///      -100 before clamping. In unsigned arithmetic that subtraction reverts,
///      turning a borrower with a bad history into a borrower whose score cannot
///      be read at all.
contract Cr3dXCredit {
    /// @notice Score of a borrower with no history.
    /// @dev Declared `uint16`, the width a score is actually stored and returned
    ///      in, so that every conversion in the arithmetic below is a widening
    ///      one. A `uint256` constant here would have to be narrowed on the way
    ///      into signed arithmetic, which is the kind of cast worth not having.
    uint16 public constant BASE_SCORE = 500;

    /// @notice Score floor and ceiling, applied once to the finished sum.
    uint16 public constant MIN_SCORE = 300;
    uint16 public constant MAX_SCORE = 850;

    int256 private constant WEIGHT_PAID_ON_TIME = 25;
    int256 private constant WEIGHT_PAID_LATE = -50;
    int256 private constant WEIGHT_DEFAULTED = -200;

    /// @notice Credit line of a borrower whose score is exactly `BASE_SCORE`.
    /// @dev Native token units, always. Nothing in Cr3dX reads `decimals` from
    ///      the asset: `decimals` is not a required part of ERC-20, and making
    ///      the arithmetic of a credit limit depend on an external call would
    ///      turn reading somebody else's contract into part of the credit logic.
    ///      The deployment script converts human amounts; the contract never does.
    uint256 public immutable baseLimit;

    /// @notice The registry allowed to write here. Fixed at construction.
    address public immutable deals;

    /// @notice Creditcoin's internal identifier for the source chain.
    /// @dev Used for one thing only: stamping an outcome with the attested
    ///      source height at which it was reached. Creditcoin's own block number
    ///      never appears in this contract.
    uint64 public immutable chainKey;

    /// @notice The canonical record of one deal, as the credit layer sees it.
    /// @param borrower Whose limit this deal consumes. Non-zero once opened, and
    ///        that is how existence is tested.
    /// @param outcome The canonical outcome. `NONE` until the deal closes or
    ///        defaults.
    /// @param financed Whether the reserve has already become exposure. The
    ///        conversion happens exactly once; see INV-13.
    /// @param closedAtBlock Attested source height at which `outcome` took its
    ///        current value. Rewritten together with the outcome, because an
    ///        outcome that was refined upward was reached at the later moment.
    /// @param faceValue Amount reserved at creation and moved into exposure at
    ///        financing.
    struct DealRecord {
        // slot 0: 20 + 1 + 1 + 8 = 30 bytes
        address borrower;
        Result outcome;
        bool financed;
        uint64 closedAtBlock;
        // slot 1
        uint256 faceValue;
    }

    /// @notice How many deals of a borrower ended each way.
    /// @dev A derived cache of the canonical records, packed into one slot so
    ///      that recording an outcome touches a single warm word.
    struct Counters {
        uint32 paidOnTime;
        uint32 paidLate;
        uint32 defaulted;
    }

    mapping(bytes32 => DealRecord) private _records;
    mapping(address => bytes32[]) private _borrowerDeals;
    mapping(address => Counters) private _counters;
    mapping(address => uint256) private _reserved;
    mapping(address => uint256) private _exposure;

    /// @notice Only `Cr3dXDeals` may write here.
    error NotDeals(address caller);
    /// @notice A deal identifier was registered twice.
    error DealAlreadyOpen(bytes32 dealId);
    /// @notice A deal identifier is unknown to the credit layer.
    error UnknownDeal(bytes32 dealId);
    /// @notice The reserve of this deal has already become exposure.
    error DealAlreadyFinanced(bytes32 dealId);
    /// @notice `faceValue` exceeds what the borrower's limit still allows.
    error ExceedsAvailableLimit(address borrower, uint256 faceValue, uint256 available);
    /// @notice `recordOutcome` was called with `Result.NONE`.
    /// @dev Clearing an outcome is not one of the refinements the lifecycle
    ///      allows, and there is no path in the registry that asks for it.
    error OutcomeCannotBeCleared(bytes32 dealId);
    /// @notice The source chain has no attested height yet.
    error NoAttestedHeight(uint64 chainKey);

    /// @notice A deal was opened and its face value reserved against the limit.
    event DealOpened(bytes32 indexed dealId, address indexed borrower, uint256 faceValue, uint256 reserved);
    /// @notice A reserve became exposure, exactly once for this deal.
    event ReserveConverted(bytes32 indexed dealId, address indexed borrower, uint256 amount, uint256 reserved, uint256 exposure);
    /// @notice Proven repayment reduced the borrower's outstanding exposure.
    event ExposureReduced(bytes32 indexed dealId, address indexed borrower, uint256 amount, uint256 exposure);
    /// @notice The canonical outcome of a deal was written or refined.
    event OutcomeRecorded(
        bytes32 indexed dealId,
        address indexed borrower,
        Result previous,
        Result current,
        uint64 closedAtBlock
    );

    modifier onlyDeals() {
        if (msg.sender != deals) revert NotDeals(msg.sender);
        _;
    }

    /// @param baseLimit_ Credit line at `BASE_SCORE`, in native token units.
    /// @param chainKey_ Source chain key, used only to stamp outcomes with an
    ///        attested source height.
    /// @dev `deals` is `msg.sender` because this contract is constructed from
    ///      the registry's constructor. Deploying it directly would leave it
    ///      owned by whoever sent that transaction and unable to do anything,
    ///      since the registry it would need is the one that never existed.
    constructor(uint256 baseLimit_, uint64 chainKey_) {
        baseLimit = baseLimit_;
        deals = msg.sender;
        chainKey = chainKey_;
    }

    // ------------------------------------------------------------------
    // written by the registry
    // ------------------------------------------------------------------

    /// @notice Registers a new deal and reserves its face value against the limit.
    /// @dev The limit check lives here rather than in the registry because the
    ///      limit is this contract's own arithmetic. INV-10 is enforced at this
    ///      line and nowhere else.
    function openDeal(bytes32 dealId, address borrower, uint256 faceValue) external onlyDeals {
        DealRecord storage record = _records[dealId];
        if (record.borrower != address(0)) revert DealAlreadyOpen(dealId);

        uint256 available = availableLimitOf(borrower);
        if (faceValue > available) revert ExceedsAvailableLimit(borrower, faceValue, available);

        record.borrower = borrower;
        record.faceValue = faceValue;
        _borrowerDeals[borrower].push(dealId);

        uint256 reserved = _reserved[borrower] + faceValue;
        _reserved[borrower] = reserved;
        emit DealOpened(dealId, borrower, faceValue, reserved);
    }

    /// @notice Turns the reserve of a financed deal into exposure. Once per deal.
    /// @dev The `financed` flag is what makes "once" enforceable here rather
    ///      than merely intended by the caller. Converting twice would return
    ///      the face value to the available limit a second time, which is the
    ///      double-spend of a credit line that INV-13 exists to forbid.
    function markFinanced(bytes32 dealId) external onlyDeals {
        DealRecord storage record = _records[dealId];
        address borrower = record.borrower;
        if (borrower == address(0)) revert UnknownDeal(dealId);
        if (record.financed) revert DealAlreadyFinanced(dealId);

        record.financed = true;
        uint256 faceValue = record.faceValue;
        // Saturating, like every subtraction in this contract. The reserve
        // cannot legitimately be short here, and reverting on the impossible
        // would strand a deal whose money has already moved on the source chain.
        uint256 reserved = _satSub(_reserved[borrower], faceValue);
        uint256 exposure = _exposure[borrower] + faceValue;
        _reserved[borrower] = reserved;
        _exposure[borrower] = exposure;

        emit ReserveConverted(dealId, borrower, faceValue, reserved, exposure);
    }

    /// @notice Reduces exposure by the amount a proven repayment retired.
    /// @dev The registry computes the delta from the deal's outstanding balance
    ///      before and after the repayment, so an overpayment contributes
    ///      nothing here: outstanding is already zero and the delta is zero.
    ///      Exposure never goes negative and never gets released twice.
    function reduceExposure(bytes32 dealId, uint256 amount) external onlyDeals {
        DealRecord storage record = _records[dealId];
        address borrower = record.borrower;
        if (borrower == address(0)) revert UnknownDeal(dealId);

        uint256 exposure = _satSub(_exposure[borrower], amount);
        _exposure[borrower] = exposure;
        emit ExposureReduced(dealId, borrower, amount, exposure);
    }

    /// @notice Writes or refines the canonical outcome of a deal.
    ///
    /// @dev **One mechanism, no special cases.** Decrement the counter of the
    ///      previous outcome if there was one, increment the counter of the new
    ///      one, store the new one. A branch written only for `DEFAULTED` to
    ///      `PAID_LATE` would have been incomplete: the lifecycle allows three
    ///      distinct refinements, and the fourth would have been added by
    ///      somebody who noticed later.
    ///
    ///      Which refinements are legal is the registry's question, not this
    ///      contract's: the deal status and the outcome must move in one
    ///      transition (INV-21), and the registry is where that transition is
    ///      decided. Re-deciding it here would create a second opinion that could
    ///      disagree with the first.
    ///
    ///      Recording the same outcome twice is a no-op rather than an error.
    ///      Exposure is untouched: an outcome refined upward reclassifies a fact
    ///      that already moved money when the repayment was applied.
    function recordOutcome(bytes32 dealId, Result result) external onlyDeals {
        if (result == Result.NONE) revert OutcomeCannotBeCleared(dealId);

        DealRecord storage record = _records[dealId];
        address borrower = record.borrower;
        if (borrower == address(0)) revert UnknownDeal(dealId);

        Result previous = record.outcome;
        if (previous == result) return;

        Counters memory counters = _counters[borrower];
        if (previous != Result.NONE) counters = _step(counters, previous, false);
        counters = _step(counters, result, true);
        _counters[borrower] = counters;

        uint64 height = attestedSourceHeight();
        record.outcome = result;
        record.closedAtBlock = height;

        emit OutcomeRecorded(dealId, borrower, previous, result, height);
    }

    // ------------------------------------------------------------------
    // reads
    // ------------------------------------------------------------------

    /// @notice Credit score of a borrower, from the counter cache.
    function scoreOf(address borrower) public view returns (uint16) {
        Counters memory counters = _counters[borrower];
        return _score(counters);
    }

    /// @notice The same score, recomputed from the canonical per-deal outcomes.
    /// @dev Linear in the borrower's deal count and meant for off-chain reads.
    ///      It exists so that INV-5 - the counters agree with the canonical
    ///      record - is checkable by anyone against the live chain rather than
    ///      only inside our test suite.
    function scoreFromOutcomes(address borrower) external view returns (uint16) {
        bytes32[] storage list = _borrowerDeals[borrower];
        Counters memory counters;
        for (uint256 i = 0; i < list.length; i++) {
            Result outcome = _records[list[i]].outcome;
            if (outcome != Result.NONE) counters = _step(counters, outcome, true);
        }
        return _score(counters);
    }

    /// @notice Credit line of a borrower at their current score.
    function limitOf(address borrower) public view returns (uint256) {
        return (baseLimit * scoreOf(borrower)) / BASE_SCORE;
    }

    /// @notice What the borrower may still commit: limit minus reserve and exposure.
    /// @dev Saturating. Exposure legitimately exceeds the limit after a score
    ///      drop, and that is a borrower who may open nothing new, not an
    ///      arithmetic error.
    function availableLimitOf(address borrower) public view returns (uint256) {
        return _satSub(limitOf(borrower), usedLimitOf(borrower));
    }

    /// @notice Reserve plus exposure.
    function usedLimitOf(address borrower) public view returns (uint256) {
        return _reserved[borrower] + _exposure[borrower];
    }

    /// @notice Face value reserved by deals that have not been financed yet.
    function reservedOf(address borrower) external view returns (uint256) {
        return _reserved[borrower];
    }

    /// @notice Outstanding debt across the borrower's financed and defaulted deals.
    function exposureOf(address borrower) external view returns (uint256) {
        return _exposure[borrower];
    }

    /// @notice The canonical record of one deal.
    function recordOf(bytes32 dealId) external view returns (DealRecord memory) {
        return _records[dealId];
    }

    /// @notice The canonical outcome of one deal.
    function outcomeOf(bytes32 dealId) external view returns (Result) {
        return _records[dealId].outcome;
    }

    /// @notice Every deal a borrower has opened, in creation order.
    function dealsOf(address borrower) external view returns (bytes32[] memory) {
        return _borrowerDeals[borrower];
    }

    /// @notice How many deals a borrower has opened.
    function dealCountOf(address borrower) external view returns (uint256) {
        return _borrowerDeals[borrower].length;
    }

    /// @notice The three outcome counters behind a borrower's score.
    function countersOf(address borrower) external view returns (Counters memory) {
        return _counters[borrower];
    }

    /// @notice Highest attested source height, read from the ChainInfo precompile.
    /// @dev The only clock this contract is allowed to read. Creditcoin's own
    ///      block number says nothing about the source chain.
    function attestedSourceHeight() public view returns (uint64) {
        IChainInfo.HeightHashResult memory result =
            Attestcoin.CHAIN_INFO.get_latest_attestation_height_and_hash(chainKey);
        if (!result.exists) revert NoAttestedHeight(chainKey);
        return result.height;
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /// @dev The score as a pure function of the three counters.
    function _score(Counters memory counters) private pure returns (uint16) {
        int256 raw = int256(uint256(BASE_SCORE)) + WEIGHT_PAID_ON_TIME * int256(uint256(counters.paidOnTime))
            + WEIGHT_PAID_LATE * int256(uint256(counters.paidLate))
            + WEIGHT_DEFAULTED * int256(uint256(counters.defaulted));

        // One clamp, on the finished sum. See the contract note above for why
        // clamping earlier would make the result order dependent.
        if (raw < int256(uint256(MIN_SCORE))) return MIN_SCORE;
        if (raw > int256(uint256(MAX_SCORE))) return MAX_SCORE;
        // Both bounds have been applied, so `raw` is in [MIN_SCORE, MAX_SCORE]
        // and neither conversion can lose anything.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint16(uint256(raw));
    }

    /// @dev Moves one counter up or down. `Result.NONE` never reaches here.
    ///      Checked arithmetic on purpose: a decrement below zero would mean the
    ///      cache had drifted from the canonical records, and that is worth a
    ///      revert rather than a silently wrapped counter and a nonsense score.
    function _step(Counters memory counters, Result result, bool up) private pure returns (Counters memory) {
        if (result == Result.PAID_ON_TIME) {
            counters.paidOnTime = up ? counters.paidOnTime + 1 : counters.paidOnTime - 1;
        } else if (result == Result.PAID_LATE) {
            counters.paidLate = up ? counters.paidLate + 1 : counters.paidLate - 1;
        } else {
            counters.defaulted = up ? counters.defaulted + 1 : counters.defaulted - 1;
        }
        return counters;
    }

    /// @dev Subtraction that floors at zero instead of reverting.
    function _satSub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}
