import type { SourceAdapter } from "../types";
import { createFatClient, type FatClientOptions } from "./client";
import { fatNoticeKeys, normalizeFatRelease } from "./normalize";

export function createFatAdapter(options: FatClientOptions = {}): SourceAdapter {
  const client = createFatClient(options);
  return {
    id: "uk_fat",
    pages: (window) => client.releasePages(window),
    keys: fatNoticeKeys,
    normalize: normalizeFatRelease,
  };
}
