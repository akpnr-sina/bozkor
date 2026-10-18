-- The first fetching rules (16 October 2026) recorded portals that loop
-- through cookie redirects or refuse a non-browser request (400, 403) as
-- failed links. By the rules of 17 October they are portal pages; links
-- that failed are tried once more and sorted again.
UPDATE "documents"
SET "fetch_status" = 'pending', "fetch_attempts" = 0, "retry_at" = NULL, "fetch_error" = NULL
WHERE "origin" = 'auto'
  AND "fetch_status" = 'failed'
  AND "source_url" IS NOT NULL
  AND "storage_path" IS NULL;
