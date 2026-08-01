import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

/** Text-native formats: content is extracted locally and fed to the model as
 *  plain text — no attachment, no vision call needed. */
const TEXT_EXTRACTABLE_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'text/csv',
  'text/plain',
]);

/** Vision formats: sent to Gemini as an attachment, same mechanism the
 *  per-event extraction pipeline already uses — no self-built OCR. */
const VISION_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);

export function isTextExtractable(mimeType: string): boolean {
  return TEXT_EXTRACTABLE_MIME.has(mimeType);
}

export function isVisionReadable(mimeType: string): boolean {
  return VISION_MIME.has(mimeType);
}

export function isSupportedKnowledgeUpload(mimeType: string): boolean {
  return isTextExtractable(mimeType) || isVisionReadable(mimeType);
}

/**
 * Extracts plain text from a text-native document (docx/xlsx/csv/txt) —
 * deterministic and local, no LLM call. Screenshots and PDFs never come
 * through here; they go to Gemini as an attachment instead, exactly like the
 * per-event budget extraction already does.
 */
export async function extractText(mimeType: string, data: Buffer): Promise<string> {
  switch (mimeType) {
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
      const result = await mammoth.extractRawText({ buffer: data });
      return result.value;
    }
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
      const workbook = XLSX.read(data, { type: 'buffer' });
      return workbook.SheetNames.map((name) => {
        const sheet = workbook.Sheets[name];
        return `--- ${name} ---\n${XLSX.utils.sheet_to_csv(sheet)}`;
      }).join('\n\n');
    }
    case 'text/csv':
    case 'text/plain':
      return data.toString('utf-8');
    default:
      throw new Error(`Not a text-extractable mime type: ${mimeType}`);
  }
}
