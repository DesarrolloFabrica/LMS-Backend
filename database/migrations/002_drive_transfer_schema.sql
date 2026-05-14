DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'subject_transfer_files'
      AND column_name = 'mega_url'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'subject_transfer_files'
      AND column_name = 'drive_url'
  ) THEN
    ALTER TABLE subject_transfer_files RENAME COLUMN mega_url TO drive_url;
  END IF;
END $$;

ALTER TABLE subject_transfer_files
  ADD COLUMN IF NOT EXISTS drive_file_id text;
