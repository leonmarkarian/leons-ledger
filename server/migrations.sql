-- run once per column on existing databases (errors if the column already exists are ignored by the deploy step)
ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE users ADD COLUMN recovery_salt TEXT;
