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

// 使用一个活跃的市场进行测试 - NVIDIA market cap
const TEST_MARKET = {
  name: 'NVIDIA largest company by market cap on Dec 31',
  conditionId: '0x0b16eb7741855ca3d4383fabb8b760c897c2165d603916497f484b87ba9826dc',
  yesTokenId: '94850533403292240972948844256810904078895883844462287088135166537739765648754',
  noTokenId: '69263280792958981516606123639467754139758192236863611059536531765186180114584',
};

const TEST_AMOUNT = 5; // 5 USDC 测试 (Polymarket 最小订单量是 5 份)

async function main() {
  if (!PRIVATE_KEY) {
    console.error('Error: Set POLY_PRIVKEY environment variable');
    process.exit(1);
  }

  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║       ORDER TYPE TEST - GTC vs FOK                              ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Market: ${TEST_MARKET.name}`);
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
  const marketService = new MarketService(
    new GammaApiClient(rateLimiter, cache),
    new DataApiClient(rateLimiter, cache),
    rateLimiter,
    cache,
    { chainId: 137 }
  );
  const orderbook = await marketService.getProcessedOrderbook(TEST_MARKET.conditionId);
  const bestBid = orderbook.yes.bid || 0;
  const bestAsk = orderbook.yes.ask || 1;
  console.log(`Current YES price: ${bestBid.toFixed(3)} / ${bestAsk.toFixed(3)}`);
  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 1: GTC Limit Order (这是 Earning Engine 使用的方式)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('TEST 1: GTC Limit Order (Earning Engine 方式)');
  console.log('═══════════════════════════════════════════════════════════════');

  // 尝试以低于市价的价格买入 (maker order)
  const gtcBuyPrice = Math.max(0.01, bestBid - 0.05); // 低于最佳买价 5 cents
  const gtcSize = Math.max(5, TEST_AMOUNT / gtcBuyPrice); // 最小 5 份

  console.log(`Placing GTC BUY order: ${gtcSize.toFixed(2)} shares @ $${gtcBuyPrice.toFixed(3)}`);
  console.log(`Expected cost: $${(gtcSize * gtcBuyPrice).toFixed(2)}`);

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
      console.log(`❌ GTC Order FAILED: ${gtcResult.errorMsg}`);
    }
  } catch (error: any) {
    console.log(`❌ GTC Order ERROR: ${error.message}`);
  }

  console.log('');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST 2: FOK Market Order (这是套利脚本使用的方式)
  // ═══════════════════════════════════════════════════════════════════════════
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
