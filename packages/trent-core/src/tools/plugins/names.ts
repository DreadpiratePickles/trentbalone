/**
 * The `plugins` adapter's own names, in a leaf module. `tool-names.ts` reads them to reserve them,
 * and the manifest check (`manifest.ts`) reads `tool-names.ts`, so they cannot live in `index.ts`
 * (which imports `manifest.ts`) without an import cycle.
 */
export const PLUGINS_ADAPTER_NAME = "plugins";
export const PLUGINS_LIST_TOOL = "plugins_list";
