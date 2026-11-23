import { describe, it, expect } from "vitest";
import { hex } from "@scure/base";
import {
  buildBtcTransaction,
  type BuildBtcTransactionOptions,
} from "../../src/transactions/bitcoin-builder.js";
import type { UTXO } from "../../src/services/mempool-api.js";
import { deriveBitcoinKeyPair } from "../../src/utils/bitcoin.js";

/**
 * Regression tests: the up-front sufficiency check in buildBtcTransaction
 * must price the fee for the UTXOs the coin selector will actually spend,
 * not for every confirmed UTXO in the wallet. A wallet holding one large
 * UTXO plus many dust UTXOs must still be able to send an amount the large
 * UTXO alone covers, even at a high fee rate.
 */
describe("buildBtcTransaction with dust-heavy UTXO sets", () => {
  // Test mnemonic from BIP84 test vectors (same as bitcoin-builder.test.ts)
  const TEST_MNEMONIC =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const testKeyPair = deriveBitcoinKeyPair(TEST_MNEMONIC, "mainnet");
  const testPubKey = hex.decode(testKeyPair.publicKey);
  const senderAddress = testKeyPair.address;

  const utxo = (txidByte: string, vout: number, value: number): UTXO => ({
    txid: txidByte.repeat(32),
    vout,
    value,
    status: { confirmed: true, block_height: 800000 },
  });

  const dustUtxos = (count: number): UTXO[] =>
    Array.from({ length: count }, (_, i) =>
      utxo((0x10 + (i % 200)).toString(16).padStart(2, "0"), i, 546)
    );

  function build(utxos: UTXO[], amount: number, feeRate: number) {
    const options: BuildBtcTransactionOptions = {
      utxos,
      recipient: senderAddress,
      amount,
      feeRate,
      senderPubKey: testPubKey,
      senderAddress,
      network: "mainnet",
    };
    return buildBtcTransaction(options);
  }

  it("sends using only the large UTXO when dust UTXOs inflate the all-UTXO fee estimate", () => {
    // 1 x 1,000,000 sats + 500 x 546 sats dust = 1,273,000 sats total.
    // Pricing a fee for all 501 inputs at 100 sat/vB costs 3,414,050 sats,
    // more than the wallet holds — but the large UTXO alone covers the send:
    // fee for 1 input / 2 outputs = ceil(140.5 * 100) = 14,050 sats.
    const utxos = [utxo("aa", 0, 1_000_000), ...dustUtxos(500)];

    const result = build(utxos, 900_000, 100);

    expect(result.inputUtxos).toHaveLength(1);
    expect(result.inputUtxos[0].value).toBe(1_000_000);
    expect(result.fee).toBe(14_050);
    expect(result.change).toBe(85_950);
  });

  it("sends using only the large UTXO with 50 dust UTXOs at 50 sat/vB", () => {
    // 1 x 200,000 + 50 x 546 = 227,300 sats total. All-51-inputs fee at
    // 50 sat/vB is 177,025 sats, so an all-UTXO pre-check rejects a
    // 150,000-sat send the large UTXO covers on its own (fee 7,025).
    const utxos = [utxo("bb", 0, 200_000), ...dustUtxos(50)];

    const result = build(utxos, 150_000, 50);

    expect(result.inputUtxos).toHaveLength(1);
    expect(result.fee).toBe(7_025);
    expect(result.change).toBe(42_975);
  });

  it("still throws when funds are genuinely insufficient", () => {
    const utxos = [utxo("cc", 0, 10_000)];

    expect(() => build(utxos, 9_900, 100)).toThrow(/Insufficient funds/);
  });
});
