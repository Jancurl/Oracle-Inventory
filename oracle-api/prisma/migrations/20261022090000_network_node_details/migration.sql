-- Network map devices (ISP / firewall / managed switch / switch) record their
-- hardware: brand, model and serial number.

-- AlterTable
ALTER TABLE "NetworkNode" ADD COLUMN "brand" TEXT,
ADD COLUMN "model" TEXT,
ADD COLUMN "serialNumber" TEXT;
