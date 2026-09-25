/**
 * [P1-D] The `connect:` block of `config.yaml`: how `trent connect` credentials are READ across
 * profiles. It holds no value itself; the values live in each profile's `.env`.
 *
 * `inherit_default`: a profile other than `default` resolves a `trent connect` provider it has not
 * connected itself from the default profile's secrets file (`connect/store.ts`), so one grant
 * serves every profile on the machine. The profile's own file wins whenever it names any of the
 * provider's values; the default file is only ever read, never written, and an inherited OAuth
 * token is not refreshed from the other profile. Model keys and gateway tokens are not inherited.
 * `false` reads the profile's own file only. The block is `connect.*`, not `secrets.*`, because
 * `trent config set secrets.<name>` is the explicit route INTO the secrets file
 * (`config/secrets-policy.ts`); `trent config set connect.inherit_default false` edits config.yaml.
 */
import { z } from "zod";

export const ConnectConfigSchema = z
  .object({
    inherit_default: z.boolean().default(true),
  })
  .strict();

export type ConnectConfig = z.infer<typeof ConnectConfigSchema>;
