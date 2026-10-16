import type { ReactNode } from "react";

const BULLET = /^\s*[-•*]\s+/;

/**
 * Text laid out the way the Turkish translation writes it: paragraphs split
 * by blank lines and "- " bullet lines. Other text keeps its own line breaks.
 */
export function FormattedText({ text, className }: { text: string; className?: string }) {
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return <div className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}>{blocks.flatMap(renderBlock)}</div>;
}

function renderBlock(block: string, index: number): ReactNode[] {
  const parts: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    parts.push(
      <p key={`${index}-${parts.length}`} className="whitespace-pre-line">
        {paragraph.join("\n")}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    parts.push(
      <ul key={`${index}-${parts.length}`} className="list-disc space-y-1 pl-5">
        {list.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    if (BULLET.test(line)) {
      flushParagraph();
      list.push(line.replace(BULLET, "").trim());
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return parts;
}
