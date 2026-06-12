export function isHttpHeaderValueSafe(value: string | undefined): boolean {
  if (!value) return false;
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code <= 255 && code !== 127;
  });
}

export function malformedCredentialSummary(provider: string): string {
  return `${provider} credential is malformed: it contains characters that cannot be sent in an HTTP Authorization header. Re-copy the token into a plain-text env var instead of rich text.`;
}
