/**
 * The Trent release public key, in minisign's public-key file format.
 *
 * This is a verbatim copy of `scripts/installer/keys/minisign.pub` (the key id is in the untrusted
 * comment), because the installer and the updater verify the same `SHA256SUMS.minisig`.
 * `__tests__/publicKey.test.ts` fails if this constant and that file ever differ. Never generate a
 * second keypair; the private half lives ONLY in `scripts/installer/keys/minisign.key` (gitignored)
 * and the release job's secret store.
 */

export const TRENT_RELEASE_PUBLIC_KEY_IS_PLACEHOLDER = false;

export const TRENT_RELEASE_PUBLIC_KEY = [
  "untrusted comment: minisign public key 95449402BB103CCE",
  "RWTOPBC7ApREla1RnDwQK1ESwQnVgjtUc3N5o7zgc+JANMV8lU9pLtc7",
  "",
].join("\n");
