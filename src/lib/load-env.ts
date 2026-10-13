// Loads .env files with the same precedence as Next.js for processes that run
// outside Next (worker, scripts). Import it first in those entry points.
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");
