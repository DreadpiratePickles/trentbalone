/**
 * `trent service`: one supervised process for the messaging gateway, the cron runner and the
 * heartbeat (`./supervisor.ts`), its log (`./service-log.ts`), and the launchd / systemd user units
 * that start it at login and restart it when it exits (`./units.ts`, `./install.ts`, `./program.ts`).
 */
export * from "./supervisor.js";
export * from "./service-log.js";
export * from "./units.js";
export * from "./program.js";
export * from "./install.js";
