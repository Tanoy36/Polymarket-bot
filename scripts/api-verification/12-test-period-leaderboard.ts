/**
 * 测试时间段排行榜功能
 * - getLeaderboardByPeriod: 按时间段获取排行榜
 * - getWalletStatsByPeriod: 按时间段获取单个钱包统计
 */

import { PolymarketSDK } from '../../src/index.js';

const TEST_ADDRESS = '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74';

async function main(): Promise<void> {
  console.log('🧪 测试时间段排行榜功能\n');

  const sdk = new PolymarketSDK();

  // ===== 1. 测试时间段排行榜 =====
  console.log('='.repeat(60));
  console.log('📊 1. 时间段排行榜 (getLeaderboardByPeriod)');
  console.log('='.repeat(60));

  const periods = ['day', 'week', 'month'] as const;

  for (const period of periods) {
    console.log(`\n📌 Period: ${period}`);
    const start = Date.now();

    try {
      const leaderboard = await sdk.wallets.getLeaderboardByPeriod(period, 5);
      console.log(`  ⏱️ 耗时: ${Date.now() - start}ms`);
      console.log(`  📈 Top ${leaderboard.length} traders:`);

      leaderboard.forEach((entry, i) => {
        console.log(`    ${i + 1}. ${entry.address.slice(0, 10)}... Volume: $${entry.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
        console.log(`       Trades: ${entry.tradeCount} | Maker: $${entry.makerVolume.toFixed(2)} | Taker: $${entry.takerVolume.toFixed(2)}`);
      });
    } catch (error) {
      console.log(`  ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ===== 2. 测试单个钱包时间段统计 =====
  console.log('\n' + '='.repeat(60));
  console.log('📊 2. 钱包时间段统计 (getWalletStatsByPeriod)');
  console.log('='.repeat(60));

  console.log(`\n📌 Wallet: ${TEST_ADDRESS}`);

  for (const period of periods) {
    console.log(`\n  📅 Period: ${period}`);
    const start = Date.now();

    try {
      const stats = await sdk.wallets.getWalletStatsByPeriod(TEST_ADDRESS, period);
      console.log(`    ⏱️ 耗时: ${Date.now() - start}ms`);
      console.log(`    📈 Volume: $${stats.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
      console.log(`    📊 Trades: ${stats.tradeCount} (Maker: ${stats.makerCount}, Taker: ${stats.takerCount})`);
      console.log(`    🔄 On-chain: Splits: ${stats.splitCount}, Merges: ${stats.mergeCount}, Redemptions: ${stats.redemptionCount}`);
      if (stats.redemptionPayout > 0) {
        console.log(`    💰 Redemption Payout: $${stats.redemptionPayout.toFixed(2)}`);
      }
    } catch (error) {
      console.log(`    ❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ===== 3. 对比全时间排行榜 =====
  console.log('\n' + '='.repeat(60));
  console.log('📊 3. 对比: 全时间 vs 本周排行榜');
  console.log('='.repeat(60));

  try {
    const [allTime, weekly] = await Promise.all([
      sdk.dataApi.fetchLeaderboard({ limit: 5 }),
      sdk.wallets.getLeaderboardByPeriod('week', 5),
    ]);

    console.log('\n📌 全时间排行榜 (Data API):');
    allTime.entries.forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.address.slice(0, 10)}... PnL: $${e.pnl.toLocaleString()}`);
    });

    console.log('\n📌 本周排行榜 (Subgraph):');
    weekly.forEach((e, i) => {
      console.log(`  ${i + 1}. ${e.address.slice(0, 10)}... Volume: $${e.volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
    });
  } catch (error) {
    console.log(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
  }

  // ===== 4. 缓存测试 =====
  console.log('\n' + '='.repeat(60));
  console.log('📊 4. 缓存测试');
  console.log('='.repeat(60));

  console.log('\n📌 第一次请求 (无缓存):');
  const start1 = Date.now();
  await sdk.wallets.getLeaderboardByPeriod('day', 3);
  console.log(`  ⏱️ 耗时: ${Date.now() - start1}ms`);

  console.log('\n📌 第二次请求 (有缓存):');
  const start2 = Date.now();
  await sdk.wallets.getLeaderboardByPeriod('day', 3);
  console.log(`  ⏱️ 耗时: ${Date.now() - start2}ms`);

  console.log('\n✅ 测试完成');
}

main().catch(console.error);
