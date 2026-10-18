-- TED's links were stored with HTML-escaped ampersands ("...login&amp;type=DCE"),
-- now and then escaped twice, so they opened the wrong page. The normaliser
-- decodes them now; this fixes the rows stored before. A link whose decoded
-- form is already stored for the tender is left as it is.
UPDATE "documents" AS d
SET "source_url" = replace(replace(replace(d."source_url", '&amp;', '&'), '&amp;', '&'), '&#38;', '&')
WHERE d."origin" = 'auto'
  AND d."source_url" ~ '&(amp|#38);'
  AND NOT EXISTS (
    SELECT 1 FROM "documents" AS o
    WHERE o."tender_id" = d."tender_id"
      AND o."origin" = 'auto'
      AND o."source_url" = replace(replace(replace(d."source_url", '&amp;', '&'), '&amp;', '&'), '&#38;', '&')
  );--> statement-breakpoint
UPDATE "tenders"
SET "documents_portal_url" = replace(replace(replace("documents_portal_url", '&amp;', '&'), '&amp;', '&'), '&#38;', '&')
WHERE "documents_portal_url" ~ '&(amp|#38);';
