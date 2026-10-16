import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormattedText } from "./formatted-text";

const html = (text: string) => renderToStaticMarkup(createElement(FormattedText, { text }));

describe("FormattedText", () => {
  it("shows paragraphs and bullet lists", () => {
    const out = html("Kafe mobilyası alınacak.\n\nÜrünler:\n- 20 sandalye\n- 5 masa\n\nTeslim yeri: Gwynedd.");
    expect(out).toContain("<p class=\"whitespace-pre-line\">Kafe mobilyası alınacak.</p>");
    expect(out).toContain("<p class=\"whitespace-pre-line\">Ürünler:</p><ul class=\"list-disc space-y-1 pl-5\"><li>20 sandalye</li><li>5 masa</li></ul>");
    expect(out).toContain("<p class=\"whitespace-pre-line\">Teslim yeri: Gwynedd.</p>");
  });

  it("keeps a block without blank lines as one paragraph, and a dash inside text as text", () => {
    const out = html("Sıcaklık -5 ile 40 derece arası.\nİkinci satır.");
    expect(out).toContain("Sıcaklık -5 ile 40 derece arası.\nİkinci satır.");
    expect(out).not.toContain("<li>");
  });
});
