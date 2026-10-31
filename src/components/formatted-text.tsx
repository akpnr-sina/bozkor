import type { ReactNode } from "react";

const BULLET = /^\s*[-•*]\s+/;
// A list item's own number: "2.1", "3.4.", "1.", "1)", "a)", "(b)". "10.000 adet" is not one.
const NUMBERED = /^\s*((?:\d{1,2}\.)+\d{0,2}|\d{1,2}\)|\(?[a-z]\))\s+(?=\S)/;
// A lead longer than this is a sentence ("İhale, aşağıdaki beş lot için ... yürütülmektedir:"), not a heading.
const LEAD_MAX = 60;

type Item = { number: string; text: string; bullets: string[] };

/** How many lines carry their own list number. */
export function numberedLines(text: string): number {
  return text.split(/\r\n?|\n/).filter((line) => NUMBERED.test(line)).length;
}

/**
 * Text laid out the way the Turkish translation writes it: paragraphs split
 * by blank lines and "- " bullet lines. Lines that carry their own numbers
 * ("2.1 ...", "a) ...") become a list with the numbers in a column, so a long
 * item wraps under its text, and bullet lines right under an item are its
 * own. By default that takes two such lines, so one
 * alone stays text ("2.5 MW ..."); `numbered` decides it for a caller that
 * sees more (the lots table, for all its lots together). A short one-line
 * lead ending in ":" right before a list, a blank line between or not, reads
 * as its heading. Other text keeps its own line breaks.
 */
export function FormattedText({ text, className, numbered }: { text: string; className?: string; numbered?: boolean }) {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const asList = numbered ?? numberedLines(text) >= 2;
  const startsList = (block: string) => {
    const first = block.split("\n")[0]!;
    return BULLET.test(first) || (asList && NUMBERED.test(first));
  };
  return (
    <div className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>
      {blocks.flatMap((block, index) => renderBlock(block, index, asList, index + 1 < blocks.length && startsList(blocks[index + 1]!)))}
    </div>
  );
}

function renderBlock(block: string, index: number, numbered: boolean, beforeList: boolean): ReactNode[] {
  const parts: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let items: Item[] = [];
  const key = () => `${index}-${parts.length}`;
  // A list that follows takes a lone short "...:" line as its lead.
  const flushParagraph = (lead: boolean) => {
    if (!paragraph.length) return;
    const isLead = lead && paragraph.length === 1 && paragraph[0]!.endsWith(":") && paragraph[0]!.length <= LEAD_MAX;
    parts.push(
      <p key={key()} className={isLead ? "font-medium whitespace-pre-line text-ink-900" : "whitespace-pre-line"}>
        {paragraph.join("\n")}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    parts.push(bulletList(list, key()));
    list = [];
  };
  const flushItems = () => {
    if (!items.length) return;
    // In the monospace font one ch is one digit, so every text starts in line.
    const width = `${Math.max(...items.map((item) => item.number.length))}ch`;
    parts.push(
      <ol key={key()} className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-baseline gap-2.5">
            <span className="shrink-0 font-mono text-[0.9em] text-ink-500" style={{ minWidth: width }}>
              {item.number}
            </span>
            <div className="min-w-0">
              {item.text}
              {item.bullets.length > 0 && bulletList(item.bullets, "bullets", "mt-1")}
            </div>
          </li>
        ))}
      </ol>,
    );
    items = [];
  };
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const number = numbered ? NUMBERED.exec(line) : null;
    if (BULLET.test(line)) {
      const bullet = line.replace(BULLET, "").trim();
      if (items.length) {
        items[items.length - 1]!.bullets.push(bullet);
      } else {
        flushParagraph(true);
        list.push(bullet);
      }
    } else if (number) {
      flushParagraph(true);
      flushList();
      items.push({ number: number[1]!, text: line.slice(number[0].length).trim(), bullets: [] });
    } else {
      flushList();
      flushItems();
      paragraph.push(line.trim());
    }
  }
  flushParagraph(beforeList);
  flushList();
  flushItems();
  return parts;
}

function bulletList(items: string[], key: string, className?: string): ReactNode {
  return (
    <ul key={key} className={["list-[square] space-y-1 pl-5 marker:text-ink-400", className].filter(Boolean).join(" ")}>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}
