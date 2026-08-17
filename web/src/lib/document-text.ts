import mammoth from "mammoth";
import WordExtractor from "word-extractor";

export const DOCUMENT_FILE_LIMITS: Record<string, number> = {
  ".txt": 1 * 1024 * 1024,
  ".md": 1 * 1024 * 1024,
  ".markdown": 1 * 1024 * 1024,
  ".pdf": 4 * 1024 * 1024,
  ".doc": 4 * 1024 * 1024,
  ".docx": 4 * 1024 * 1024,
};

export const MAX_EXTRACTED_TEXT_CHARACTERS = 400_000;
export const PROCESSING_CHUNK_CHARACTERS = 80_000;

export function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

export function formatFileSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${bytes / (1024 * 1024)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

export async function extractDocumentText(file: File, extension: string) {
  if ([".txt", ".md", ".markdown"].includes(extension)) {
    return (await file.text()).trim();
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  if (extension === ".pdf") {
    // pdfjs-dist uses these native Canvas exports to install DOMMatrix,
    // ImageData and Path2D in Node. Keeping both imports inside the PDF
    // branch prevents their module initialization from breaking unrelated
    // Capture formats and makes the native dependency visible to Vercel's
    // output-file tracer.
    await import("@napi-rs/canvas");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      return (await parser.getText()).text.trim();
    } finally {
      await parser.destroy();
    }
  }
  if (extension === ".docx") {
    return (await mammoth.extractRawText({ buffer })).value.trim();
  }
  if (extension === ".doc") {
    return (await new WordExtractor().extract(buffer)).getBody().trim();
  }
  throw new Error("Nicht unterstützter Dateityp");
}

export function splitDocumentText(text: string): string[] {
  if (text.length <= PROCESSING_CHUNK_CHARACTERS) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > PROCESSING_CHUNK_CHARACTERS) {
    const window = remaining.slice(0, PROCESSING_CHUNK_CHARACTERS);
    const naturalBreak = Math.max(
      window.lastIndexOf("\n\n"),
      window.lastIndexOf("\n"),
      window.lastIndexOf(". ") + 1,
    );
    const splitAt =
      naturalBreak > PROCESSING_CHUNK_CHARACTERS * 0.6
        ? naturalBreak
        : PROCESSING_CHUNK_CHARACTERS;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
