import { describe, expect, it } from "vitest";
import { handleSmsKeyword, planSmsSend, planVoiceCall, planWhatsAppSend } from "./channel-adapters";

describe("outbound channel adapters", () => {
  it("enforces Twilio A2P opt-in and STOP/HELP handling", () => {
    expect(() => planSmsSend({ to: "+14155550199", body: "Hi", a2pRegistered: false, optedIn: true })).toThrow("A2P");
    expect(handleSmsKeyword("STOP").status).toBe("opted_out");
    expect(handleSmsKeyword("help").reply).toContain("Help");
  });

  it("enforces WhatsApp templates outside session windows", () => {
    expect(planWhatsAppSend({ sessionOpen: false, templateApproved: true, body: "Template: intro" }).kind).toBe("template");
    expect(() => planWhatsAppSend({ sessionOpen: false, templateApproved: false, body: "Cold hello" })).toThrow("template");
  });

  it("selects voice providers by outbound and IVR capabilities", () => {
    expect(planVoiceCall({ direction: "outbound", needsIvr: false }).provider).toBe("vapi");
    expect(planVoiceCall({ direction: "inbound", needsIvr: true }).provider).toBe("retell");
  });
});
