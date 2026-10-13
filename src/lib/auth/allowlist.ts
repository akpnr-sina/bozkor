export function parseAllowedEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Fails closed: an empty or missing ALLOWED_EMAILS lets nobody in. */
export function isEmailAllowed(
  email: unknown,
  rawAllowlist: string | undefined = process.env.ALLOWED_EMAILS,
): email is string {
  if (typeof email !== "string" || email.trim() === "") return false;
  return parseAllowedEmails(rawAllowlist).has(email.trim().toLowerCase());
}
