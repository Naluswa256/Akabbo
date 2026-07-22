import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

/** One turn to the conversation-scoped AI operating interface. */
export class ConverseDto {
  @IsString()
  @Length(1, 2000)
  message!: string;

  /** Continue an existing conversation; omit to start a new one. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
