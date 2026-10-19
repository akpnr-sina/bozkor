CREATE TABLE "host_rests" (
	"host" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"status" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "host_rests" ENABLE ROW LEVEL SECURITY;