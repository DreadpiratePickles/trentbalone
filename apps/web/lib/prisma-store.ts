import { prismaStoreBase } from "./prisma-store-base";
import { prismaStoreDocs } from "./prisma-store-docs";
import { prismaStoreWorkbench } from "./prisma-store-workbench";
import { prismaStoreInfra } from "./prisma-store-infra";
import { prismaStoreBilling } from "./prisma-store-billing";
import { prismaStoreMarketingStripe } from "./prisma-store-marketing-stripe";
import { prismaStoreMarketing } from "./prisma-store-marketing";
import { prismaStoreSocial } from "./prisma-store-social";
import { prismaStoreWebhooks } from "./prisma-store-webhooks";

export const prismaStore = {
  ...prismaStoreBase,
  ...prismaStoreDocs,
  ...prismaStoreWorkbench,
  ...prismaStoreInfra,
  ...prismaStoreBilling,
  ...prismaStoreMarketingStripe,
  ...prismaStoreMarketing,
  ...prismaStoreSocial,
  ...prismaStoreWebhooks,
};
