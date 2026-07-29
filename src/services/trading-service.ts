/**
 * TradingService
 *
 * Trading service using official @polymarket/clob-client-v2 (Polymarket CLOB V2, live since
 * April 28, 2026). The legacy @polymarket/clob-client (V1) package no longer works against
 * production - see https://docs.polymarket.com/v2-migration.
 *
 * Provides:
 * - Order creation (limit, market)
 * - Order management (cancel, query)
 * - Rewards tracking
 * - Balance management
 *
 * Note: Market data methods have been moved to MarketService.
 */

import {
  ClobClient,
  Side as ClobSide,
  OrderType as ClobOrderType,
  Chain,
  type OpenOrder,
  type Trade as ClobTrade,
  type TickSize,
} from '@polymarket/clob-client-v2';

import { Wallet } from 'ethers';
import { RateLimiter, ApiType } from '../core/rate-limiter.js';
import type { UnifiedCache } from '../core/unified-cache.js';
import { CACHE_TTL } from '../core/unified-cache.js';
import { PolymarketError, ErrorCode } from '../core/errors.js';
import type { Side, OrderType } from '../core/types.js';

// Chain IDs
export const POLYGON_MAINNET = 137;
export const POLYGON_AMOY = 80002;

// CLOB Host (unchanged in V2 - production traffic now runs V2 at the same host)
const CLOB_HOST = 'https://clob.polymarket.com';

// ============================================================================
// Polymarket Order Minimums
// ============================================================================
// These are enforced by Polymarket's CLOB API. Orders below these limits will
// be rejected with errors like:
// - "invalid amount for a marketable BUY order ($X), min size: $1"
// - "Size (X) lower than the minimum: 5"
//
// Strategies should ensure orders meet these requirements BEFORE sending.
// ============================================================================

/** Minimum order value in USDC (price * size >= MIN_ORDER_VALUE) */
export const MIN_ORDER_VALUE_USDC = 1;

/** Minimum order size in shares */
export const MIN_ORDER_SIZE_SHARES = 5;

/**
 * Signature type used to sign orders.
 *
 * - 0 = EOA: the signer trades directly with its own wallet (no funder wallet).
 *   This is the historical default for this bot and remains the default here -
 *   if you don't set FUNDER_ADDRESS/SIGNATURE_TYPE in .env, behavior is 100%
 *   unchanged from previous versions.
 * - 1 = POLY_PROXY: legacy Polymarket proxy wallet (Magic Link / email login)
 * - 2 = GNOSIS_SAFE: legacy Safe wallet (created with MetaMask/Rabby on polymarket.com)
 * - 3 = POLY_1271 / Deposit Wallet: current default smart wallet for accounts
 *   created on or after May 4, 2026. Requires FUNDER_ADDRESS to be set to the
 *   Deposit Wallet address shown in your Polymarket profile.
 *
 * @see https://docs.polymarket.com/trading/wallets-auth
 */
export type PolymarketSignatureType = 0 | 1 | 2 | 3;

// ============================================================================
// Types
// ============================================================================

// Side and OrderType are imported from core/types.ts
// Re-export for backward compatibility
export type { Side, OrderType } from '../core/types.js';

export interface ApiCredentials {
  key: string;
  secret: string;
  passphrase: string;
}

export interface TradingServiceConfig {
  /** Private key for signing */
  privateKey: string;
  /** Chain ID (default: Polygon mainnet 137) */
  chainId?: number;
  /** Pre-generated API credentials (optional) */
  credentials?: ApiCredentials;
  /**
   * Address that funds/holds the trade (Deposit Wallet / Proxy / Safe address).
   * Optional - if omitted, the signer trades directly (signatureType 0, EOA),
   * exactly like every previous version of this bot. Only set this if your
   * Polymarket account wallet is different from the signer's own address
   * (e.g. you log in via email/Magic Link, or use a Deposit Wallet).
   * Sourced from env var FUNDER_ADDRESS.
   */
  funderAddress?: string;
  /**
   * Signature type matching funderAddress's wallet type. Only meaningful when
   * funderAddress is set. Sourced from env var SIGNATURE_TYPE (defaults to 0).
   */
  signatureType?: PolymarketSignatureType;
  /**
   * Optional builder code (V2 builder attribution). Replaces the old
   * POLY_BUILDER_* HMAC header flow. Sourced from env var POLY_BUILDER_CODE.
   * Purely additive - omit for identical behavior to previous versions.
   */
  builderCode?: string;
}

// Order types
export interface LimitOrderParams {
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  orderType?: 'GTC' | 'GTD';
  expiration?: number;
  /** Optional per-order builder code override (V2). */
  builderCode?: string;
}

export interface MarketOrderParams {
  tokenId: string;
  side: Side;
  amount: number;
  price?: number;
  orderType?: 'FOK' | 'FAK';
  /** Optional per-order builder code override (V2). */
  builderCode?: string;
  /**
   * Optional wallet USDC/pUSD balance so the V2 SDK can compute fee-adjusted
   * fill amounts on market BUY orders. Purely additive/optional.
   */
  userUSDCBalance?: number;
}

export interface Order {
  id: string;
  status: string;
  tokenId: string;
  side: Side;
  price: number;
  originalSize: number;
  filledSize: number;
  remainingSize: number;
  associateTrades: string[];
  createdAt: number;
}

export interface OrderResult {
  success: boolean;
  orderId?: string;
  orderIds?: string[];
  errorMsg?: string;
  transactionHashes?: string[];
}

export interface TradeInfo {
  id: string;
  tokenId: string;
  side: Side;
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

// Rewards types
export interface UserEarning {
  date: string;
  conditionId: string;
  assetAddress: string;
  makerAddress: string;
  earnings: number;
  assetRate: number;
}

export interface MarketReward {
  conditionId: string;
  question: string;
  marketSlug: string;
  eventSlug: string;
  rewardsMaxSpread: number;
  rewardsMinSize: number;
  tokens: Array<{ tokenId: string; outcome: string; price: number }>;
  rewardsConfig: Array<{
    assetAddress: string;
    startDate: string;
    endDate: string;
    ratePerDay: number;
    totalRewards: number;
  }>;
}

// ============================================================================
// TradingService Implementation
// ============================================================================

export class TradingService {
  private clobClient: ClobClient | null = null;
  private wallet: Wallet;
  private chainId: Chain;
  private credentials: ApiCredentials | null = null;
  private funderAddress?: string;
  private signatureType: PolymarketSignatureType;
  private builderCode?: string;
  private initialized = false;
  private tickSizeCache: Map<string, string> = new Map();
  private negRiskCache: Map<string, boolean> = new Map();

  constructor(
    private rateLimiter: RateLimiter,
    private cache: UnifiedCache,
    private config: TradingServiceConfig
  ) {
    this.wallet = new Wallet(config.privateKey);
    this.chainId = (config.chainId || POLYGON_MAINNET) as Chain;
    this.credentials = config.credentials || null;
    // Additive: only used if explicitly configured. Omitting these keeps the
    // exact previous behavior (signer trades directly, signatureType 0).
    this.funderAddress = config.funderAddress;
    this.signatureType = config.signatureType ?? 0;
    this.builderCode = config.builderCode;
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create CLOB client with L1 auth (wallet) - V2 options-object constructor.
    this.clobClient = new ClobClient({
      host: CLOB_HOST,
      chain: this.chainId,
      signer: this.wallet,
      ...(this.funderAddress ? { funderAddress: this.funderAddress, signatureType: this.signatureType } : {}),
      ...(this.builderCode ? { builderConfig: { builderCode: this.builderCode } } : {}),
    });

    // Get or create API credentials
    // We use derive-first strategy (opposite of official createOrDeriveApiKey)
    // because most users already have a key, avoiding unnecessary 400 error logs.
    // Note: L1/L2 auth is unchanged in CLOB V2 - existing API keys keep working.
    if (!this.credentials) {
      const creds = await this.deriveOrCreateApiKey();
      this.credentials = {
        key: creds.key,
        secret: creds.secret,
        passphrase: creds.passphrase,
      };
    }

    // Re-initialize with L2 auth (credentials)
    this.clobClient = new ClobClient({
      host: CLOB_HOST,
      chain: this.chainId,
      signer: this.wallet,
      creds: {
        key: this.credentials.key,
        secret: this.credentials.secret,
        passphrase: this.credentials.passphrase,
      },
      ...(this.funderAddress ? { funderAddress: this.funderAddress, signatureType: this.signatureType } : {}),
      ...(this.builderCode ? { builderConfig: { builderCode: this.builderCode } } : {}),
    });

    this.initialized = true;
  }

  /**
   * Try to derive existing API key first, create new one if not exists.
   * This is the reverse of official createOrDeriveApiKey() to avoid
   * 400 "Could not create api key" error log for existing keys.
   */
  private async deriveOrCreateApiKey(): Promise<{ key: string; secret: string; passphrase: string }> {
    // First try to derive existing key (most common case for existing users)
    const derived = await this.clobClient!.deriveApiKey();
    if (derived.key) {
      return derived;
    }

    // Derive failed (key doesn't exist), create new key (first-time users)
    const created = await this.clobClient!.createApiKey();
    if (!created.key) {
      throw new PolymarketError(
        ErrorCode.AUTH_FAILED,
        'Failed to create or derive API key. Wallet may not be registered on Polymarket.'
      );
    }
    return created;
  }

  private async ensureInitialized(): Promise<ClobClient> {
    if (!this.initialized || !this.clobClient) {
      await this.initialize();
    }
    return this.clobClient!;
  }

  // ============================================================================
  // Trading Helpers
  // ============================================================================

  /**
   * Get tick size for a token
   */
  async getTickSize(tokenId: string): Promise<TickSize> {
    if (this.tickSizeCache.has(tokenId)) {
      return this.tickSizeCache.get(tokenId)! as TickSize;
    }

    const client = await this.ensureInitialized();
    const tickSize = await client.getTickSize(tokenId);
    this.tickSizeCache.set(tokenId, tickSize);
    return tickSize;
  }

  /**
   * Check if token is neg risk
   */
  async isNegRisk(tokenId: string): Promise<boolean> {
    if (this.negRiskCache.has(tokenId)) {
      return this.negRiskCache.get(tokenId)!;
    }

    const client = await this.ensureInitialized();
    const negRisk = await client.getNegRisk(tokenId);
    this.negRiskCache.set(tokenId, negRisk);
    return negRisk;
  }

  // ============================================================================
  // Order Creation
  // ============================================================================

  /**
   * Create and post a limit order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum size: 5 shares (MIN_ORDER_SIZE_SHARES)
   * - Minimum value: $1 USDC (MIN_ORDER_VALUE_USDC)
   *
   * Orders below these limits will be rejected by the API.
   *
   * V2 note: feeRateBps/nonce/taker no longer exist on the signed order (fees
   * are now computed by the protocol at match time) - this method never set
   * them, so no behavior change here beyond the underlying SDK/package.
   */
  async createLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    // Validate minimum order requirements before sending to API
    if (params.size < MIN_ORDER_SIZE_SHARES) {
      return {
        success: false,
        errorMsg: `Order size (${params.size}) is below Polymarket minimum (${MIN_ORDER_SIZE_SHARES} shares)`,
      };
    }

    const orderValue = params.price * params.size;
    if (orderValue < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order value ($${orderValue.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'GTD' ? ClobOrderType.GTD : ClobOrderType.GTC;
        const builderCode = params.builderCode ?? this.builderCode;

        const result = await client.createAndPostOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            price: params.price,
            size: params.size,
            expiration: params.expiration || 0,
            ...(builderCode ? { builderCode } : {}),
          },
          { tickSize, negRisk },
          orderType
        );

        const success = result.success === true ||
          (result.success !== false &&
            ((result.orderID !== undefined && result.orderID !== '') ||
              (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

        return {
          success,
          orderId: result.orderID,
          // CLOB V2's OrderResponse has no plural order-ID field (V1's
          // `orderIDs` is gone; `tradeIDs` are trade IDs, not order IDs).
          // Keep `orderIds` populated from the single order ID so existing
          // consumers doing `orderIds?.[0]` keep working.
          orderIds: result.orderID ? [result.orderID] : undefined,
          errorMsg: result.errorMsg,
          transactionHashes: result.transactionsHashes,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  /**
   * Create and post a market order
   *
   * Note: Polymarket enforces minimum order requirements:
   * - Minimum value: $1 USDC (MIN_ORDER_VALUE_USDC)
   *
   * Market orders below this limit will be rejected by the API.
   */
  async createMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    // Validate minimum order value before sending to API
    if (params.amount < MIN_ORDER_VALUE_USDC) {
      return {
        success: false,
        errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${MIN_ORDER_VALUE_USDC})`,
      };
    }

    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const [tickSize, negRisk] = await Promise.all([
          this.getTickSize(params.tokenId),
          this.isNegRisk(params.tokenId),
        ]);

        const orderType = params.orderType === 'FAK' ? ClobOrderType.FAK : ClobOrderType.FOK;
        const builderCode = params.builderCode ?? this.builderCode;

        const result = await client.createAndPostMarketOrder(
          {
            tokenID: params.tokenId,
            side: params.side === 'BUY' ? ClobSide.BUY : ClobSide.SELL,
            amount: params.amount,
            price: params.price,
            ...(builderCode ? { builderCode } : {}),
            ...(params.userUSDCBalance !== undefined ? { userUSDCBalance: params.userUSDCBalance } : {}),
          },
          { tickSize, negRisk },
          orderType
        );

        const success = result.success === true ||
          (result.success !== false &&
            ((result.orderID !== undefined && result.orderID !== '') ||
              (result.transactionsHashes !== undefined && result.transactionsHashes.length > 0)));

        return {
          success,
          orderId: result.orderID,
          // CLOB V2's OrderResponse has no plural order-ID field (V1's
          // `orderIDs` is gone; `tradeIDs` are trade IDs, not order IDs).
          // Keep `orderIds` populated from the single order ID so existing
          // consumers doing `orderIds?.[0]` keep working.
          orderIds: result.orderID ? [result.orderID] : undefined,
          errorMsg: result.errorMsg,
          transactionHashes: result.transactionsHashes,
        };
      } catch (error) {
        return {
          success: false,
          errorMsg: `Market order failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    });
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  async cancelOrder(orderId: string): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrder({ orderID: orderId });
        return { success: result.canceled ?? false, orderId };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelOrders(orderIds: string[]): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelOrders(orderIds);
        return { success: result.canceled ?? false, orderIds };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel orders failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async cancelAllOrders(): Promise<OrderResult> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      try {
        const result = await client.cancelAll();
        return { success: result.canceled ?? false };
      } catch (error) {
        throw new PolymarketError(
          ErrorCode.ORDER_FAILED,
          `Cancel all failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  async getOpenOrders(marketId?: string): Promise<Order[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const orders = await client.getOpenOrders(marketId ? { market: marketId } : undefined);

      return orders.map((o: OpenOrder) => {
        const originalSize = Number(o.original_size) || 0;
        const filledSize = Number(o.size_matched) || 0;
        return {
          id: o.id,
          status: o.status,
          tokenId: o.asset_id,
          side: o.side.toUpperCase() as Side,
          price: Number(o.price) || 0,
          originalSize,
          filledSize,
          remainingSize: originalSize - filledSize,
          associateTrades: o.associate_trades || [],
          createdAt: o.created_at,
        };
      });
    });
  }

  async getTrades(marketId?: string): Promise<TradeInfo[]> {
    const client = await this.ensureInitialized();

    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const trades = await client.getTrades(marketId ? { market: marketId } : undefined);

      return trades.map((t: ClobTrade) => ({
        id: t.id,
        tokenId: t.asset_id,
        side: t.side as Side,
        price: Number(t.price) || 0,
        size: Number(t.size) || 0,
        fee: Number(t.fee_rate_bps) || 0,
        timestamp: Number(t.match_time) || Date.now(),
      }));
    });
  }

  // ============================================================================
  // Rewards
  // ============================================================================

  async isOrderScoring(orderId: string): Promise<boolean> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.isOrderScoring({ order_id: orderId });
      return result.scoring;
    });
  }

  async areOrdersScoring(orderIds: string[]): Promise<Record<string, boolean>> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      return await client.areOrdersScoring({ orderIds });
    });
  }

  async getEarningsForDay(date: string): Promise<UserEarning[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const earnings = await client.getEarningsForUserForDay(date);
      return earnings.map(e => ({
        date: e.date,
        conditionId: e.condition_id,
        assetAddress: e.asset_address,
        makerAddress: e.maker_address,
        earnings: e.earnings,
        assetRate: e.asset_rate,
      }));
    });
  }

  async getCurrentRewards(): Promise<MarketReward[]> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const rewards = await client.getCurrentRewards();
      return rewards.map(r => ({
        conditionId: r.condition_id,
        question: r.question,
        marketSlug: r.market_slug,
        eventSlug: r.event_slug,
        rewardsMaxSpread: r.rewards_max_spread,
        rewardsMinSize: r.rewards_min_size,
        tokens: r.tokens.map(t => ({
          tokenId: t.token_id,
          outcome: t.outcome,
          price: t.price,
        })),
        rewardsConfig: r.rewards_config.map(c => ({
          assetAddress: c.asset_address,
          startDate: c.start_date,
          endDate: c.end_date,
          ratePerDay: c.rate_per_day,
          totalRewards: c.total_rewards,
        })),
      }));
    });
  }

  // ============================================================================
  // Balance & Allowance
  // ============================================================================

  /**
   * Get collateral/conditional balance and allowance.
   *
   * CLOB V2 returns `allowances` as a per-spender map (one entry per Exchange
   * contract) instead of V1's single `allowance` string. The scalar `allowance`
   * is kept for backward compatibility with existing callers and reports the
   * highest approval across spenders (i.e. "how much can actually be traded");
   * the full per-spender breakdown is exposed as `allowances`.
   */
  async getBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<{ balance: string; allowance: string; allowances: Record<string, string> }> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      const result = await client.getBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
      const allowances = result.allowances ?? {};
      const maxAllowance = Object.values(allowances).reduce<string>((max, cur) => {
        try {
          return BigInt(cur) > BigInt(max) ? cur : max;
        } catch {
          return max;
        }
      }, '0');
      return { balance: result.balance, allowance: maxAllowance, allowances };
    });
  }

  async updateBalanceAllowance(
    assetType: 'COLLATERAL' | 'CONDITIONAL',
    tokenId?: string
  ): Promise<void> {
    const client = await this.ensureInitialized();
    return this.rateLimiter.execute(ApiType.CLOB_API, async () => {
      await client.updateBalanceAllowance({
        asset_type: assetType as any,
        token_id: tokenId,
      });
    });
  }

  // ============================================================================
  // Account Info
  // ============================================================================

  getAddress(): string {
    return this.wallet.address;
  }

  getWallet(): Wallet {
    return this.wallet;
  }

  getCredentials(): ApiCredentials | null {
    return this.credentials;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getClobClient(): ClobClient | null {
    return this.clobClient;
  }

}
