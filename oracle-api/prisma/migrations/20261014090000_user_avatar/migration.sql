-- Profile photo for each login account, one row per user.
CREATE TABLE "UserAvatar" (
    "userId"    TEXT NOT NULL,
    "mimeType"  TEXT NOT NULL,
    "data"      BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAvatar_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserAvatar" ADD CONSTRAINT "UserAvatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "SystemUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
