import { ExtractionKind, FileKind } from '@prisma/client';
import { IsBase64, IsEnum, IsOptional, IsString, Length } from 'class-validator';

export class UploadFileDto {
  @IsEnum(FileKind)
  kind!: FileKind;

  @IsString()
  mimeType!: string;

  /** File bytes, base64-encoded (multipart is a thin transport adapter later). */
  @IsBase64()
  dataBase64!: string;

  @IsOptional()
  @IsString()
  @Length(1, 255)
  filename?: string;

  /** Attach to a person (contributor photo / evidence, §17). */
  @IsOptional()
  @IsString()
  personId?: string;
}

export class SubmitDocumentDto {
  @IsString()
  fileId!: string;

  @IsOptional()
  @IsEnum(ExtractionKind)
  kind?: ExtractionKind;
}
