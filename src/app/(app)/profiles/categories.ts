import { asc } from "drizzle-orm";
import { getDb } from "@/db";
import { categories } from "@/db/schema";

/** Categories with their names for the profile form, in a stable order. */
export function categoryOptions() {
  return getDb()
    .select({ id: categories.id, name: categories.name, cpvPrefixes: categories.cpvPrefixes })
    .from(categories)
    .orderBy(asc(categories.name));
}
