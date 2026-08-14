import type { SupabaseClient } from "@supabase/supabase-js";
import { createEmbeddings } from "@/lib/openai";
import { countTokens, splitByTokenWindow } from "@/lib/token-count";

export const DOCUMENT_CHUNK_MAX_TOKENS = 700;
export const DOCUMENT_CHUNK_OVERLAP_TOKENS = 100;
const EMBEDDING_BATCH_SIZE = 64;
const INSERT_BATCH_SIZE = 100;

interface StoreDocumentChunksParams {
  supabase: SupabaseClient;
  contextSpaceId: string;
  contextId?: string;
  documentId: string;
  text: string;
  safetyIdentifier: string;
}

export async function storeDocumentChunks({
  supabase,
  contextSpaceId,
  contextId,
  documentId,
  text,
  safetyIdentifier,
}: StoreDocumentChunksParams): Promise<number> {
  const chunks = splitByTokenWindow(
    text,
    DOCUMENT_CHUNK_MAX_TOKENS,
    DOCUMENT_CHUNK_OVERLAP_TOKENS,
  );
  if (chunks.length === 0) return 0;

  const embeddings: (number[] | null)[] = chunks.map(() => null);
  for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(start, start + EMBEDDING_BATCH_SIZE);
    try {
      const batchEmbeddings = await createEmbeddings(batch, safetyIdentifier);
      if (batchEmbeddings.length !== batch.length) {
        throw new Error(
          `Embedding count mismatch: expected ${batch.length}, got ${batchEmbeddings.length}`,
        );
      }
      batchEmbeddings.forEach((embedding, index) => {
        embeddings[start + index] = embedding;
      });
    } catch (error) {
      // The exact text still enters FTS. A later backfill can add vectors;
      // one provider failure must not make the uploaded source disappear.
      console.error(
        `Failed to embed document chunk batch for document ${documentId}:`,
        error,
      );
    }
  }

  const rows = chunks.map((content, chunkIndex) => ({
    context_space_id: contextSpaceId,
    document_id: documentId,
    context_id: contextId ?? null,
    chunk_index: chunkIndex,
    content,
    token_count: countTokens(content),
    embedding: embeddings[chunkIndex],
  }));

  for (let start = 0; start < rows.length; start += INSERT_BATCH_SIZE) {
    const { error } = await supabase
      .from("document_chunks")
      .insert(rows.slice(start, start + INSERT_BATCH_SIZE));
    if (error) {
      throw new Error(`Failed to store document chunks: ${error.message}`);
    }
  }
  return rows.length;
}
