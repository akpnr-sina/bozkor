ALTER TABLE "documents" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "document_type" text;--> statement-breakpoint
ALTER TABLE "raw_notices" ADD COLUMN "procedure_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_tender_id_source_url_auto_idx" ON "documents" USING btree ("tender_id","source_url") WHERE "documents"."origin" = 'auto';--> statement-breakpoint
CREATE INDEX "raw_notices_source_procedure_key_idx" ON "raw_notices" USING btree ("source","procedure_key");