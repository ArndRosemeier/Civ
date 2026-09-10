/**
 * FNV-1a 64 hashing of canonical JSON — the state digest used by goldens and
 * self-play. Lives outside `packages/core` so core stays free of IO-adjacent
 * concerns (PLAN.md §5.3, docs/INTERFACES.md W2).
 *
 * Pure functions only: no filesystem, no ambient time, no ambient randomness.
 */

import { canonicalize } from './canonical.js';

/** 64-bit wrap-around mask; BigInt is arbitrary precision, so mask explicitly. */
const MASK64 = 0xffffffffffffffffn;
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const HEX_LENGTH = 16;

const encoder = new TextEncoder();

/** FNV-1a 64 over UTF-8 bytes, returned as 16 lowercase hex chars. */
export function fnv1a64(input: string): string {
  const bytes = encoder.encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(HEX_LENGTH, '0');
}

/** canonicalize + fnv1a64. */
export function hashValue(value: unknown): string {
  return fnv1a64(canonicalize(value));
}
