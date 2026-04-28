// Deterministic fallback for cluster (Family) display names.
//
// The LLM-based labeller in `lib/storage/semantic-clusters.ts` is best-effort:
// the network can fail, the response can fail to parse, and on small or
// generic clusters the model is honestly unsure. Before this helper landed,
// the only fallback was a 80-char title slice at confidence 0.25 — which the
// UI suppresses (`Unnamed family`). With this helper, every cluster gets a
// label derived from its dominant Topic + error code so the UI always has
// something honest to show. See docs/CLUSTERING_DESIGN.md §4.4.

// Stable seed-data slug → human-displayable name (scripts/002).
// Anything outside this map is title-cased so the helper degrades gracefully
// if the categories table grows.
const TOPIC_NAME_BY_SLUG: Record<string, string> = {
  performance: "Performance",
  bug: "Bug",
  "feature-request": "Feature Request",
  documentation: "Documentation",
  integration: "Integration",
  pricing: "Pricing",
  "model-quality": "Model Quality",
  security: "Security",
  "ux-ui": "UX/UI",
  api: "API",
  other: "Other",
}

export function topicNameForSlug(slug: string | null | undefined): string | null {
  if (!slug) return null
  const known = TOPIC_NAME_BY_SLUG[slug]
  if (known) return known
  // Title-case `kebab-or_snake_case` slugs so unknown topics still render
  // sensibly (e.g. `release-notes` → `Release Notes`).
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

// Returns the most-frequent non-null value, ties broken by lexicographic
// ascending order so the result is deterministic across runs.
export function mode<T extends string>(values: Array<T | null | undefined>): T | null {
  const counts = new Map<T, number>()
  for (const value of values) {
    if (value == null) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  let best: T | null = null
  let bestCount = -1
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

// Canonical `clusters.label_model` values. Held in a frozen const-object
// so (a) every emission site references the same string, (b) a typo at
// a call site is a compile error rather than a silently wrong audit row,
// and (c) `grep LABEL_MODEL` surfaces every reader/writer.
//
// `OPENAI_PREFIX` is the prefix the writer composes the LLM model tag
// from at write time (e.g. `openai:gpt-5-mini`) — kept here so the prefix
// is a typed reference rather than a stringly-typed literal.
//
// `LEGACY_FALLBACK_TITLE` is the v1 model tag persisted to rows written
// before the v2 labeller existed. Kept as a constant so the backfill
// migration in scripts/021_backfill_deterministic_labels.ts can target
// pre-v2 rows without a magic string. New code MUST NOT emit this value.
export const LABEL_MODEL = {
  DETERMINISTIC_TOPIC_AND_ERROR: "deterministic:topic-and-error",
  DETERMINISTIC_TOPIC: "deterministic:topic",
  DETERMINISTIC_ERROR: "deterministic:error",
  DETERMINISTIC_TITLE: "deterministic:title",
  OPENAI_PREFIX: "openai:",
  LEGACY_FALLBACK_TITLE: "fallback:title",
} as const

export type DeterministicLabelModel =
  | typeof LABEL_MODEL.DETERMINISTIC_TOPIC_AND_ERROR
  | typeof LABEL_MODEL.DETERMINISTIC_TOPIC
  | typeof LABEL_MODEL.DETERMINISTIC_ERROR
  | typeof LABEL_MODEL.DETERMINISTIC_TITLE

export interface DeterministicLabel {
  label: string
  rationale: string
  confidence: number
  // Source tag persisted to `clusters.label_model` for audit. Always
  // prefixed `deterministic:` so analytics can split fallback rows from
  // LLM-confident ones (`openai:gpt-5-mini`, `openai:gpt-5`).
  model: DeterministicLabelModel
}

export interface ComposeDeterministicLabelArgs {
  topicSlugs: Array<string | null | undefined>
  errorCodes: Array<string | null | undefined>
  titles: string[]
}

// Producer/consumer contract: a cluster with `label_confidence >= this`
// renders its label in the UI; below it, the UI falls back to a
// `Cluster #<short-id>` placeholder. The deterministic ladder's lowest
// rung (`deterministic:title`, below) lands exactly at this floor, so
// every cluster always has a displayable name.
//
// Both the producer (the rung confidences below) and the consumer
// (every render site under app/ and components/dashboard/) MUST
// reference this constant. tests/label-confidence-contract.test.ts
// fails if any of those drift.
export const MIN_DISPLAYABLE_LABEL_CONFIDENCE = 0.4

// Rung confidences. Always >= MIN_DISPLAYABLE_LABEL_CONFIDENCE so the
// UI always renders the label, and < 0.7 so an LLM-confident label
// out-ranks a deterministic one on re-run.
const CONFIDENCE_TOPIC_AND_ERROR = 0.55
const CONFIDENCE_TOPIC_ONLY = 0.45
const CONFIDENCE_ERROR_ONLY = 0.45
const CONFIDENCE_TITLE_ONLY = MIN_DISPLAYABLE_LABEL_CONFIDENCE

export function composeDeterministicLabel(
  args: ComposeDeterministicLabelArgs,
): DeterministicLabel {
  const dominantTopicSlug = mode(args.topicSlugs)
  const dominantErrorCode = mode(args.errorCodes)
  const topicName = topicNameForSlug(dominantTopicSlug)

  if (topicName && dominantErrorCode) {
    return {
      label: `${topicName} cluster · ${dominantErrorCode}`,
      rationale: `Derived from dominant Topic (${topicName}) and error code (${dominantErrorCode}) across cluster members.`,
      confidence: CONFIDENCE_TOPIC_AND_ERROR,
      model: LABEL_MODEL.DETERMINISTIC_TOPIC_AND_ERROR,
    }
  }
  if (topicName) {
    return {
      label: `${topicName} cluster`,
      rationale: `Derived from dominant Topic (${topicName}) across cluster members; no consistent error code.`,
      confidence: CONFIDENCE_TOPIC_ONLY,
      model: LABEL_MODEL.DETERMINISTIC_TOPIC,
    }
  }
  if (dominantErrorCode) {
    return {
      label: `${dominantErrorCode} cluster`,
      rationale: `Derived from dominant error code (${dominantErrorCode}) across cluster members; no consistent Topic.`,
      confidence: CONFIDENCE_ERROR_ONLY,
      model: LABEL_MODEL.DETERMINISTIC_ERROR,
    }
  }

  // Pick the shortest non-empty title as the seed — long titles often
  // include incident-specific noise; the shortest tends to be the gist.
  const seed =
    [...args.titles]
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .sort((a, b) => a.length - b.length)[0] ?? "Unnamed cluster"
  const trimmed = seed.length > 60 ? `${seed.slice(0, 57).trimEnd()}…` : seed
  return {
    label: `Cluster · ${trimmed}`,
    rationale: "No consistent Topic or error code across members; derived from the canonical title.",
    confidence: CONFIDENCE_TITLE_ONLY,
    model: LABEL_MODEL.DETERMINISTIC_TITLE,
  }
}
