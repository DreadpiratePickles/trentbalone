-- 1. Coerce any unexpected values to 'viewer' first to prevent casting errors
UPDATE "CompanyMember"
SET "role" = 'viewer'
WHERE "role" IS NULL OR "role" NOT IN ('viewer', 'member', 'admin', 'owner');

-- 2. Create the custom Postgres Enum
CREATE TYPE "CompanyMemberRole" AS ENUM ('viewer', 'member', 'admin', 'owner');

-- 3. Alter column type with explicit type cast
ALTER TABLE "CompanyMember" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "CompanyMember" ALTER COLUMN "role" TYPE "CompanyMemberRole" USING "role"::"CompanyMemberRole";
ALTER TABLE "CompanyMember" ALTER COLUMN "role" SET DEFAULT 'viewer';
