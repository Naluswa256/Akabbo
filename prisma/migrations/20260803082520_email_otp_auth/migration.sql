-- AlterTable
ALTER TABLE "auth_otp_challenge" ADD COLUMN     "email" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "email" TEXT,
ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "phone" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "auth_otp_challenge_email_idx" ON "auth_otp_challenge"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

