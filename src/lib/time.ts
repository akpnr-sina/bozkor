const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock time of `date` in `timeZone`, as "YYYY-MM-DDTHH:mm:ss" without an offset. */
export function toZonedLocal(date: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const { type, value } of formatterFor(timeZone).formatToParts(date)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function offsetMs(instant: number, timeZone: string): number {
  const wholeSeconds = Math.floor(instant / 1000) * 1000;
  return Date.parse(`${toZonedLocal(new Date(wholeSeconds), timeZone)}Z`) - wholeSeconds;
}

const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/** Interprets an offset-less local date-time as wall-clock time in `timeZone`. */
export function zonedLocalToUtc(local: string, timeZone: string): Date | null {
  const m = LOCAL_PATTERN.exec(local.trim());
  if (!m) return null;
  const asUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
  // Two passes settle the offset around DST transitions.
  let guess = asUtc - offsetMs(asUtc, timeZone);
  guess = asUtc - offsetMs(guess, timeZone);
  return new Date(guess);
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses an ISO 8601 timestamp. Values without an offset are read as local
 * time in `defaultTimeZone` instead of the server's zone.
 */
export function parseTimestamp(value: string | null | undefined, defaultTimeZone: string): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (HAS_OFFSET.test(trimmed)) {
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms);
  }
  return zonedLocalToUtc(trimmed, defaultTimeZone);
}
