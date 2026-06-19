type DevLoginEnv = {
  NODE_ENV?: string;
  TRENT_ENABLE_DEV_LOGIN?: string;
  NEXT_PUBLIC_ENABLE_DEV_LOGIN?: string;
};

export function isDevelopmentLoginEnabled(env: DevLoginEnv = process.env): boolean {
  if (env.TRENT_ENABLE_DEV_LOGIN === "1") return true;
  if (env.NEXT_PUBLIC_ENABLE_DEV_LOGIN === "true") return true;
  return env.NODE_ENV !== "production";
}
