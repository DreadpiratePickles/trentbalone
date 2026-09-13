/**
 * A port of Hermes `cronjob_prompt_scan.py`: a scheduled prompt runs unattended, so anything that
 * reads like an instruction override, a request to move secrets, or a credential pasted inline is
 * refused at create, update and run. Findings never echo the matched text, so a pasted key does
 * not end up in the summary the model sees or in a log.
 */

export interface PromptFinding {
  category: "instruction_override" | "exfiltration" | "embedded_credential";
  reason: string;
}

interface Rule {
  category: PromptFinding["category"];
  reason: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    category: "instruction_override",
    reason: "asks to ignore or override prior instructions",
    pattern: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|the)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines|system prompt|safety)\b/i,
  },
  {
    category: "instruction_override",
    reason: "attempts to redefine the assistant's role or instructions",
    pattern: /\b(you are now|new instructions:|system prompt:|developer mode|jailbreak|act as (an? )?unrestricted)\b/i,
  },
  {
    category: "exfiltration",
    reason: "asks to send, upload or forward secrets or credential files",
    pattern: /\b(send|post|upload|exfiltrate|forward|email|transmit|leak|share|paste)\b[^.\n]{0,80}\b(api[_ -]?keys?|secrets?|tokens?|passwords?|credentials?|\.env\b|ssh keys?|id_rsa|private keys?|it)\b[^.\n]{0,60}\b(to|at)\b[^.\n]{0,10}\b(https?:\/\/|me\b|this address|the address)/i,
  },
  {
    category: "exfiltration",
    reason: "asks to read a credential file",
    pattern: /\b(cat|read|print|dump|open|copy|show)\b[^.\n]{0,40}(~?\/?\.ssh\/|id_rsa|\.aws\/credentials|\.env\b|\.trent\/\.env|\.netrc|secrets?\.(json|ya?ml)|keychain)/i,
  },
  {
    category: "exfiltration",
    reason: "asks to send secrets or credential files out",
    pattern: /\b(send|post|upload|exfiltrate|forward|email|transmit|leak)\b[^.\n]{0,60}\b(\.env\b|id_rsa|\.ssh|\.aws|credentials?|secrets?|api[_ -]?keys?|tokens?|passwords?)\b/i,
  },
  {
    category: "exfiltration",
    reason: "posts environment secrets with curl or wget",
    pattern: /\b(curl|wget)\b[^\n]{0,120}\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\}?/i,
  },
  { category: "embedded_credential", reason: "contains an OpenAI/Anthropic-style key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { category: "embedded_credential", reason: "contains an AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { category: "embedded_credential", reason: "contains a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { category: "embedded_credential", reason: "contains a Slack token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{20,}\b/ },
  { category: "embedded_credential", reason: "contains a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ },
  { category: "embedded_credential", reason: "contains a JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { category: "embedded_credential", reason: "contains a private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { category: "embedded_credential", reason: "contains an inline password or api key assignment", pattern: /\b(password|passwd|api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i },
];

/** Every rule that matches. Empty means clean. The matched text is never included. */
export function scanPromptForInjection(prompt: string): PromptFinding[] {
  const text = prompt.normalize("NFKC");
  const findings: PromptFinding[] = [];
  for (const rule of RULES) {
    if (rule.pattern.test(text)) findings.push({ category: rule.category, reason: rule.reason });
  }
  return findings;
}
