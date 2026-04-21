-- N-6 pre-flight backup snapshot prior to running scripts/006_rescore_impact_after_pr13.ts
-- Date stamp: 20260421
CREATE TABLE IF NOT EXISTS issues_prerescore_backup_20260421 AS
SELECT id, sentiment, sentiment_score, impact_score
FROM issues;

-- ROLLBACK (manual):
-- UPDATE issues AS i
-- SET sentiment = b.sentiment,
--     sentiment_score = b.sentiment_score,
--     impact_score = b.impact_score
-- FROM issues_prerescore_backup_20260421 AS b
-- WHERE i.id = b.id;
