import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "./redaction";

describe("sensitive-data redaction", () => {
  it("redacts tokens, emails, phones, cards, and nested metadata", () => {
    const redacted = redactSensitiveData({
      authorization: "Bearer sk_live_abc123",
      email: "founder@example.com",
      phone: "+1 (415) 555-0199",
      card: "4242 4242 4242 4242",
      nested: {
        note: "Contact founder@example.com with token ghp_secret1234567890",
      },
    });

    expect(redacted).toEqual({
      authorization: "[REDACTED_TOKEN]",
      email: "[REDACTED_EMAIL]",
      phone: "[REDACTED_PHONE]",
      card: "[REDACTED_CARD]",
      nested: {
        note: "Contact [REDACTED_EMAIL] with token [REDACTED_TOKEN]",
      },
    });
  });
});
