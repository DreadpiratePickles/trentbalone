import NextAuth from "next-auth";
import type { Provider } from "next-auth/providers";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { isDevelopmentLoginEnabled } from "@/lib/auth-dev-login";
import { db } from "@/lib/db";
import { makeId } from "@/lib/utils";

// ─── NextAuth type augmentation ──────────────────────────────────────────────
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
    };
  }
}

// ─── Providers ───────────────────────────────────────────────────────────────
const providers: Provider[] = [];

if (isDevelopmentLoginEnabled()) {
  providers.push(Credentials({
    name: "Development Login",
    credentials: {
      email: { label: "Email", type: "email", placeholder: "you@example.com" }
    },
    async authorize(credentials) {
      const email = String(credentials?.email || "founder@trent.local").trim();
      if (!email || !email.includes("@")) return null;
      return {
        id: `user_${email.replace(/[^a-z0-9]/gi, "_")}`,
        email,
        name: email.split("@")[0]
      };
    }
  }));
}

const googleClientId = process.env.AUTH_GOOGLE_ID || process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.AUTH_GOOGLE_SECRET || process.env.GOOGLE_CLIENT_SECRET;
if (googleClientId && googleClientSecret) {
  providers.push(
    Google({
      clientId: googleClientId,
      clientSecret: googleClientSecret
    })
  );
}

// ─── NextAuth config ─────────────────────────────────────────────────────────
const useSecureCookies =
  process.env.NODE_ENV === "production" ||
  process.env.AUTH_URL?.startsWith("https://") ||
  process.env.NEXTAUTH_URL?.startsWith("https://");

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers,
  session: { strategy: "jwt" },
  trustHost: true,
  secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
  cookies: {
    sessionToken: {
      name: useSecureCookies ? "__Secure-authjs.session-token" : "authjs.session-token",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: useSecureCookies,
      },
    },
  },

  pages: {
    signIn: "/auth/signin",
    error: "/auth/signin"
  },

  callbacks: {
    // Persist the DB user ID into the JWT the first time a user signs in.
    async jwt({ token, user }) {
      if (user && user.email) {
        if (process.env.DATABASE_URL) {
          // Upsert a real User row and store the stable DB id in the token.
          try {
            const dbUser = await db.user.upsert({
              where: { email: user.email },
              update: { name: user.name ?? undefined },
              create: {
                id: user.id ?? makeId("user"),
                email: user.email,
                name: user.name ?? undefined
              }
            });
            token.sub = dbUser.id;
          } catch {
            // If DB is unavailable during sign-in, fall back to the derived id.
            token.sub = user.id ?? `user_${user.email.replace(/[^a-z0-9]/gi, "_")}`;
          }
        } else {
          // In-memory mode – use the id from the credentials provider.
          token.sub = user.id ?? `user_${user.email.replace(/[^a-z0-9]/gi, "_")}`;
        }
      }
      return token;
    },

    // Expose user.id on the session object so API routes can read it directly.
    session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    }
  }
});
