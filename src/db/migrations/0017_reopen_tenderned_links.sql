-- TenderNed's documents come from its official API since 19 October 2026
-- (src/documents/adapters). Its notice links left to the team only because
-- its robots.txt could not be read at the time (no request was made) are
-- tried again, through the API.
UPDATE "documents"
SET "fetch_status" = 'pending', "fetch_attempts" = 0, "retry_at" = NULL, "fetch_error" = NULL, "processed_at" = NULL
WHERE "origin" = 'auto'
  AND "parent_document_id" IS NULL
  AND "fetch_status" = 'needs_manual'
  AND "source_url" ~* '^https?://([^/?#]*\.)?tenderned\.nl([:/?#]|$)'
  AND "fetch_error" LIKE 'Sitenin robots.txt dosyası okunamadı%';
