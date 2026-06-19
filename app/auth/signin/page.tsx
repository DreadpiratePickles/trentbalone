"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { ConsoleMark, Wordmark, Atmosphere, I } from "@/components/ui";
import { isDevelopmentLoginEnabled } from "@/lib/auth-dev-login";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setLoading(true);
    setError("");
    try {
      const result = await signIn("credentials", {
        email: email.trim(),
        callbackUrl: "/companies",
        redirect: false,
      });
      if (result?.error) {
        setError("Sign-in failed. Check your email and try again.");
        setLoading(false);
      } else if (result?.ok) {
        // Use a relative path so we stay on whatever host the user is browsing
        // (preview URL, custom domain, or localhost) — avoids cross-host
        // redirects to http://localhost:3000 returned by next-auth.
        window.location.href = "/companies";
      } else {
        setError("Sign-in did not complete. Refresh and try again.");
        setLoading(false);
      }
    } catch {
      setError("Sign-in did not complete. Refresh and try again.");
      setLoading(false);
    }
  }

  async function handleGoogle() {
    setLoading(true);
    await signIn("google", { callbackUrl: "/companies" });
  }

  const hasGoogle = process.env.NEXT_PUBLIC_HAS_GOOGLE === "true";
  const hasDevLogin = isDevelopmentLoginEnabled();
  const hasAnyProvider = hasDevLogin || hasGoogle;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--obsidian)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        padding: "24px",
      }}
    >
      {/* Atmospheric glow (mint, top-right) */}
      <div
        style={{
          position: "fixed",
          top: "-10%",
          right: "-5%",
          width: 400,
          height: 400,
          borderRadius: "50%",
          background: "radial-gradient(circle, rgba(110,231,183,.14) 0%, transparent 70%)",
          filter: "blur(40px)",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />
      <Atmosphere />

      {/* Card */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          width: "100%",
          maxWidth: 400,
        }}
      >
        {/* Logo */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 16,
            marginBottom: 40,
          }}
        >
          <ConsoleMark size={36} pulsing />
          <Wordmark size={42} />
          <p
            style={{
              fontFamily: "var(--serif)",
              fontStyle: "italic",
              fontSize: 18,
              color: "var(--mist)",
              textAlign: "center",
              margin: 0,
              lineHeight: 1.4,
            }}
          >
            your company, running.
          </p>
        </div>

        {/* Form card */}
        <div
          style={{
            background: "var(--ink)",
            border: "1px solid rgba(255,255,255,.08)",
            borderRadius: "var(--r-lg)",
            padding: "32px",
          }}
        >
          <h2
            style={{
              margin: "0 0 6px",
              fontFamily: "var(--display)",
              fontWeight: 600,
              fontSize: 18,
              letterSpacing: "-.02em",
              color: "var(--bone)",
            }}
          >
            Sign in to your console
          </h2>
          <p style={{ margin: "0 0 28px", fontSize: 14, color: "var(--mist)", lineHeight: 1.5 }}>
            Sign in to access your companies and agent cycles.
          </p>

          {hasDevLogin && (
            <form onSubmit={handleCredentials}>
              <div style={{ marginBottom: 12 }}>
                <label
                  htmlFor="email"
                  className="mono"
                  style={{
                    display: "block",
                    fontSize: 10,
                    letterSpacing: ".18em",
                    textTransform: "uppercase",
                    color: "var(--haze)",
                    marginBottom: 8,
                  }}
                >
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourcompany.com"
                  required
                  autoComplete="email"
                  autoFocus
                  disabled={loading}
                />
              </div>

              {error && (
                <div
                  style={{
                    background: "rgba(248,113,113,.06)",
                    border: "1px solid rgba(248,113,113,.2)",
                    borderRadius: 8,
                    padding: "10px 14px",
                    fontSize: 13,
                    color: "var(--danger)",
                    marginBottom: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <I.alert width={14} height={14} />
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || !email.trim()}
                style={{
                  width: "100%",
                  height: 44,
                  marginTop: 4,
                  opacity: loading || !email.trim() ? 0.5 : 1,
                  cursor: loading || !email.trim() ? "not-allowed" : "pointer",
                }}
              >
                {loading ? (
                  <span
                    className="spinner"
                    style={{ width: 16, height: 16, borderWidth: 1.5, borderColor: "rgba(10,10,15,.2)", borderTopColor: "var(--obsidian)" }}
                  />
                ) : null}
                Continue with email
              </button>
            </form>
          )}

          {hasGoogle && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  margin: hasDevLogin ? "20px 0" : "0 0 20px",
                }}
              >
                <div className="divider" style={{ flex: 1 }} />
                <span
                  className="mono"
                  style={{ fontSize: 10, letterSpacing: ".14em", color: "var(--haze)" }}
                >
                  or
                </span>
                <div className="divider" style={{ flex: 1 }} />
              </div>

              <button
                className="btn btn-secondary"
                onClick={handleGoogle}
                disabled={loading}
                style={{
                  width: "100%",
                  height: 44,
                  opacity: loading ? 0.5 : 1,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                Continue with Google
              </button>
            </>
          )}

          {!hasAnyProvider && (
            <p style={{ margin: 0, fontSize: 14, color: "var(--mist)", lineHeight: 1.5 }}>
              Sign-in is not configured for this environment.
            </p>
          )}
        </div>

        {hasDevLogin && (
          <button
            className="mono"
            onClick={() => {
              setEmail("demo@trent.app");
              setTimeout(() => {
                document.querySelector<HTMLButtonElement>("form button[type=submit]")?.click();
              }, 100);
            }}
            style={{
              marginTop: 20,
              background: "transparent",
              border: 0,
              cursor: "pointer",
              color: "var(--haze)",
              fontSize: 10,
              letterSpacing: ".14em",
              textTransform: "uppercase",
              textDecoration: "underline",
              textUnderlineOffset: 3,
            }}
          >
            sign in as demo operator
          </button>
        )}
      </div>
    </div>
  );
}
