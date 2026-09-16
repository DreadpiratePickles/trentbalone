import { memStoreBase } from "./mem-store-base";
import { memStoreDocs } from "./mem-store-docs";
import { memStoreBilling } from "./mem-store-billing";
import { memStoreMarketingStripe } from "./mem-store-marketing-stripe";
import { memStoreMarketing } from "./mem-store-marketing";
import { memStoreSocial } from "./mem-store-social";
import { memStoreWebhooks } from "./mem-store-webhooks";

export const memStore = {
  ...memStoreBase,
  ...memStoreDocs,
  ...memStoreBilling,
  ...memStoreMarketingStripe,
  ...memStoreMarketing,
  ...memStoreSocial,
  ...memStoreWebhooks,
};
