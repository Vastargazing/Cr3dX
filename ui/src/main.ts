import "./styles.css";

import { formatInteger, formatObservedAt, shortHex } from "./format";
import {
  createLiveRefreshController,
  type LiveObservationState,
  type SuccessfulLiveRead,
} from "./live-state";
import { readLiveState } from "./rpc";
import {
  ACCEPTED_EVIDENCE_COMMIT,
  DEPLOYMENT,
  LIVE_OPERATIONS,
  REPOSITORY_URL,
  SOURCE_TRANSACTIONS,
  creditcoinAddressUrl,
  creditcoinTransactionUrl,
  evidenceDocumentUrl,
  sepoliaTransactionUrl,
} from "./snapshot";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`Missing UI element #${id}`);
  return found as T;
}

function setText(id: string, value: string): void {
  element(id).textContent = value;
}

function setLink(id: string, href: string): void {
  const link = element<HTMLAnchorElement>(id);
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
}

function installStaticLinks(): void {
  setLink("deal-explorer-link", creditcoinAddressUrl(DEPLOYMENT.deals));
  setLink("deals-contract-link", creditcoinAddressUrl(DEPLOYMENT.deals));
  setLink("credit-contract-link", creditcoinAddressUrl(DEPLOYMENT.credit));
  setLink("source-transaction-link", sepoliaTransactionUrl(SOURCE_TRANSACTIONS.repayment));
  setLink("commit-link", `${REPOSITORY_URL}/commit/${ACCEPTED_EVIDENCE_COMMIT}`);
  setLink("gateway-link", `https://sepolia.etherscan.io/address/${DEPLOYMENT.gateway}`);
  setLink("verifier-link", creditcoinAddressUrl(DEPLOYMENT.verifier));
  setLink("deployment-deals-link", creditcoinAddressUrl(DEPLOYMENT.deals));
  setLink("deployment-credit-link", creditcoinAddressUrl(DEPLOYMENT.credit));
  setLink("status-doc-link", evidenceDocumentUrl("docs/STATUS.md"));
  setLink("spec-doc-link", evidenceDocumentUrl("docs/S6_WORKER_SPEC.md"));
  setLink(
    "phase-b-link",
    evidenceDocumentUrl("docs/verification/v0.4.8-phase-b/README.md"),
  );
}

function renderEvidenceRows(): void {
  const body = element<HTMLTableSectionElement>("evidence-rows");
  const fragment = document.createDocumentFragment();

  for (const operation of LIVE_OPERATIONS) {
    const row = document.createElement("tr");
    const operationCell = document.createElement("th");
    operationCell.scope = "row";
    const operationLabel = document.createElement("strong");
    operationLabel.textContent = operation.label;
    const operationNote = document.createElement("span");
    operationNote.textContent = operation.note;
    operationCell.append(operationLabel, operationNote);

    const actionCell = document.createElement("td");
    const actionCode = document.createElement("code");
    actionCode.textContent = operation.action;
    actionCell.append(actionCode);

    const proofCell = document.createElement("td");
    proofCell.textContent = operation.roots === null
      ? "Stored evidence"
      : `${operation.roots} roots · ${formatInteger(operation.anchor ?? 0)}`;

    const gasCell = document.createElement("td");
    gasCell.textContent = formatInteger(operation.gasUsed);

    const receiptCell = document.createElement("td");
    const receiptLink = document.createElement("a");
    receiptLink.href = creditcoinTransactionUrl(operation.hash);
    receiptLink.target = "_blank";
    receiptLink.rel = "noreferrer";
    receiptLink.className = "receipt-link";
    const receiptDot = document.createElement("i");
    const receiptCode = document.createElement("code");
    receiptCode.textContent = shortHex(operation.hash);
    const receiptArrow = document.createElement("span");
    receiptArrow.textContent = "↗";
    receiptLink.append(receiptDot, receiptCode, receiptArrow);
    receiptCell.append(receiptLink);

    row.append(operationCell, actionCell, proofCell, gasCell, receiptCell);
    fragment.append(row);
  }

  body.replaceChildren(fragment);
}

function renderSuccessfulRead(read: SuccessfulLiveRead): void {
  setText("live-block", formatInteger(read.value.blockNumber));
  setText("live-time", formatObservedAt(read.value.observedAt));
}

function comparisonText(read: SuccessfulLiveRead): string {
  if (read.differences.length === 0) {
    return `Matches accepted snapshot · borrower ${shortHex(read.value.borrower)} · investor ${shortHex(read.value.designatedInvestor)}`;
  }
  const detail = read.differences
    .map((difference) => `${difference.field}: accepted ${difference.accepted}, live ${difference.observed}`)
    .join("; ");
  return `${read.differences.length} difference${read.differences.length === 1 ? "" : "s"} · ${detail}`;
}

function renderLiveObservation(state: LiveObservationState): void {
  const panel = element("live-observation-panel");
  const button = element<HTMLButtonElement>("refresh-button");
  panel.dataset.state = state.kind;
  button.disabled = state.kind === "loading";
  if (state.kind === "loading") button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");

  if (state.kind === "idle") {
    setText("live-state-label", "Ready");
    setText("live-comparison", "Public Creditcoin RPC has not been read yet.");
    return;
  }
  if (state.kind === "loading") {
    setText("live-state-label", "Reading…");
    if (state.lastSuccessful === undefined) {
      setText("live-block", "—");
      setText("live-time", "—");
      setText("live-comparison", "Reading public Creditcoin RPC. The accepted snapshot is unchanged.");
    } else {
      renderSuccessfulRead(state.lastSuccessful);
      setText("live-comparison", `Refreshing. Last successful read: ${comparisonText(state.lastSuccessful)}`);
    }
    return;
  }
  if (state.kind === "fresh") {
    renderSuccessfulRead(state.lastSuccessful);
    setText("live-state-label", state.lastSuccessful.differences.length === 0 ? "MATCH" : "DIFF");
    setText("live-comparison", comparisonText(state.lastSuccessful));
    return;
  }
  if (state.kind === "stale") {
    renderSuccessfulRead(state.lastSuccessful);
    setText("live-state-label", "STALE");
    setText(
      "live-comparison",
      `RPC unavailable. Last successful read retained with its original block and time. ${comparisonText(state.lastSuccessful)}`,
    );
    return;
  }

  setText("live-state-label", "UNAVAILABLE");
  setText("live-block", "—");
  setText("live-time", "—");
  setText("live-comparison", `Public RPC unavailable. No live observation is displayed. ${state.error}`);
}

installStaticLinks();
renderEvidenceRows();

const liveController = createLiveRefreshController(readLiveState, renderLiveObservation);
element<HTMLButtonElement>("refresh-button").addEventListener("click", () => {
  void liveController.refresh();
});
void liveController.refresh();
