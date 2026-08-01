import { IsBase64, IsOptional, IsString, Length } from 'class-validator';

export class UploadBudgetKnowledgeDto {
  @IsString()
  @Length(1, 255)
  filename!: string;

  @IsString()
  mimeType!: string;

  /** File bytes, base64-encoded — same transport convention as the per-event
   *  document upload (multipart is a thin adapter later, not the source of truth). */
  @IsBase64()
  dataBase64!: string;

  /** Admin's own read on what this budget is for, e.g. "kwanjula". Takes
   *  precedence over whatever the model infers — the admin already knows
   *  what they're uploading. */
  @IsOptional()
  @IsString()
  eventTypeHint?: string;

  @IsOptional()
  @IsString()
  regionHint?: string;

  /** Free text for licensingNote, e.g. how this was sourced/who vetted it. */
  @IsOptional()
  @IsString()
  note?: string;
}
