import { IsString, Length } from 'class-validator';

export class CaptureDto {
  @IsString()
  @Length(1, 2000)
  utterance!: string;
}

/** One turn to the AI operating interface (the conversational agent). */
export class AssistantDto {
  @IsString()
  @Length(1, 2000)
  message!: string;
}
