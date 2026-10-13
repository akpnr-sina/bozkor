-- Source rows are referenced by raw_notices.source and tenders.source.
INSERT INTO "sources" ("id") VALUES ('uk_fat'), ('eu_ted') ON CONFLICT ("id") DO NOTHING;
