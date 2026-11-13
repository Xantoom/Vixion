-- A recording's parts share a folder: deleting or thumbnailing one looks the others up by it.
CREATE INDEX streams_dir ON streams (dir);
-- Year-old alerts and audit entries are purged by date.
CREATE INDEX alerts_created ON alerts (created_at);
CREATE INDEX audit_log_created ON audit_log (created_at);
