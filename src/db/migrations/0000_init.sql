CREATE TYPE "public"."analysis_kind" AS ENUM('triage', 'deep');--> statement-breakpoint
CREATE TYPE "public"."document_fetch_status" AS ENUM('pending', 'fetched', 'needs_manual', 'failed', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."document_origin" AS ENUM('auto', 'manual');--> statement-breakpoint
CREATE TYPE "public"."match_state" AS ENUM('new', 'seen', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."regime" AS ENUM('covered', 'below_threshold', 'utilities', 'defence', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."review_decision" AS ENUM('GO', 'REVIEW', 'NO_GO', 'WATCH');--> statement-breakpoint
CREATE TYPE "public"."tender_status" AS ENUM('open', 'closed', 'awarded', 'cancelled');--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"profile_id" uuid,
	"kind" "analysis_kind" NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"document_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"output" jsonb,
	"valid" boolean DEFAULT false NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analyses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cpv_prefixes" text[] DEFAULT '{}'::text[] NOT NULL,
	"description" text
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "criteria_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"rules" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "criteria_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"origin" "document_origin" NOT NULL,
	"source_url" text,
	"filename" text,
	"mime" text,
	"size_bytes" integer,
	"sha256" text,
	"storage_path" text,
	"page_count" integer,
	"text_content" text,
	"fetch_status" "document_fetch_status" DEFAULT 'pending' NOT NULL,
	"fetch_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"title" text,
	"description" text,
	"cpv" text[] DEFAULT '{}'::text[] NOT NULL,
	"value_amount" numeric(18, 2),
	"value_currency" text,
	"quantity_text" text
);
--> statement-breakpoint
ALTER TABLE "lots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "profile_matches" (
	"profile_id" uuid NOT NULL,
	"tender_id" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filter_reasons" jsonb NOT NULL,
	"triage_score" integer,
	"triage_analysis_id" uuid,
	"state" "match_state" DEFAULT 'new' NOT NULL,
	CONSTRAINT "profile_matches_profile_id_tender_id_pk" PRIMARY KEY("profile_id","tender_id"),
	CONSTRAINT "profile_matches_triage_score_range" CHECK ("profile_matches"."triage_score" is null or ("profile_matches"."triage_score" between 0 and 100))
);
--> statement-breakpoint
ALTER TABLE "profile_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "raw_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"payload" jsonb,
	"payload_xml" text,
	"sha256" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_notices_payload_present" CHECK ("raw_notices"."payload" is not null or "raw_notices"."payload_xml" is not null)
);
--> statement-breakpoint
ALTER TABLE "raw_notices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"last_synced_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tender_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"decision" "review_decision" NOT NULL,
	"note" text,
	"decided_by" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tender_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"procedure_key" text NOT NULL,
	"notice_type" text,
	"regime" "regime" DEFAULT 'unknown' NOT NULL,
	"status" "tender_status" DEFAULT 'open' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"buyer_name" text,
	"buyer_country" text,
	"nuts_code" text,
	"cpv_main" text,
	"cpv_additional" text[] DEFAULT '{}'::text[] NOT NULL,
	"value_amount" numeric(18, 2),
	"value_currency" text,
	"value_eur" numeric(18, 2),
	"published_at" timestamp with time zone,
	"submission_deadline" timestamp with time zone,
	"clarification_deadline" timestamp with time zone,
	"procedure_type" text,
	"notice_language" text,
	"notice_url" text,
	"documents_portal_url" text,
	"changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_profile_id_criteria_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."criteria_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_matches" ADD CONSTRAINT "profile_matches_profile_id_criteria_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."criteria_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_matches" ADD CONSTRAINT "profile_matches_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_matches" ADD CONSTRAINT "profile_matches_triage_analysis_id_analyses_id_fk" FOREIGN KEY ("triage_analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_notices" ADD CONSTRAINT "raw_notices_source_sources_id_fk" FOREIGN KEY ("source") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_reviews" ADD CONSTRAINT "tender_reviews_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_source_sources_id_fk" FOREIGN KEY ("source") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analyses_tender_id_kind_idx" ON "analyses" USING btree ("tender_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "analyses_created_at_idx" ON "analyses" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "documents_tender_id_idx" ON "documents" USING btree ("tender_id");--> statement-breakpoint
CREATE INDEX "documents_sha256_idx" ON "documents" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "lots_tender_id_lot_number_idx" ON "lots" USING btree ("tender_id","lot_number");--> statement-breakpoint
CREATE INDEX "profile_matches_tender_id_idx" ON "profile_matches" USING btree ("tender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_notices_source_external_id_sha256_idx" ON "raw_notices" USING btree ("source","external_id","sha256");--> statement-breakpoint
CREATE INDEX "raw_notices_fetched_at_idx" ON "raw_notices" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "tender_reviews_tender_id_decided_at_idx" ON "tender_reviews" USING btree ("tender_id","decided_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenders_source_procedure_key_idx" ON "tenders" USING btree ("source","procedure_key");--> statement-breakpoint
CREATE INDEX "tenders_external_id_idx" ON "tenders" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "tenders_submission_deadline_idx" ON "tenders" USING btree ("submission_deadline");--> statement-breakpoint
CREATE INDEX "tenders_published_at_idx" ON "tenders" USING btree ("published_at");