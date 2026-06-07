export function evaluateDeliverability(input: {
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
  postmasterConnected: boolean;
}) {
  const missing: string[] = [];
  if (!input.spf) missing.push("spf");
  if (!input.dkim) missing.push("dkim");
  if (!input.dmarc) missing.push("dmarc");
  if (!input.postmasterConnected) missing.push("postmaster_tools");
  return {
    ready: missing.length === 0,
    missing,
  };
}
