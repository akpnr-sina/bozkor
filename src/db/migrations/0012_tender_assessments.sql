ALTER TYPE "public"."analysis_kind" ADD VALUE 'facts';--> statement-breakpoint
CREATE TABLE "assessment_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"facts_analysis_id" uuid,
	"policy_version" text NOT NULL,
	"status" text NOT NULL,
	"best_lot" text NOT NULL,
	"explanation" text NOT NULL,
	"blocking" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessment_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tender_assessments" (
	"tender_id" uuid PRIMARY KEY NOT NULL,
	"facts_analysis_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"status" text NOT NULL,
	"best_lot" text NOT NULL,
	"explanation" text NOT NULL,
	"blocking" text[] DEFAULT '{}'::text[] NOT NULL,
	"fit_low" integer NOT NULL,
	"fit_high" integer NOT NULL,
	"preliminary_low" integer NOT NULL,
	"preliminary_high" integer NOT NULL,
	"confidence" integer NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tender_assessments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_history" ADD CONSTRAINT "assessment_history_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_history" ADD CONSTRAINT "assessment_history_facts_analysis_id_analyses_id_fk" FOREIGN KEY ("facts_analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_assessments" ADD CONSTRAINT "tender_assessments_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_assessments" ADD CONSTRAINT "tender_assessments_facts_analysis_id_analyses_id_fk" FOREIGN KEY ("facts_analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assessment_history_tender_id_idx" ON "assessment_history" USING btree ("tender_id","created_at");--> statement-breakpoint
CREATE INDEX "tender_assessments_status_idx" ON "tender_assessments" USING btree ("status");