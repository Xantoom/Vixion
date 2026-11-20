-- Recordings get random ids instead of the next number: SQLite hands the highest id out again
-- once its row is deleted, and what browsers remember by id (where a video was left) then
-- applied to another recording. Existing recordings are renumbered the same way.
-- Ids stay below 2^53 so that JavaScript reads them exactly.
PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE stream_ids AS
    SELECT id AS old, (abs(random()) % 9007199254740990) + 1 AS new FROM streams;
UPDATE stream_chapters SET stream_id = (SELECT new FROM stream_ids WHERE old = stream_id);
UPDATE streams SET id = (SELECT new FROM stream_ids WHERE old = streams.id);
DROP TABLE stream_ids;
