-- Classifier output storage for codex issue triage
create table if not exists bug_report_classifications (
  id uuid primary key default gen_random_uuid(),
  report_text text not null,
  category text not null,
  subcategory text not null,
  severity text not null,
  status text not null,
  reproducibility text not null,
  impact text not null,
  confidence numeric(3,2) not null,
  summary text not null,
  root_cause_hypothesis text not null,
  suggested_fix text not null,
  evidence_quotes text[] not null default '{}',
  alternate_categories text[] not null default '{}',
  tags text[] not null default '{}',
  needs_human_review boolean not null,
  review_reasons text[] not null default '{}',
  raw_json jsonb not null,
  related_report_ids uuid[] not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists idx_bug_report_classifications_triage
  on bug_report_classifications (category, severity, needs_human_review, created_at desc);
