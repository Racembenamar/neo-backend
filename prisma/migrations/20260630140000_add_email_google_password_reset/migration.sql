ALTER TABLE "players" ALTER COLUMN "passwordHash" DROP NOT NULL;

ALTER TABLE "players" ADD COLUMN "email" TEXT;
ALTER TABLE "players" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "players" ADD COLUMN "googleId" TEXT;
ALTER TABLE "players" ADD COLUMN "authProvider" TEXT NOT NULL DEFAULT 'password';
ALTER TABLE "players" ADD COLUMN "passwordResetCodeHash" TEXT;
ALTER TABLE "players" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "players_email_key" ON "players"("email");
CREATE UNIQUE INDEX "players_googleId_key" ON "players"("googleId");
