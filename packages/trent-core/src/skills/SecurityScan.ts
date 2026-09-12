export interface SecurityScanResult {
  safe: boolean;
  score: number; // 0 to 1.0 (1.0 = completely clean)
  findings: string[];
}

export class SecurityScan {
  private static DANGEROUS_PATTERNS = [
    { pattern: /rm\s+-rf\s+[\/~]/i, reason: "Dangerous recursive root/home deletion" },
    { pattern: /curl\s+.*\|\s*(bash|sh)/i, reason: "Arbitrary remote code execution via pipe to shell" },
    { pattern: /wget\s+.*\|\s*(bash|sh)/i, reason: "Arbitrary remote code execution via pipe to shell" },
    { pattern: /eval\s*\(.*process\.env/i, reason: "Dynamic evaluation of environment secrets" },
    { pattern: /(cat\s+~?\/.ssh\/|cat\s+~?\/.trent\/.env)/i, reason: "Unauthorized attempt to read secret files" },
    { pattern: /ignore\s+all\s+previous\s+instructions/i, reason: "Prompt injection / jailbreak attempt" },
    { pattern: /system\s+override\s+mode/i, reason: "Prompt injection attempt" },
    { pattern: /webhook\s*:\s*https?:\/\/(?!trent\.app)/i, reason: "Untrusted external exfiltration webhook" },
  ];

  public static scan(content: string): SecurityScanResult {
    const findings: string[] = [];

    for (const item of this.DANGEROUS_PATTERNS) {
      if (item.pattern.test(content)) {
        findings.push(item.reason);
      }
    }

    const safe = findings.length === 0;
    const score = safe ? 1.0 : Math.max(0, 1.0 - findings.length * 0.35);

    return {
      safe,
      score: Number(score.toFixed(2)),
      findings,
    };
  }
}
