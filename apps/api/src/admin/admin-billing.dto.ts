import { IsString, Length } from 'class-validator';

export class ReconcileInvoiceDto {
  /** The Muda transaction id the admin confirmed on the Muda dashboard. */
  @IsString()
  @Length(1, 200)
  gatewayTransactionId!: string;
}
