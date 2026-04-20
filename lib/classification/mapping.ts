export interface ClassificationApiRecord {
  category: string
  subcategory: string
  severity: string
  status: string
  reproducibility: string
  impact: string
  confidence: number
  summary: string
  root_cause_hypothesis: string
  suggested_fix: string
  evidence_quotes: string[]
  alternate_categories: string[]
  tags: string[]
  needs_human_review: boolean
  review_reasons: string[]
}

export interface ClassificationDbRecord {
  category: string
  subcategory: string
  severity: string
  status: string
  reproducibility: string
  impact: string
  confidence: number
  summary: string
  root_cause_hypothesis: string
  suggested_fix: string
  evidence_quotes: string[]
  alternate_categories: string[]
  tags: string[]
  needs_human_review: boolean
  review_reasons: string[]
  raw_json: ClassificationApiRecord
  report_text: string
}

export function toDbRecord(record: ClassificationApiRecord, reportText: string): ClassificationDbRecord {
  return {
    ...record,
    raw_json: record,
    report_text: reportText,
  }
}
