-- Provenance: semantically aligned with oracle-api/prisma/migrations/20261014100000_employee_photo/migration.sql
-- Scope: profile photo for each employee record, one row per employee. The
-- image bytes are stored inline (BYTEA); the API resizes and caps them at 1MB.

CREATE TABLE "EmployeePhoto" (
    "employeeId" TEXT NOT NULL,
    "mimeType"   TEXT NOT NULL,
    "data"       BYTEA NOT NULL,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePhoto_pkey" PRIMARY KEY ("employeeId")
);

ALTER TABLE "EmployeePhoto" ADD CONSTRAINT "EmployeePhoto_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Served only through the API; deny direct client-role access on
-- Supabase-hosted Postgres, consistent with the other tables in this schema.
ALTER TABLE "EmployeePhoto" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "EmployeePhoto" FROM anon, authenticated;
