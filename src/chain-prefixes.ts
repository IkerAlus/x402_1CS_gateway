/**
 * Shared NEP-141 chain-prefix constants and helpers.
 *
 * These are used by both `config.ts` (startup recipient-format validation)
 * and `quote-engine.ts` (runtime diagnosis of 1CS rejections). Living in
 * their own leaf module keeps both call-sites in sync and avoids a cycle
 * between config and the engine.
 *
 * @see https://docs.near-intents.org/resources/asset-support
 */

/**
 * Known NEP-141 chain prefixes that map to EVM chains.
 * When the destination asset uses one of these, the recipient should be a
 * 0x-prefixed EVM address (40 hex chars).
 */
export const EVM_CHAIN_PREFIXES: readonly string[] = [
  "eth", "base", "arb", "op", "polygon", "avax", "bsc", "turbochain",
  "gnosis", "scroll", "xlayer", "berachain", "monad", "plasma",
];

/**
 * Known NEP-141 chain prefixes for non-EVM chains.
 * Recipient format varies per chain (Stellar G…, Solana pubkey, etc.).
 */
export const NON_EVM_CHAIN_PREFIXES: readonly string[] = [
  "solana", "bitcoin", "litecoin", "dogecoin", "stellar", "xrp",
  "ton", "tron", "aptos", "sui", "starknet", "aleo", "cardano",
  "dash", "zcash", "bch",
];

/**
 * Extract the OMFT bridge chain prefix from a NEP-141 asset ID.
 *
 * OMFT-bridged assets always have the shape `<chain>-<address>.omft.near`.
 * Non-OMFT assets (NEAR-native tokens like `usdt.tether-token.near` or
 * `17208628...e36133a1`) have no chain prefix and return `null`.
 *
 * @example
 *   extractChainPrefix("nep141:arb-0xaf88...omft.near")     // "arb"
 *   extractChainPrefix("nep141:stellar-GA5Z...omft.near")   // "stellar"
 *   extractChainPrefix("nep141:usdt.tether-token.near")     // null  (NEAR-native)
 *   extractChainPrefix("nep141:17208628...e36133a1")        // null  (NEAR implicit)
 */
export function extractChainPrefix(asset: string): string | null {
  const body = asset.startsWith("nep141:") ? asset.substring(7) : asset;
  // Only OMFT-bridged assets carry a chain prefix.
  if (!body.endsWith(".omft.near")) return null;
  const hyphenIndex = body.indexOf("-");
  if (hyphenIndex <= 0) return null;
  return body.substring(0, hyphenIndex);
}

/**
 * Heuristic check for a valid NEAR account ID.
 *
 * Accepts two shapes:
 *   - Implicit account: exactly 64 lowercase hex chars
 *   - Named account:    length 2-64, chars `[a-z0-9._-]`, no consecutive or
 *                       leading/trailing separators, ending in `.near` or `.tg`
 *
 * Cannot tell if the account actually exists on-chain — that would require an
 * RPC call. Catches the common typo cases (wrong TLA, spaces, uppercase).
 *
 * @see https://docs.near.org/concepts/protocol/account-id
 */
export function isValidNearAccount(id: string): boolean {
  // Implicit accounts: 64 lowercase hex chars exactly.
  if (/^[a-f0-9]{64}$/.test(id)) return true;

  // Named accounts: 2-64 chars, lowercase alnum + `._-`, no leading/trailing
  // separators, no consecutive separators, must end in a known TLA.
  if (id.length < 2 || id.length > 64) return false;
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(id)) return false;
  if (/[._-]{2,}/.test(id)) return false;
  return /\.(near|tg)$/.test(id);
}

/**
 * True if the asset ID refers to a NEAR-native token — i.e. not an OMFT bridge.
 * This covers:
 *   - Named NEAR contracts: `nep141:usdt.tether-token.near`, `nep141:wrap.near`
 *   - Implicit NEAR accounts: `nep141:17208628...e36133a1`
 */
export function isNearNativeAsset(asset: string): boolean {
  if (extractChainPrefix(asset) !== null) return false; // OMFT → not NEAR-native
  const body = asset.startsWith("nep141:") ? asset.substring(7) : asset;
  // Named token ending in .near OR a 64-char hex implicit account.
  return body.endsWith(".near") || /^[a-f0-9]{64}$/.test(body);
}
