-- Apply manually after review. No application startup migration.
BEGIN;
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS job_title TEXT,
  ADD COLUMN IF NOT EXISTS planned_department TEXT,
  ADD COLUMN IF NOT EXISTS employment_type TEXT;
COMMIT;