import {
  CATEGORY_ENUM,
  IMPACT_ENUM,
  REPRODUCIBILITY_ENUM,
  SEVERITY_ENUM,
  STATUS_ENUM,
} from "./taxonomy.ts"

export const CLASSIFICATION_SCHEMA = {
  name: "codex_issue_classification",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "category",
      "subcategory",
      "severity",
      "status",
      "reproducibility",
      "impact",
      "confidence",
      "summary",
      "root_cause_hypothesis",
      "suggested_fix",
      "evidence_quotes",
      "alternate_categories",
      "tags",
      "needs_human_review",
      "review_reasons",
    ],
    properties: {
      category: { type: "string", enum: CATEGORY_ENUM },
      subcategory: { type: "string", maxLength: 60 },
      severity: { type: "string", enum: SEVERITY_ENUM },
      status: { type: "string", enum: STATUS_ENUM },
      reproducibility: { type: "string", enum: REPRODUCIBILITY_ENUM },
      impact: { type: "string", enum: IMPACT_ENUM },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      summary: { type: "string", maxLength: 280 },
      root_cause_hypothesis: { type: "string", maxLength: 400 },
      suggested_fix: { type: "string", maxLength: 600 },
      evidence_quotes: {
        type: "array",
        items: { type: "string", maxLength: 240 },
        maxItems: 5,
      },
      alternate_categories: {
        type: "array",
        items: { type: "string", enum: CATEGORY_ENUM },
        maxItems: 2,
      },
      tags: {
        type: "array",
        items: { type: "string", maxLength: 32 },
        maxItems: 8,
      },
      needs_human_review: { type: "boolean" },
      review_reasons: {
        type: "array",
        items: { type: "string" },
        maxItems: 4,
      },
    },
  },
} as const

const enumValidators: Record<string, readonly string[]> = {
  category: CATEGORY_ENUM,
  severity: SEVERITY_ENUM,
  status: STATUS_ENUM,
  reproducibility: REPRODUCIBILITY_ENUM,
  impact: IMPACT_ENUM,
}

export function validateEnumFields(payload: object): { field: string; valid: readonly string[] } | null {
  const data = payload as Record<string, unknown>

  for (const [field, valid] of Object.entries(enumValidators)) {
    const value = data[field]
    if (typeof value !== "string" || !valid.includes(value)) {
      return { field, valid }
    }
  }

  // alternate_categories is array<IssueCategory>. The strict JSON schema
  // already enforces the enum at the model surface (items.enum), so this
  // is belt-and-braces: rejects payloads where a non-strict caller (e.g.
  // a future re-classify path that bypasses Responses API) injects a
  // legacy or arbitrary slug.
  const alternates = data.alternate_categories
  if (!Array.isArray(alternates)) {
    return { field: "alternate_categories", valid: CATEGORY_ENUM }
  }
  for (const item of alternates) {
    if (typeof item !== "string" || !CATEGORY_ENUM.includes(item as typeof CATEGORY_ENUM[number])) {
      return { field: "alternate_categories", valid: CATEGORY_ENUM }
    }
  }

  return null
}

export function evidenceQuotesAreSubstrings(payload: { evidence_quotes?: unknown }, inputText: string): boolean {
  const quotes = payload.evidence_quotes
  if (!Array.isArray(quotes)) {
    return false
  }

  return quotes.every((quote) => typeof quote === "string" && inputText.includes(quote))
}

export function sanitizeEvidenceQuotes(
  payload: { evidence_quotes?: unknown },
  inputText: string,
): string[] {
  const quotes = payload.evidence_quotes
  if (!Array.isArray(quotes)) return []

  const unique: string[] = []
  const seen = new Set<string>()

  for (const quote of quotes) {
    if (typeof quote !== "string") continue
    const normalized = quote.trim()
    if (!normalized) continue
    if (!inputText.includes(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(normalized)
    if (unique.length >= 5) break
  }

  return unique
}
