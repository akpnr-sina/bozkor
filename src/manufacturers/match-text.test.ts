import { describe, expect, it } from "vitest";
import { fold, holdsCode, isGeneric, isWeak, phrases, standardCodes, stem, termIndex, terms, weight } from "./match-text";

const termsOf = (text: string) => terms(text).map((t) => t.term);

describe("fold and stem", () => {
  it("folds Turkish letters the Turkish way", () => {
    expect(fold("IŞIK Jeneratör Çadır")).toBe("isik jenerator cadir");
    expect(fold("İŞ GÜVENLİĞİ")).toBe("is guvenligi");
  });

  it("brings the forms of a word together, hardening a softened last consonant", () => {
    expect(new Set(["ayakkabı", "ayakkabısı", "ayakkabıları", "ayakkabılar"].map((w) => stem(fold(w))))).toEqual(new Set(["ayakkap"]));
    expect(stem(fold("güvenliği"))).toBe(stem(fold("güvenlik")));
    expect(stem(fold("botu"))).toBe("bot");
    expect(stem(fold("botları"))).toBe("bot");
    expect(stem(fold("lastiği"))).toBe("lastik");
  });

  it("cuts the maker's -cı, so a firefighter's suit and firefighting meet", () => {
    expect(stem(fold("itfaiyeci"))).toBe(stem(fold("itfaiye")));
    expect(stem(fold("kaynakçı"))).toBe("kaynak");
  });

  it("keeps -lı/-lu, so a describing word stays apart from the product", () => {
    expect(stem(fold("motorlu"))).not.toBe(stem(fold("motorları")));
    expect(stem(fold("motorları"))).toBe("motor");
  });
});

describe("terms", () => {
  it("drops stop words, numbers and codes, and repeats", () => {
    expect(termsOf("İş güvenliği botu alımı ve teslimi, 6 kW, EN 388, botlar")).toEqual(["guvenlik", "ayakkap"]);
  });

  it("makes synonyms one term", () => {
    expect(termsOf("taşınabilir jeneratör")).toEqual(termsOf("Portatif jeneratörler"));
    expect(termsOf("römorklu")).toEqual(termsOf("çekilir"));
    expect(termsOf("iş botu")).toEqual(termsOf("emniyet ayakkabısı").filter((t) => !isWeak(t)));
  });

  it("marks materials and uses as weak, product nouns as not", () => {
    expect(isWeak(termsOf("aydınlatma")[0]!)).toBe(true);
    expect(isWeak(termsOf("çelik")[0]!)).toBe(true);
    expect(isWeak(termsOf("motorlu")[0]!)).toBe(true);
    expect(isWeak(termsOf("armatür")[0]!)).toBe(false);
    expect(isWeak(termsOf("kule")[0]!)).toBe(false);
  });
});

describe("weight", () => {
  it("weighs a rare term above a common one, and a weak one below both", () => {
    const index = termIndex([["civata", "vida"], ["civata"], ["civata", "ayakkap"], ["celik", "civata"]]);
    expect(weight(index, "ayakkap")).toBeGreaterThan(weight(index, "civata"));
    expect(weight(index, "celik")).toBeLessThan(weight(index, "civata"));
    expect(weight(index, "yok")).toBeGreaterThan(0);
  });
});

describe("standardCodes", () => {
  it("writes each standard one way, whatever the prefixes and the year", () => {
    expect(standardCodes("EN ISO 20471:2013")).toEqual(["ISO20471"]);
    expect(standardCodes("TS EN ISO 20471")).toEqual(["ISO20471"]);
    expect(standardCodes("TS ISO EN 8528-13 (kaynakta bu biçimde)")).toEqual(["ISO8528-13"]);
    expect(standardCodes("ISO 9001:2015 (bitiş tarihi bilinmiyor);AQAP 2110 (2028-09-25)")).toEqual(["ISO9001", "AQAP2110"]);
    expect(standardCodes("AS/EN 9100")).toEqual(["AS9100"]);
    expect(standardCodes("CE EN 14399")).toEqual(["EN14399", "CE"]);
    expect(standardCodes("DIN 931;EN 388")).toEqual(["DIN931", "EN388"]);
  });

  it("finds nothing in a text without a code", () => {
    expect(standardCodes("Yangına dayanıklılık belgesi")).toEqual([]);
  });

  it("holds a code named exactly, a part of it, or its family, but not a different number", () => {
    expect(holdsCode(["ISO20345"], "ISO20345")).toBe(true);
    expect(holdsCode(["ISO8528-5"], "ISO8528")).toBe(true);
    expect(holdsCode(["ISO8528"], "ISO8528-13")).toBe(true);
    expect(holdsCode(["ISO2034"], "ISO20345")).toBe(false);
    expect(holdsCode([], "CE")).toBe(false);
  });
});

describe("phrases", () => {
  const heads = (text: string) => phrases(text).map((p) => [p.text, p.head.word, p.modifiers.map((m) => m.word)]);

  it("splits a product phrase into items, each with its head noun and the words before it", () => {
    expect(heads("rechapé ve yeni kamyon lastiği")).toEqual([
      ["rechapé", "rechapé", []],
      ["yeni kamyon lastiği", "lastiği", ["kamyon"]],
    ]);
    expect(heads("elektrik malzemesi, kablo ve piller").map(([, head]) => head)).toEqual(["malzemesi", "kablo", "piller"]);
  });

  it("passes a collective head to the word before it, and marks generic heads", () => {
    expect(phrases("Dizel jeneratör setleri")[0]!.head.word).toBe("jeneratör");
    expect(phrases("tanısal görüntüleme cihazı")[0]).toMatchObject({ generic: true, head: { word: "cihazı" } });
    expect(isGeneric(phrases("çocuk oyun alanı ekipmanı")[0]!.head.canon)).toBe(true);
  });

  it("reads a parenthesis of several words as items of its own, so the main item keeps its head", () => {
    expect(heads("itfaiye çıkış kıyafeti (ceket ve pantolon)")).toEqual([
      ["itfaiye çıkış kıyafeti", "kıyafeti", ["itfaiye", "çıkış"]],
      ["ceket", "ceket", []],
      ["pantolon", "pantolon", []],
    ]);
    expect(heads("bot (şişme kurtarma botu), can yeleği").map(([text]) => text)).toEqual(["bot", "can yeleği", "şişme kurtarma botu"]);
  });

  it("gives a parenthesis of one word or of describing words to the item it follows", () => {
    expect(heads("şişme kurtarma botu (motorlu)")).toEqual([["şişme kurtarma botu", "botu", ["şişme", "kurtarma", "motorlu"]]]);
    expect(heads("kurtarma botu (motorlu) ve can yeleği")).toEqual([
      ["kurtarma botu", "botu", ["kurtarma", "motorlu"]],
      ["can yeleği", "yeleği", ["can"]],
    ]);
    // The clothing in general keeps nothing more specific beside its head.
    expect(heads("mont (kapüşonlu) ve iş kıyafeti")).toEqual([
      ["mont", "mont", ["kapüşonlu"]],
      ["iş kıyafeti", "kıyafeti", []],
    ]);
    expect(heads("iş eldiveni (deri)")).toEqual([["iş eldiveni", "eldiveni", ["deri"]]]);
    expect(heads("(motorlu) bot, (yüksek görünürlüklü) yelek")).toEqual([
      ["bot", "bot", ["motorlu"]],
      ["yelek", "yelek", ["yüksek", "görünürlüklü"]],
    ]);
    // With no item before it, the parenthesis is the item.
    expect(heads("dizel (jeneratör)")).toEqual([["jeneratör", "jeneratör", ["dizel"]]]);
    expect(heads("iş güvenliği ayakkabısı (S3)")).toEqual([["iş güvenliği ayakkabısı", "ayakkabısı", ["güvenliği"]]]);
  });

  it("gives a lone describing word to the next item's head", () => {
    expect(heads("Benzinli ve dizel portatif jeneratörler")).toEqual([["dizel portatif jeneratörler", "jeneratörler", ["Benzinli", "dizel", "portatif"]]]);
    expect(heads("hafif ticari ve 4x4 lastiği")).toEqual([["4x4 lastiği", "lastiği", ["hafif", "ticari"]]]);
  });
});
