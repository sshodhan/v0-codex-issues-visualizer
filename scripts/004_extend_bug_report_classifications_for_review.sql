alter table bug_report_classifications
  add column if not exists source_issue_id uuid references issues(id) on delete set null,
  add column if not exists source_issue_url text,
  add column if not exists source_issue_title text,
  add column if not exists source_issue_sentiment text,
  add column if not exists model_used text,
  add column if not exists retried_with_large_model boolean not null default false,
  add column if not exists reviewer_notes text,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_bug_report_classifications_source_issue
  on bug_report_classifications (source_issue_id, created_at desc);
