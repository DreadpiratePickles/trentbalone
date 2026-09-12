import {
  hasGoogleAuthProvider,
  isCredentialsLoginEnabled,
  isDevelopmentLoginEnabled,
} from "@/lib/auth-dev-login";
import { SignInClient } from "./sign-in-client";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <SignInClient
      hasCredentials={isCredentialsLoginEnabled()}
      hasGoogle={hasGoogleAuthProvider()}
      showDemoShortcut={isDevelopmentLoginEnabled()}
    />
  );
}
