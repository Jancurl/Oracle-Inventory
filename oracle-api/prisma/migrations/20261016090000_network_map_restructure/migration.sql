-- Network page restructure: replaces the generic interface/port/VLAN/IP
-- topology tables (all empty when this was written) with a simple map —
-- NetworkNode (ISP / firewall / managed switch / switch tree) and
-- DeviceConnection (one row per laptop/desktop: wired switch+port+ISP, or
-- Wi-Fi ISP only). NetworkDeviceCredential is kept.

-- CreateEnum
CREATE TYPE "NetworkNodeType" AS ENUM ('isp', 'firewall', 'managed_switch', 'switch');

-- CreateEnum
CREATE TYPE "NetworkConnectionType" AS ENUM ('wired', 'wifi');

-- DropForeignKey
ALTER TABLE "NetworkInterface" DROP CONSTRAINT "NetworkInterface_assetId_fkey";

-- DropForeignKey
ALTER TABLE "IpAddressObservation" DROP CONSTRAINT "IpAddressObservation_interfaceId_fkey";

-- DropForeignKey
ALTER TABLE "Vlan" DROP CONSTRAINT "Vlan_branchId_fkey";

-- DropForeignKey
ALTER TABLE "InterfaceVlanAssignment" DROP CONSTRAINT "InterfaceVlanAssignment_interfaceId_fkey";

-- DropForeignKey
ALTER TABLE "InterfaceVlanAssignment" DROP CONSTRAINT "InterfaceVlanAssignment_vlanId_fkey";

-- DropForeignKey
ALTER TABLE "NetworkPort" DROP CONSTRAINT "NetworkPort_assetId_fkey";

-- DropForeignKey
ALTER TABLE "PortConnection" DROP CONSTRAINT "PortConnection_fromPortId_fkey";

-- DropForeignKey
ALTER TABLE "PortConnection" DROP CONSTRAINT "PortConnection_toPortId_fkey";

-- DropForeignKey
ALTER TABLE "PortConnection" DROP CONSTRAINT "PortConnection_toInterfaceId_fkey";

-- DropForeignKey
ALTER TABLE "PortConnection" DROP CONSTRAINT "PortConnection_branchId_fkey";

-- DropForeignKey
ALTER TABLE "FirewallProfile" DROP CONSTRAINT "FirewallProfile_managementInterfaceId_fkey";

-- AlterTable
ALTER TABLE "FirewallProfile" DROP COLUMN "managementInterfaceId";

-- DropTable
DROP TABLE "NetworkInterface";

-- DropTable
DROP TABLE "IpAddressObservation";

-- DropTable
DROP TABLE "Vlan";

-- DropTable
DROP TABLE "InterfaceVlanAssignment";

-- DropTable
DROP TABLE "NetworkPort";

-- DropTable
DROP TABLE "PortConnection";

-- DropEnum
DROP TYPE "IpAddressFamily";

-- DropEnum
DROP TYPE "AddressingMode";

-- DropEnum
DROP TYPE "VlanTaggingMode";

-- DropEnum
DROP TYPE "PortStatus";

-- DropEnum
DROP TYPE "LinkType";

-- CreateTable
CREATE TABLE "NetworkNode" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" "NetworkNodeType" NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "parentPort" TEXT,
    "portCount" INTEGER,
    "location" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NetworkNode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceConnection" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "connectionType" "NetworkConnectionType" NOT NULL,
    "switchId" TEXT,
    "switchPort" TEXT,
    "ispId" TEXT,
    "notes" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NetworkNode_branchId_type_idx" ON "NetworkNode"("branchId", "type");

-- CreateIndex
CREATE INDEX "NetworkNode_parentId_idx" ON "NetworkNode"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "NetworkNode_branchId_name_key" ON "NetworkNode"("branchId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceConnection_assetId_key" ON "DeviceConnection"("assetId");

-- CreateIndex
CREATE INDEX "DeviceConnection_switchId_switchPort_idx" ON "DeviceConnection"("switchId", "switchPort");

-- CreateIndex
CREATE INDEX "DeviceConnection_ispId_idx" ON "DeviceConnection"("ispId");

-- AddForeignKey
ALTER TABLE "NetworkNode" ADD CONSTRAINT "NetworkNode_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkNode" ADD CONSTRAINT "NetworkNode_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "NetworkNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_switchId_fkey" FOREIGN KEY ("switchId") REFERENCES "NetworkNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_ispId_fkey" FOREIGN KEY ("ispId") REFERENCES "NetworkNode"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Deny direct client-role access on Supabase-hosted Postgres; the API
-- connects as the table owner and is unaffected.
ALTER TABLE "NetworkNode" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DeviceConnection" ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "NetworkNode" FROM anon, authenticated;
    REVOKE ALL ON TABLE "DeviceConnection" FROM anon, authenticated;
  END IF;
END $$;
