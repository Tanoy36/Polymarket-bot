import 'dotenv/config';
import { ethers } from 'ethers';
import { PolymarketSDK } from './src/index.js';
import { PUSD_CONTRACT } from './src/clients/ctf-client.js';

const t0 = Date.now();
const provider = new ethers.providers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com');
const w = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY!, provider);
const pusd = new ethers.Contract(PUSD_CONTRACT, ['function balanceOf(address) view returns (uint256)'], provider);

console.log('wallet :', w.address);
console.log('pUSD   :', ethers.utils.formatUnits(await pusd.balanceOf(w.address), 6));
console.log('MATIC  :', ethers.utils.formatEther(await provider.getBalance(w.address)));
console.log('');

// Exactly the findLiveMarket() logic from test-order.ts - read-only, no orders.
const sdk = await PolymarketSDK.create({ chainId: 137 });
const candidates = await sdk.gammaApi.getMarkets({ limit: 12, active: true, closed: false, order: 'volume24hr', ascending: false });
console.log(`scanning ${candidates.length} candidates...`);

let picked = null;
for (const g of candidates) {
  const cid = (g as any).conditionId; if (!cid) continue;
  try {
    const m = await sdk.markets.getClobMarket(cid);
    if (!m?.acceptingOrders || m.closed || m.tokens.length < 2) continue;
    const b = await sdk.markets.getProcessedOrderbook(cid);
    if (!(b.yes.bid > 0) || !(b.yes.ask > 0)) continue;
    picked = { name: m.question, cid, bid: b.yes.bid, ask: b.yes.ask, token: m.tokens[0].tokenId };
    break;
  } catch { /* next */ }
}

if (!picked) { console.log('NO LIVE MARKET FOUND - script would abort'); process.exit(1); }
const price = Math.max(0.01, picked.bid - 0.05);
console.log(`resolved in ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
console.log('market   :', (picked.name ?? '').slice(0, 60));
console.log('YES book :', picked.bid.toFixed(3), '/', picked.ask.toFixed(3));
console.log('');
console.log('the GTC order YOUR run would place:');
console.log('  BUY 5 shares @ $' + price.toFixed(3) + '  = $' + (5 * price).toFixed(2));
console.log('  ' + (price < picked.bid ? 'below best bid -> rests unfilled, then cancelled' : 'WARNING: at/above bid, could fill'));
