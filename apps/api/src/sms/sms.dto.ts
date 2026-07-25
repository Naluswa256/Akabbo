import { IsArray, IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class SendSmsDto {
  @IsString()
  @Length(1, 1000)
  body!: string;

  /**
   * Optional — target exactly these contributors (get their ids from
   * GET /events/:id/report/contributors) instead of the default recipient
   * set (everyone outstanding for reminders, everyone with a phone for
   * announcements). Anyone listed without a phone number is skipped, same
   * as the default flow.
   */
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  personIds?: string[];
}
