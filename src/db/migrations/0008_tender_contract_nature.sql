CREATE TYPE "public"."contract_nature" AS ENUM('goods', 'services', 'works');--> statement-breakpoint
ALTER TABLE "tenders" ADD COLUMN "contract_nature" "contract_nature";