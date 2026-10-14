import type { SourceAdapter } from "../types";
import { createTedClient, type TedClientOptions } from "./client";
import { normalizeTedNotice, tedNoticeKeys } from "./normalize";

export function createTedAdapter(options: TedClientOptions = {}): SourceAdapter {
  const client = createTedClient(options);
  return {
    id: "eu_ted",
    pages: (window) => client.noticePages(window),
    keys: tedNoticeKeys,
    normalize: normalizeTedNotice,
  };
}
