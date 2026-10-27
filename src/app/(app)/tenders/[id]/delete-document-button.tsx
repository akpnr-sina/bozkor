"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { deleteDocument } from "./document-actions";

/** Deletes an uploaded file after asking; a ZIP goes with the files that came out of it. */
export function DeleteDocumentButton({ tenderId, documentId, name, members }: { tenderId: string; documentId: string; name: string; members: number }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function remove() {
    const question = members ? `"${name}" ve içinden çıkan ${members} dosya silinsin mi?` : `"${name}" silinsin mi?`;
    if (!window.confirm(question)) return;
    startTransition(async () => {
      const result = await deleteDocument(tenderId, documentId);
      setError(result.ok ? null : result.error);
    });
  }

  return (
    <>
      <Button type="button" variant="destructive-outline" size="xs" disabled={pending} onClick={remove} aria-label={`${name} dosyasını sil`}>
        {pending ? "Siliniyor..." : "Sil"}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-err">
          {error}
        </span>
      )}
    </>
  );
}
