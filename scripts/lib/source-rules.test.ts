/**
 * Rules that are easier to check by reading the sources than by reaching the
 * state that would break them.
 *
 * Two of the specification's invariants are about what the contracts must never
 * consult, not about what they compute. A test that drives the system cannot
 * distinguish "never reads Creditcoin's clock" from "happens not to have read it
 * in this scenario", because the wrong answer only appears when the two clocks
 * disagree, and on a local EVM they always do in the same direction. Grepping
 * the production sources answers it directly.
 *
 * Scoped to `contracts/`. Tests and scripts are free to use anything.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = 'contracts';

function solidityFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...solidityFiles(path));
    else if (entry.endsWith('.sol')) out.push(path);
  }
  return out;
}

/** Strips comments, so that a rule quoted in a doc comment is not a violation. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const sources = solidityFiles(ROOT).map((path) => ({ path, code: code(readFileSync(path, 'utf8')) }));

describe('production sources', () => {
  it('has files to check', () => {
    assert.ok(sources.length >= 5, `expected the production contracts, found ${sources.length} files`);
  });

  /**
   * INV-14, and rule 7. Every deadline in Cr3dX is judged against the attested
   * height of the source chain. Creditcoin's own clock says nothing about
   * Sepolia, and a single use of it would make a deadline decision that no proof
   * backs. `block.chainid` is a different thing and is allowed: it goes into the
   * deal identifier so that a proof aimed at one deployment cannot be replayed
   * against another.
   */
  it('never consults Creditcoin\'s own clock', () => {
    for (const { path, code: body } of sources) {
      assert.equal(/\bblock\s*\.\s*timestamp\b/.test(body), false, `${path} reads block.timestamp`);
      assert.equal(/\bblock\s*\.\s*number\b/.test(body), false, `${path} reads block.number`);
    }
  });

  /**
   * INV-15, and rule 4. `from` and `gasUsed` are signed by the attestors but are
   * not covered by Ethereum's canonical transaction and receipt roots, so
   * calling them proven would overstate the guarantee. `gasUsed` is decoded in
   * one place because ABI decoding is positional, and that decode drops it on
   * the floor: it appears once, as the discarded second field of the receipt
   * chunk, and nowhere else.
   */
  it('never carries gasUsed into a value', () => {
    for (const { path, code: body } of sources) {
      // An identifier followed by `gasUsed` would be a declaration or an
      // assignment. The positional decode writes `(status,, logs,)`, which has
      // no identifier at all.
      assert.equal(
        /\bgasUsed\s*[=)]/.test(body) || /\buint64\s+gasUsed\b/.test(body),
        false,
        `${path} binds gasUsed to a name`,
      );
    }
  });

  /**
   * Rule 10, and INV-7. The absence of an administrative surface is the product,
   * so it is worth failing a build over rather than noticing in review. This
   * catches the shapes such a surface arrives in: an owner, a pause, an upgrade,
   * a rescue, or a setter for something that is supposed to be fixed at
   * construction.
   */
  it('has no administrative surface', () => {
    const forbidden: [RegExp, string][] = [
      [/\bfunction\s+set[A-Z]/, 'a setter'],
      [/\bonlyOwner\b/, 'an owner modifier'],
      [/\bfunction\s+(pause|unpause)\b/, 'a pause switch'],
      [/\bfunction\s+(upgradeTo|initialize)\b/, 'an upgrade or initialiser'],
      [/\bselfdestruct\b/, 'selfdestruct'],
      [/\bfunction\s+(rescue|sweep|withdraw)[A-Za-z]*\s*\(/, 'a rescue path'],
      [/\bfunction\s+(cancel|releaseReserve)[A-Za-z]*\s*\(/, 'a cancellation or reserve release'],
    ];
    for (const { path, code: body } of sources) {
      for (const [pattern, what] of forbidden) {
        assert.equal(pattern.test(body), false, `${path} declares ${what}`);
      }
    }
  });

  /**
   * Rule 2. The BlockProver precompile returns true or reverts; it never returns
   * false. Branching on its result would be a branch that cannot be reached,
   * which reads as a safety net and is not one.
   */
  it('does not branch on the result of verify', () => {
    for (const { path, code: body } of sources) {
      assert.equal(/(if|require|assert)\s*\([^;]*\.verify\s*\(/.test(body), false, `${path} branches on verify`);
    }
  });
});
