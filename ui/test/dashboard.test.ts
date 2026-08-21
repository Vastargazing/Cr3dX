import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatInteger, formatTokenUnits, shortHex } from "../src/format";
import {
  createLiveRefreshController,
  type LiveObservationState,
} from "../src/live-state";
import type { LiveState } from "../src/rpc";
import {
  ACCEPTED_EVIDENCE_COMMIT,
  ACCEPTED_SNAPSHOT,
  DEPLOYMENT,
  LIVE_OPERATIONS,
  creditcoinAddressUrl,
  creditcoinTransactionUrl,
  evidenceDocumentUrl,
  sepoliaTransactionUrl,
} from "../src/snapshot";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(testDirectory, "..");
const repositoryRoot = resolve(uiRoot, "..");

test("accepted snapshot preserves the reviewed S6 final state", () => {
  assert.equal(ACCEPTED_SNAPSHOT.dealId, "0x5cf1f030363c28c3fa1862759ccc63b338d0a57fd682d9a6965a61acf93706fc");
  assert.equal(ACCEPTED_SNAPSHOT.status, "PAID_ON_TIME");
  assert.equal(ACCEPTED_SNAPSHOT.fundedAmount, 1_000_001n);
  assert.equal(ACCEPTED_SNAPSHOT.repaidAmount, 1_100_000n);
  assert.equal(ACCEPTED_SNAPSHOT.outstanding, 0n);
  assert.equal(ACCEPTED_SNAPSHOT.exposure, 0n);
  assert.equal(ACCEPTED_SNAPSHOT.scoreBefore, 500);
  assert.equal(ACCEPTED_SNAPSHOT.scoreAfter, 525);
  assert.equal(ACCEPTED_SNAPSHOT.limitAfter, 5_250_000_000n);
});

test("dashboard pins the accepted evidence commit", () => {
  assert.equal(ACCEPTED_EVIDENCE_COMMIT, "f359c54c5647841a08e4e66dec267cf4cbeb110d");
  assert.match(evidenceDocumentUrl("docs/STATUS.md"), new RegExp(ACCEPTED_EVIDENCE_COMMIT));
});

test("fresh v0.4.8 deployment addresses remain exact", () => {
  assert.deepEqual(DEPLOYMENT, {
    chainId: 102031,
    sourceChainId: 11155111,
    gateway: "0x11DD8a4c790939DEa8CED631dB27Afe54334a749",
    verifier: "0xED64f6157408f211dda43649129EaC1F73161093",
    deals: "0x8f7B944653063f43Bb213CE49517f9Bf9fC6A3cC",
    credit: "0x4a66732cA5B7f081585693332C79e636CE9c05C8",
  });
});

test("token formatter preserves six-decimal base-unit precision", () => {
  assert.equal(formatTokenUnits(1_000_001n), "1.000001");
  assert.equal(formatTokenUnits(1_100_000n), "1.1");
  assert.equal(formatTokenUnits(5_250_000_000n), "5,250");
  assert.equal(formatTokenUnits(0n), "0");
});

test("display formatters keep evidence identifiers recognizable", () => {
  assert.equal(shortHex("0x1234567890abcdef"), "0x1234…cdef");
  assert.equal(shortHex("0x1234"), "0x1234");
  assert.equal(formatInteger(340_382), "340,382");
});

test("explorer helpers route source and destination evidence to the right networks", () => {
  assert.equal(
    creditcoinAddressUrl(DEPLOYMENT.credit),
    `https://creditcoin-testnet.blockscout.com/address/${DEPLOYMENT.credit}`,
  );
  assert.equal(
    creditcoinTransactionUrl(LIVE_OPERATIONS[0]?.hash ?? ""),
    `https://creditcoin-testnet.blockscout.com/tx/${LIVE_OPERATIONS[0]?.hash}`,
  );
  assert.equal(
    sepoliaTransactionUrl("0xsource"),
    "https://sepolia.etherscan.io/tx/0xsource",
  );
});

test("evidence ledger distinguishes pending application and the external race", () => {
  assert.equal(LIVE_OPERATIONS.length, 4);
  assert.equal(LIVE_OPERATIONS[0]?.note, "Stored as VERIFIED_PENDING before funding");
  assert.equal(LIVE_OPERATIONS[2]?.action, "applyEvidence");
  assert.equal(LIVE_OPERATIONS[2]?.roots, null);
  assert.equal(LIVE_OPERATIONS[3]?.action, "reconciled");
  assert.equal(LIVE_OPERATIONS[3]?.note, "Worker signed and broadcast nothing");
});

test("snapshot remains frozen across distinguishable live success then RPC failure", async () => {
  const [html, mainSource] = await Promise.all([
    readFile(resolve(uiRoot, "index.html"), "utf8"),
    readFile(resolve(uiRoot, "src/main.ts"), "utf8"),
  ]);
  const snapshotMarkup = html.match(/<article class="deal-terminal"[\s\S]+?<\/article>/)?.[0] ?? "";
  const liveValue: LiveState = {
    chainId: 102031,
    blockNumber: 9_999_999,
    observedAt: new Date("2026-08-21T12:34:56.000Z"),
    borrower: "0x1111111111111111111111111111111111111111",
    designatedInvestor: "0x2222222222222222222222222222222222222222",
    status: "PAID_LATE",
    fundedAmount: 7n,
    repaidAmount: 8n,
    onTimeRepaid: 9n,
    outstanding: 10n,
    score: 321,
    limit: 11n,
    availableLimit: 12n,
    reserved: 13n,
    exposure: 14n,
    repaymentEvidence: "VERIFIED_PENDING",
    raceEvidence: "UNSEEN",
  };
  let readCount = 0;
  const rendered: LiveObservationState[] = [];
  const controller = createLiveRefreshController(
    async () => {
      readCount += 1;
      if (readCount === 1) return liveValue;
      throw new Error("forced transport failure");
    },
    (state) => rendered.push(state),
  );

  await controller.refresh();
  const afterSuccess = controller.getState();
  assert.equal(afterSuccess.kind, "fresh");
  if (afterSuccess.kind !== "fresh") assert.fail("expected fresh live state");
  assert.ok(afterSuccess.lastSuccessful.differences.length >= 10);

  await controller.refresh();
  const afterFailure = controller.getState();
  assert.equal(afterFailure.kind, "stale");
  if (afterFailure.kind !== "stale") assert.fail("expected stale live state");
  assert.equal(afterFailure.lastSuccessful.value.blockNumber, 9_999_999);
  assert.equal(afterFailure.lastSuccessful.value.observedAt.toISOString(), "2026-08-21T12:34:56.000Z");
  assert.equal(afterFailure.error, "forced transport failure");
  assert.ok(rendered.some((state) => state.kind === "fresh"));
  assert.ok(rendered.some((state) => state.kind === "stale"));

  for (const immutableId of ["deal-status", "score-transition", "fold-limit", "fold-exposure", "fold-repaid", "fold-worker"]) {
    assert.doesNotMatch(mainSource, new RegExp(immutableId));
  }
  assert.match(snapshotMarkup, /Accepted snapshot/);
  assert.match(snapshotMarkup, /2026-08-21/);
  assert.match(snapshotMarkup, new RegExp(ACCEPTED_EVIDENCE_COMMIT));
});

test("production contract surface contains exactly the required view methods", async () => {
  const source = await readFile(resolve(uiRoot, "src/rpc.ts"), "utf8");
  const declarations = [...source.matchAll(/"function\s+([^(]+)[^"]+"/g)];
  const methodNames = declarations.map((match) => match[1]).sort();

  assert.deepEqual(methodNames, [
    "availableLimitOf",
    "evidenceStateOf",
    "exposureOf",
    "getDeal",
    "limitOf",
    "outstandingOf",
    "reservedOf",
    "scoreOf",
  ]);
  for (const declaration of declarations) assert.match(declaration[0], /\bview\b/);
});

test("browser production code has no wallet, signer, or transaction submission primitive", async () => {
  const sources = await Promise.all([
    readFile(resolve(uiRoot, "src/main.ts"), "utf8"),
    readFile(resolve(uiRoot, "src/rpc.ts"), "utf8"),
    readFile(resolve(uiRoot, "src/snapshot.ts"), "utf8"),
  ]);
  const production = sources.join("\n");
  const forbidden = [
    /\bWallet\b/,
    /\bSigner\b/,
    /\bBrowserProvider\b/,
    /\bsendTransaction\b/,
    /\bbroadcastTransaction\b/,
    /eth_sendRawTransaction/,
    /eth_sendTransaction/,
    /window\.ethereum/,
    /privateKey/,
  ];

  for (const pattern of forbidden) assert.doesNotMatch(production, pattern);
});

test("page uses semantic structure without interactive protocol controls", async () => {
  const html = await readFile(resolve(uiRoot, "index.html"), "utf8");
  assert.match(html, /<main\b/);
  assert.match(html, /<section\b/);
  assert.match(html, /<article\b/);
  assert.match(html, /<aside\b/);
  assert.match(html, /<table\b/);
  assert.doesNotMatch(html, /<form\b/);
  assert.doesNotMatch(html, /<input\b/);
  assert.doesNotMatch(html, /wallet connect/i);
});

test("product-review evidence and trust boundaries are explicit", async () => {
  const [html, mainSource] = await Promise.all([
    readFile(resolve(uiRoot, "index.html"), "utf8"),
    readFile(resolve(uiRoot, "src/main.ts"), "utf8"),
  ]);
  const visibleText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const hero = html.match(/<section id="outcome" class="hero[\s\S]+?<\/section>/)?.[0] ?? "";

  assert.match(
    hero.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
    /External race · worker signatures 0 · broadcasts 0/,
  );
  assert.match(visibleText, /Independent model × implementation: 63\/63 matched/);
  assert.match(visibleText, /16 independently-derived \+ 47 specification-prescribed/);
  assert.match(
    mainSource,
    /docs\/verification\/v0\.4\.8-phase-b\/README\.md/,
  );
  assert.match(
    visibleText,
    /A deliberately small testnet demonstration deal; the credit limit is protocol state, not the chosen transaction size\./,
  );

  for (const boundary of [
    "Authenticity of the invoice or off-chain obligation",
    "Legal enforceability",
    "Borrower identity",
    "Sybil resistance",
    "Forced collection or escrow enforcement",
  ]) {
    assert.match(visibleText, new RegExp(boundary));
  }

  assert.match(visibleText, /Credit history that follows the borrower across chains/);
  assert.match(visibleText, /Money moves on Ethereum\. Credit state lives on Creditcoin\./);
  for (const firstFoldValue of [
    "PAID_ON_TIME",
    "500 → 525",
    "5,000 → 5,250 USDC",
    "EXPOSURE 0 USDC",
    "REPAID 1.1 / 1.1 USDC",
    "External race · worker signatures 0 · broadcasts 0",
  ]) {
    assert.match(visibleText.toUpperCase(), new RegExp(firstFoldValue.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(visibleText, /Observed during one testnet acceptance run\. Not an SLA\./);
  assert.match(visibleText, /Exact attested-height transition timestamps were not recorded\./);
  for (const interval of ["1,734 s", "720 s", "2,799 s", "651 s"]) assert.match(visibleText, new RegExp(interval));

  const orderedIds = ["outcome", "economic-state", "timeline", "worker", "verification"];
  const positions = orderedIds.map((id) => html.indexOf(`id="${id}"`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);

  assert.match(
    visibleText,
    /Attestcoin proves that the source transaction was included, succeeded, and emitted our configured Gateway event\./,
  );
  assert.match(
    visibleText,
    /The token transfer follows from the verified Gateway code, which emits that event only after a successful transfer\./,
  );
  assert.match(
    visibleText,
    /The credit outcome follows from those verified facts and the attested source height\./,
  );
  assert.match(
    visibleText,
    /Deterministic transitions — contract code and Phase B replay/,
  );
  assert.match(
    visibleText,
    /Worker reconciliation — recorded worker state, not the proof/,
  );
  assert.match(
    visibleText,
    /Runtime bytecode matched after masking immutable slots; constructor wiring was read back from chain\./,
  );
});

test("page loads no remote scripts, stylesheets, fonts, analytics, or CDN assets", async () => {
  const [html, styles] = await Promise.all([
    readFile(resolve(uiRoot, "index.html"), "utf8"),
    readFile(resolve(uiRoot, "src/styles.css"), "utf8"),
  ]);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//i);
  assert.doesNotMatch(html, /google-analytics|googletagmanager|fonts\.googleapis|cdn\./i);
  assert.doesNotMatch(styles, /@import|url\(["']?https?:\/\//i);
});

test("UI has an isolated DOM tsconfig and root TypeScript policy stays server-oriented", async () => {
  const uiConfig = JSON.parse(await readFile(resolve(uiRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions: { lib: string[]; types: string[] };
  };
  const rootConfig = JSON.parse(await readFile(resolve(repositoryRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions: { lib: string[]; types: string[] };
  };

  assert.deepEqual(uiConfig.compilerOptions.lib, ["DOM", "DOM.Iterable", "ES2023"]);
  assert.deepEqual(uiConfig.compilerOptions.types, ["vite/client"]);
  assert.deepEqual(rootConfig.compilerOptions.lib, ["ES2023"]);
  assert.deepEqual(rootConfig.compilerOptions.types, ["node"]);
});

test("Vite production assets are configured for a static subpath", async () => {
  const config = await readFile(resolve(uiRoot, "vite.config.ts"), "utf8");
  assert.match(config, /base:\s*["']\.\/["']/);
});
