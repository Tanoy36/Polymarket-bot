#!/usr/bin/env npx tsx
/**
 * CLOB V2 approval setup
 *
 * Polymarket's April 28, 2026 migration deployed NEW Exchange contracts and
 * switched collateral from USDC.e to pUSD. Approvals granted to the old V1
 * Exchange addresses do NOT carry over - every wallet must re-approve the V2
 * contracts before it can trade.
 *
 * Two kinds of approval are required:
 *   - ERC20  (pUSD)              -> lets the Exchange spend your collateral (BUY)
 *   - ERC1155 (conditional tokens) -> lets the Exchange move your outcome
 *                                     tokens (SELL / merge / redeem)
 * Missing the ERC1155 side is the common trap: you can open a position and
 * then find you cannot sell it.
 *
 * Usage:
 *   npx tsx scripts/approvals/setup-v2-approvals.ts            # check only (no transactions)
 *   npx tsx scripts/approvals/setup-v2-approvals.ts approve    # send approval transactions
 *
 * Reads POLYMARKET_PRIVATE_KEY from the repo-root .env (or the environment).
 * Requires MATIC for gas. Approvals are unlimited (MaxUint256) and idempotent -
 * anything already approved is skipped.
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import { AuthorizationService } from '../../src/services/authorization-service.js';

const RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com';

async function main() {
  const command = process.argv[2] || 'check';

  const privateKey =
    process.env.POLYMARKET_PRIVATE_KEY || process.env.POLY_PRIVKEY || process.env.PRIVATE_KEY || '';
  if (!privateKey) {
    console.error('Error: POLYMARKET_PRIVATE_KEY not set (checked .env and environment)');
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(privateKey, provider);
  const auth = new AuthorizationService(signer, { provider });

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║              POLYMARKET CLOB V2 APPROVAL SETUP                 ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Wallet: ${auth.walletAddress}`);
  console.log(`RPC:    ${RPC_URL}`);
  console.log('');

  console.log('─── Current Status ───');
  const status = await auth.checkAllowances();
  console.log(`pUSD balance: ${status.usdcBalance}`);
  console.log('');
  console.log('ERC20 (pUSD spending):');
  for (const a of status.erc20Allowances) {
    console.log(`  ${a.approved ? '✓' : '✗'} ${a.contract}`);
  }
  console.log('ERC1155 (conditional tokens):');
  for (const a of status.erc1155Approvals) {
    console.log(`  ${a.approved ? '✓' : '✗'} ${a.contract}`);
  }
  console.log('');
  console.log(`Trading ready: ${status.tradingReady ? 'YES' : 'NO'}`);
  if (status.issues.length > 0) {
    console.log('Issues:');
    for (const i of status.issues) console.log(`  - ${i}`);
  }
  console.log('');

  if (command !== 'approve') {
    if (!status.tradingReady) {
      console.log('Run with "approve" to grant the missing approvals:');
      console.log('  npx tsx scripts/approvals/setup-v2-approvals.ts approve');
    }
    return;
  }

  if (status.tradingReady) {
    console.log('Nothing to do - all approvals already granted.');
    return;
  }

  const maticBalance = await provider.getBalance(auth.walletAddress);
  console.log(`MATIC for gas: ${ethers.utils.formatEther(maticBalance)}`);
  if (maticBalance.isZero()) {
    console.error('Error: no MATIC for gas. Fund the wallet before approving.');
    process.exit(1);
  }

  console.log('');
  console.log('─── Sending Approvals (real transactions) ───');
  const result = await auth.approveAll();

  for (const r of [...result.erc20Approvals, ...result.erc1155Approvals]) {
    if (r.success) {
      console.log(`  ✓ ${r.contract}${r.txHash ? ` (${r.txHash})` : ' (already approved)'}`);
    } else {
      console.log(`  ✗ ${r.contract}: ${r.error}`);
    }
  }

  console.log('');
  console.log(result.summary);

  console.log('');
  console.log('─── Verifying ───');
  const after = await auth.checkAllowances();
  console.log(`Trading ready: ${after.tradingReady ? 'YES' : 'NO'}`);
  if (!after.tradingReady) {
    for (const i of after.issues) console.log(`  - ${i}`);
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
