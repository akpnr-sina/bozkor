CREATE TYPE "public"."deep_request_status" AS ENUM('queued', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "deep_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"status" "deep_request_status" DEFAULT 'queued' NOT NULL,
	"requested_by" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"analysis_id" uuid,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "deep_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deep_requests" ADD CONSTRAINT "deep_requests_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deep_requests" ADD CONSTRAINT "deep_requests_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deep_requests_status_idx" ON "deep_requests" USING btree ("status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deep_requests_open_idx" ON "deep_requests" USING btree ("tender_id") WHERE status in ('queued', 'running');