/**
 * Data provenance — the honesty rule. See PLAN.md 6.2.
 *
 * Every rules-data row must declare where its numbers came from. A row is
 * either `cited` (traced to a source) or `placeholder` (our own tuned value,
 * explicitly NOT claimed to be Civ 3-accurate). The `cited-only` fidelity mode
 * refuses to run while any active row is a placeholder, which turns "is this
 * game-accurate?" from a claim into a mechanical check.
 */

export interface CitedProvenance {
  readonly kind: 'cited';
  readonly source: string;
  readonly note?: string;
}

export interface PlaceholderProvenance {
  readonly kind: 'placeholder';
  readonly note: string;
}

export type Provenance = CitedProvenance | PlaceholderProvenance;

export const cited = (source: string, note?: string): CitedProvenance =>
  note === undefined ? { kind: 'cited', source } : { kind: 'cited', source, note };

export const placeholder = (note: string): PlaceholderProvenance => ({
  kind: 'placeholder',
  note,
});

export const isPlaceholder = (p: Provenance): p is PlaceholderProvenance =>
  p.kind === 'placeholder';

export const isCited = (p: Provenance): p is CitedProvenance => p.kind === 'cited';
