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

export interface DeterministicLabel {
  label: string
  rationale: string
  confidence: number
  // Source tag persisted to `clusters.label_model` for audit. Always
  // prefixed `deterministic:` so analytics can split fallback rows from
  // LLM-confident ones (`openai:gpt-5-mini`, `openai:gpt-5`).
  model:
    | "deterministic:topic-and-error"
    | "deterministic:topic"
    | "deterministic:error"
    | "deterministic:title"
}

export interface ComposeDeterministicLabelArgs {
  topicSlugs: Array<string | null | undefined>
  errorCodes: Array<string | null | undefined>
  titles: string[]
}

// Confidence values are >= 0.4 so the UI (threshold 0.4) always renders
// the label. They are intentionally below 0.7 so an LLM-confident label
// will out-rank a deterministic one if a re-run later produces one.
const CONFIDENCE_TOPIC_AND_ERROR = 0.55
const CONFIDENCE_TOPIC_ONLY = 0.45
const CONFIDENCE_ERROR_ONLY = 0.45
const CONFIDENCE_TITLE_ONLY = 0.4

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
      model: "deterministic:topic-and-error",
    }
  }
  if (topicName) {
    return {
      label: `${topicName} cluster`,
      rationale: `Derived from dominant Topic (${topicName}) across cluster members; no consistent error code.`,
      confidence: CONFIDENCE_TOPIC_ONLY,
      model: "deterministic:topic",
    }
  }
  if (dominantErrorCode) {
    return {
      label: `${dominantErrorCode} cluster`,
      rationale: `Derived from dominant error code (${dominantErrorCode}) across cluster members; no consistent Topic.`,
      confidence: CONFIDENCE_ERROR_ONLY,
      model: "deterministic:error",
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
    model: "deterministic:title",
  }
}
