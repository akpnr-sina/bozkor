/**
 * Reads a required environment variable at call time, so importing a module
 * never fails during `next build` or in tests that do not touch that variable.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
