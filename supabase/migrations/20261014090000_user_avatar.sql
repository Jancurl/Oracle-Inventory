-- Provenance: semantically aligned with oracle-api/prisma/migrations/20261014090000_user_avatar/migration.sql
-- Scope: profile photo for each login account, one row per user. The image
-- bytes are stored inline (BYTEA); the API resizes and caps them at 1MB.

CREATE TABLE "UserAvatar" (
    "userId"    TEXT NOT NULL,
    "mimeType"  TEXT NOT NULL,
    "data"      BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserAvatar_pkey" PRIMARY KEY ("userId")
);

ALTER TABLE "UserAvatar" ADD CONSTRAINT "UserAvatar_userId_fkey" FOREIGN KEY ("userId") REFERENCES "SystemUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Served only through the API; deny direct client-role access on
-- Supabase-hosted Postgres, consistent with the other tables in this schema.
ALTER TABLE "UserAvatar" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "UserAvatar" FROM anon, authenticated;
