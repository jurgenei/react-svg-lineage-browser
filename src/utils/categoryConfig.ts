/**
 * Category configuration for Sankey-style vertical lane positioning.
 * Ordered from bottom (index 0) to top (index n).
 */

export const CATEGORY_ORDER = [
  'Logging',
  'Processing Status',
  'Operational',
  'Risk Calculation',
  'Reporting',
  'Customer Reference',
  'Static Reference'
];

export const CATEGORY_COLORS: Record<string, string> = {
  'Logging': 'var(--accent-fuchsia-light)',
  'Processing Status': 'var(--accent-blue-light)',
  'Operational': 'var(--accent-teal-light)',
  'Risk Calculation': 'var(--accent-green-light)',
  'Reporting': 'var(--accent-purple-light)',
  'Customer Reference': 'var(--accent-indigo-light)',
  'Static Reference': 'var(--accent-amber-light)'
};

/**
 * Get the y-anchor position for a category.
 * Returns normalized value 0–1, where 0 is bottom and 1 is top.
 */
export function getCategoryYPosition(category: string | undefined): number {
  if (!category) {
    return 0.5; // default middle
  }
  const index = CATEGORY_ORDER.indexOf(category);
  if (index < 0) {
    return 0.5; // unknown category, default middle
  }
  if (CATEGORY_ORDER.length === 1) {
    return 0.5;
  }
  return index / (CATEGORY_ORDER.length - 1);
}

/**
 * Get CSS color for a category.
 */
export function getCategoryColor(category: string | undefined): string {
  if (!category) {
    return 'var(--accent-indigo-light)'; // default
  }
  return CATEGORY_COLORS[category] ?? 'var(--accent-indigo-light)';
}

