-- Profile photo for each employee record, one row per employee.
CREATE TABLE "EmployeePhoto" (
    "employeeId" TEXT NOT NULL,
    "mimeType"   TEXT NOT NULL,
    "data"       BYTEA NOT NULL,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmployeePhoto_pkey" PRIMARY KEY ("employeeId")
);

ALTER TABLE "EmployeePhoto" ADD CONSTRAINT "EmployeePhoto_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;
