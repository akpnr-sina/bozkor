CREATE TABLE "fx_rates" (
	"date" date NOT NULL,
	"currency" text NOT NULL,
	"rate_per_eur" numeric(18, 6) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_date_currency_pk" PRIMARY KEY("date","currency")
);
--> statement-breakpoint
ALTER TABLE "fx_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tender_reviews" ALTER COLUMN "decision" DROP NOT NULL;