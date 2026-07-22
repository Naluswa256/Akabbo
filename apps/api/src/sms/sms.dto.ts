import { IsString, Length } from 'class-validator';

export class SendSmsDto {
  @IsString()
  @Length(1, 1000)
  body!: string;
}
