-- Add unique constraint to record_date
ALTER TABLE sleep_analysis ADD CONSTRAINT sleep_analysis_record_date_key UNIQUE (record_date);