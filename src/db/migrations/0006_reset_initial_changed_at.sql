-- The first backfill marked tenders as changed before anyone had seen them.
-- The inbox starts clean; from here on changed_at only reflects real updates.
UPDATE "tenders" SET "changed_at" = NULL WHERE "changed_at" IS NOT NULL;
