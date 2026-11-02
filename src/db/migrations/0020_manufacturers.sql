CREATE TYPE "public"."address_kind" AS ENUM('factory', 'head_office', 'branch', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."aqap_level" AS ENUM('2110', '2120', 'none', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."certification_kind" AS ENUM('management', 'product', 'defense', 'other');--> statement-breakpoint
CREATE TYPE "public"."contact_state" AS ENUM('not_contacted', 'info_requested', 'awaiting_reply', 'confirmed', 'unsuitable');--> statement-breakpoint
CREATE TYPE "public"."fit_level" AS ENUM('medium', 'low');--> statement-breakpoint
CREATE TYPE "public"."manufacturer_kind" AS ENUM('producer', 'producer_trader');--> statement-breakpoint
CREATE TYPE "public"."province_basis" AS ENUM('factory', 'company', 'directory', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."tri_state" AS ENUM('yes', 'no', 'unknown');--> statement-breakpoint
CREATE TABLE "manufacturer_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturer_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" "certification_kind" NOT NULL,
	"valid_until" date,
	"note" text,
	"source_url" text
);
--> statement-breakpoint
ALTER TABLE "manufacturer_certifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manufacturer_imports" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "manufacturer_imports_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"version" text NOT NULL,
	"pool_sha256" text NOT NULL,
	"sources_sha256" text NOT NULL,
	"manufacturers" integer NOT NULL,
	"sources" integer NOT NULL,
	"inserted" integer NOT NULL,
	"updated" integer NOT NULL,
	"deactivated" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "manufacturer_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manufacturer_sources" (
	"manufacturer_id" text NOT NULL,
	"field" text NOT NULL,
	"value" text,
	"source_url" text,
	"verification" text NOT NULL,
	"note" text,
	"previous_sources" text,
	"checked_on" date,
	CONSTRAINT "manufacturer_sources_manufacturer_id_field_pk" PRIMARY KEY("manufacturer_id","field")
);
--> statement-breakpoint
ALTER TABLE "manufacturer_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manufacturers" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_name" text NOT NULL,
	"branch_name" text,
	"sole_proprietor" boolean,
	"vkn" text,
	"mersis" text,
	"identity_url" text,
	"province" text,
	"district" text,
	"address" text,
	"address_kind" "address_kind" DEFAULT 'unknown' NOT NULL,
	"province_basis" "province_basis" DEFAULT 'unknown' NOT NULL,
	"osb_zones" text[] DEFAULT '{}'::text[] NOT NULL,
	"kind" "manufacturer_kind" NOT NULL,
	"categories" text[] DEFAULT '{}'::text[] NOT NULL,
	"families" text[] DEFAULT '{}'::text[] NOT NULL,
	"products" text[] DEFAULT '{}'::text[] NOT NULL,
	"materials" text[] DEFAULT '{}'::text[] NOT NULL,
	"standards" text[] DEFAULT '{}'::text[] NOT NULL,
	"size_range" text,
	"production_method" text,
	"certifications_text" text,
	"certifications_url" text,
	"aqap" "aqap_level" DEFAULT 'unknown' NOT NULL,
	"as9100" "tri_state" DEFAULT 'unknown' NOT NULL,
	"ncage" text,
	"ncage_url" text,
	"defense_experience" text,
	"defense_url" text,
	"facility_security" "tri_state" DEFAULT 'unknown' NOT NULL,
	"exports" "tri_state" DEFAULT 'unknown' NOT NULL,
	"export_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"export_url" text,
	"fit_level" "fit_level",
	"fit_note" text,
	"emails" text[] DEFAULT '{}'::text[] NOT NULL,
	"phones" text[] DEFAULT '{}'::text[] NOT NULL,
	"website" text,
	"evidence_kind" text,
	"evidence_url" text,
	"evidence_location" text,
	"evidence_quote" text,
	"identity_match" text,
	"first_sources" text,
	"contact_state" "contact_state" DEFAULT 'not_contacted' NOT NULL,
	"moq" text,
	"lead_time_days" integer,
	"notes" text,
	"checked_on" date,
	"pool_version" text NOT NULL,
	"import_id" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manufacturers_id_format" CHECK ("manufacturers"."id" ~ '^BZ-[0-9A-F]{12}$'),
	CONSTRAINT "manufacturers_vkn_format" CHECK ("manufacturers"."vkn" is null or "manufacturers"."vkn" ~ '^[0-9]{10}$'),
	CONSTRAINT "manufacturers_mersis_format" CHECK ("manufacturers"."mersis" is null or "manufacturers"."mersis" ~ '^0[0-9]{15}$'),
	CONSTRAINT "manufacturers_sole_proprietor_ids" CHECK ("manufacturers"."sole_proprietor" is not true or ("manufacturers"."vkn" is null and "manufacturers"."mersis" is null))
);
--> statement-breakpoint
ALTER TABLE "manufacturers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "manufacturer_certifications" ADD CONSTRAINT "manufacturer_certifications_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manufacturer_sources" ADD CONSTRAINT "manufacturer_sources_manufacturer_id_manufacturers_id_fk" FOREIGN KEY ("manufacturer_id") REFERENCES "public"."manufacturers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manufacturers" ADD CONSTRAINT "manufacturers_import_id_manufacturer_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."manufacturer_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "manufacturer_certifications_name_idx" ON "manufacturer_certifications" USING btree ("manufacturer_id","name");