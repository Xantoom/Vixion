-- The broadcast someone stopped by hand, so that a restart doesn't record it again.
ALTER TABLE streamers ADD COLUMN stopped_stream_id TEXT;
