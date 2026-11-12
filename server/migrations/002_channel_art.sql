-- The channel's banner, for the streamer's cover, and how many watch while it is live.
ALTER TABLE streamers ADD COLUMN banner_url TEXT;
ALTER TABLE streamers ADD COLUMN live_viewers INTEGER;
