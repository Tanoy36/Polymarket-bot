#!/usr/bin/env npx tsx
/**
 * Test Order Script - 测试下单功能
 *
 * 测试 GTC 限价单 vs FOK 市价单的区别
 *
 * Usage:
 *   POLY_PRIVKEY=0x... npx tsx scripts/trading/test-order.ts
 */

import {
  TradingService,
  MarketService,
  GammaApiClient,
  DataApiClient,
  RateLimiter,
  createUnifiedCache,
} from '../../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Private key: POLY_PRIVKEY / POLYMARKET_PRIVATE_KEY env var, falling back to
// the repo-root .env. (The old hardcoded ../../earning-engine/... path does not
// exist in this repo and made the script throw before it could run.)
function readKeyFromEnvFile(): string {
  for (const p of [
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../../earning-engine/dashboard-api/.env'),
  ]) {
    if (!fs.existsSync(p)) continue;
    const m = fs
      .readFileSync(p, 'utf8')
      .match(/^(?:POLYMARKET_PRIVATE_KEY|PRIVATE_KEY)=(.+)$/m);
    if (m) return m[1].trim();
  }
  return '';
}

const PRIVATE_KEY =
  process.env.POLY_PRIVKEY || process.env.POLYMARKET_PRIVATE_KEY || readKeyFromEnvFile();

// The market to test against is discovered at runtime.
//
// This used to be a hardcoded NVIDIA market that resolved on 2025-12-31. Once
// it closed, its orderbook was empty, so the script read a 0.000/1.000 price,
// priced a GTC order at $0.01 x 500 shares, and reported "no match" on the FOK
// leg - all of which looked like a wallet/auth failure but was only a dead
// market. Always resolve a live, order-accepting market instead.
interface TestMarket {
  name: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
}

const TEST_AMOUNT = 5; // 5 USDC 测试 (Polymarket 最小订单量是 5 份)

/**
 * Find an active market that is accepting orders and has a real orderbook.
 *
 * Takes the plain API clients rather than a full PolymarketSDK: constructing
 * the SDK opens realtime WebSockets, whose reconnect timers keep the Node
 * process alive after the script finishes its work, so the script appears to
 * hang once the orders are done.
 */
async function findLiveMarket(
  gammaApi: GammaApiClient,
  marketService: MarketService
): Promise<TestMarket | null> {
  // Keep this small: each candidate costs two API calls, so a large list makes
  // the script feel slow before it places anything.
  const candidates = await gammaApi.getMarkets({
    limit: 12,
    active: true,
    closed: false,
    order: 'volume24hr',
    ascending: false,
  });

  for (const g of candidates) {
    const conditionId = (g as unknown as { conditionId?: string }).conditionId;
    if (!conditionId) continue;
    try {
      const m = await marketService.getClobMarket(conditionId);
      if (!m?.acceptingOrders || m.closed || m.tokens.length < 2) continue;

      const book = await marketService.getProcessedOrderbook(conditionId);
      // Need a two-sided book to price a resting order sensibly.
      if (!(book.yes.bid > 0) || !(book.yes.ask > 0)) continue;

      // Require a mid-range, reasonably tight book. Penny markets (e.g. a
      // 0.003/0.009 book) leave no room to rest an order below the bid without
      // hitting the 0.01 tick floor - which would price the "safe" test order
      // ABOVE the ask and fill it immediately as a taker.
      if (book.yes.bid < 0.10 || book.yes.bid > 0.90) continue;
      if (book.yes.ask - book.yes.bid > 0.10) continue;

      return {
        name: m.question ?? g.question ?? 'unknown',
        conditionId,
        yesTokenId: m.tokens[0].tokenId,
        noTokenId: m.tokens[1].tokenId,
      };
    } catch {
      // Market lookup or book fetch failed - try the next candidate.
    }
  }
  return null;
}

async function main() {
  if (!PRIVATE_KEY) {
    console.error('Error: Set POLY_PRIVKEY environment variable');
    process.exit(1);
  }

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       ORDER TYPE TEST - GTC vs FOK                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Test Amount: $${TEST_AMOUNT} USDC`);
  console.log('');

  const rateLimiter = new RateLimiter();
  const cache = createUnifiedCache();
  const tradingService = new TradingService(rateLimiter, cache, {
    privateKey: PRIVATE_KEY,
    chainId: 137,
  });

  await tradingService.initialize();
  console.log(`Wallet: ${tradingService.getAddress()}`);

  // 获取当前余额
  const { balance, allowance } = await tradingService.getBalanceAllowance('COLLATERAL');
  console.log(`USDC Balance: ${(parseFloat(balance) / 1e6).toFixed(2)} USDC`);
  console.log(`Allowance: ${allowance === 'unlimited' || parseFloat(allowance) / 1e6 > 1e12 ? 'Unlimited' : (parseFloat(allowance) / 1e6).toFixed(2)}`);
  console.log('');

  // 获取当前市场价格 (orderbook 数据在 MarketService 上, 按 conditionId 查询)
  const gammaApi = new GammaApiClient(rateLimiter, cache);
  const marketService = new MarketService(
    gammaApi,
    new DataApiClient(rateLimiter, cache),
    rateLimiter,
    cache,
    { chainId: 137 }
  );
  console.log('Finding a live market that is accepting orders...');
  const TEST_MARKET = await findLiveMarket(gammaApi, marketService);
  if (!TEST_MARKET) {
    console.error('No live market with a two-sided orderbook found - aborting.');
    process.exit(1);
  }
  console.log(`Market: ${TEST_MARKET.name}`);
  console.log(`  conditionId: ${TEST_MARKET.conditionId}`);
  console.log('');

  const orderbook = await marketService.getProcessedOrderbook(TEST_MARKET.conditionId);
  const bestBid = orderbook.yes.bid || 0;
  const bestAsk = orderbook.yes.ask || 1;
  console.log(`Current YES price: ${bestBid.toFixed(3)} / ${bestAsk.toFixed(3)}`);
  if (!(bestBid > 0)) {
    console.error('Orderbook has no bids - aborting rather than pricing off an empty book.');
    process.exit(1);
  }
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: GTC Limit Order (这是 Earning Engine 使用的方式)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 1: GTC Limit Order (Earning Engine 方式)');
  console.log('═══════════════════════════════════════════════════════════════');

  // 尝试以低于市价的价格买入 (maker order)
  // Exactly 5 shares - Polymarket's minimum order size. Sizing this by
  // TEST_AMOUNT/price would commit the whole test budget to a resting order
  // for no extra diagnostic value; 5 shares proves the same round-trip.
  const gtcBuyPrice = Math.max(0.01, bestBid - 0.05); // 低于最佳买价 5 cents
  const gtcSize = 5;

  // Refuse to send an order that would cross the book. The clamp above pins the
  // price at the 0.01 tick floor on low-priced markets, which can land at or
  // above the ask - the order would fill instantly instead of resting, turning
  // a cancellable test into a real position.
  if (gtcBuyPrice >= bestBid || gtcBuyPrice >= bestAsk) {
    console.error(`Refusing to place: computed price $${gtcBuyPrice.toFixed(3)} is not below the book (bid $${bestBid.toFixed(3)} / ask $${bestAsk.toFixed(3)}).`);
    console.error('This order would fill immediately rather than rest. Aborting.');
    process.exit(1);
  }

  console.log(`Placing GTC BUY order: ${gtcSize.toFixed(2)} shares @ $${gtcBuyPrice.toFixed(3)}`);
  console.log(`Expected cost: $${(gtcSize * gtcBuyPrice).toFixed(2)}`);
  console.log(`(resting $${(bestBid - gtcBuyPrice).toFixed(3)} below best bid - should not fill)`);

  try {
    const gtcResult = await tradingService.createLimitOrder({
      tokenId: TEST_MARKET.yesTokenId,
      side: 'BUY',
      price: gtcBuyPrice,
      size: gtcSize,
      orderType: 'GTC',
    });

    if (gtcResult.success) {
      console.log(`✅ GTC Order SUCCESS!`);
      console.log(`   Order ID: ${gtcResult.orderId}`);

      // 立即取消订单
      console.log('   Cancelling order...');
      const cancelResult = await tradingService.cancelOrder(gtcResult.orderId!);
      console.log(`   Cancel: ${cancelResult.success ? '✓' : '✗'}`);
    } else {
      // errorMsg is sometimes absent on a rejection - dump the whole response
      // so the failure is diagnosable instead of printing "undefined".
      console.log(`❌ GTC Order FAILED: ${gtcResult.errorMsg ?? '(no errorMsg)'}`);
      console.log(`   full response: ${JSON.stringify(gtcResult)}`);
    }
  } catch (error: any) {
    console.log(`❌ GTC Order ERROR: ${error.message}`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: FOK Market Order (这是套利脚本使用的方式)
  // ═══════════════════════════════════════════════════════════════════════════
  // A FOK market order fills IMMEDIATELY and spends real funds - unlike the GTC
  // leg above, it cannot be cancelled. Opt in explicitly with --fok.
  if (!process.argv.includes('--fok')) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TEST 2: FOK Market Order - SKIPPED');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`This leg spends $${TEST_AMOUNT} of real funds and fills instantly.`);
    console.log('Re-run with --fok to include it:');
    console.log('  npx tsx scripts/trading/test-order.ts --fok');
    console.log('');
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 2: FOK Market Order (套利脚本方式)');
  console.log('═══════════════════════════════════════════════════════════════');

  console.log(`Placing FOK BUY order: $${TEST_AMOUNT} USDC worth`);

  try {
    const fokResult = await tradingService.createMarketOrder({
      tokenId: TEST_MARKET.yesTokenId,
      side: 'BUY',
      amount: TEST_AMOUNT,
      orderType: 'FOK',
    });

    if (fokResult.success) {
      console.log(`✅ FOK Order SUCCESS!`);
      console.log(`   Order ID: ${fokResult.orderId}`);

      // 等待一下让订单成交
      await new Promise((r) => setTimeout(r, 2000));

      // 检查持仓并卖出
      console.log('   Selling back...');
      const sellResult = await tradingService.createMarketOrder({
        tokenId: TEST_MARKET.yesTokenId,
        side: 'SELL',
        amount: TEST_AMOUNT * 0.95, // 卖出略少一点确保成功
        orderType: 'FOK',
      });
      console.log(`   Sell: ${sellResult.success ? '✓' : '✗'} ${sellResult.errorMsg || ''}`);
    } else {
      console.log(`❌ FOK Order FAILED: ${fokResult.errorMsg}`);
    }
  } catch (error: any) {
    console.log(`❌ FOK Order ERROR: ${error.message}`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('如果 GTC 失败但 FOK 成功，说明:');
  console.log('  - Polymarket 对 GTC 限价单有不同的余额要求');
  console.log('  - 可能需要通过 Polymarket UI 存入资金');
  console.log('  - 或者 Earning Engine 应该改用 FOK 市价单');
  console.log('');
  console.log('如果两个都失败，说明:');
  console.log('  - 钱包配置可能有问题');
  console.log('  - 需要检查 API Key 或签名');
  console.log('');
}

main().catch(console.error);
