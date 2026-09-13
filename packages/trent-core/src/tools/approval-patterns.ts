/**
 * Hermes's command-safety tables, ported from `tools/approval_detection.py` (HARDLINE_PATTERNS
 * `:88-125`, DANGEROUS_PATTERNS `:200-411`). The Windows tier and the Hermes-gateway lifecycle
 * rules are omitted: Trent's sandboxes are POSIX and the gateway is a different process here.
 *
 * Every pattern is compiled with `is` (IGNORECASE | DOTALL), exactly like Hermes's `_RE_FLAGS`.
 * Descriptions are the approval keys a human sees, so they stay verbatim.
 */

/**
 * Start-of-command position: start of string, newline, subshell opener, optionally consuming
 * sudo / env VAR=VAL / exec|nohup|setsid|time wrappers. Real `;`/`&`/`|` separators are turned
 * into newlines by the quote-aware pass in `approval-floors.ts`, never matched here, so quoted
 * data (`grep '(safe|rm -rf /)'`) is not mistaken for a command.
 */
export const CMDPOS =
  String.raw`(?:^|[\n\`]|\$\()\s*` +
  String.raw`(?:sudo\s+(?:-[^\s]+\s+)*)?(?:env\s+(?:\w+=\S*\s+)*)?` +
  String.raw`(?:(?:exec|nohup|setsid|time)\s+)*\s*`;

const RM_FLAG_PREFIX = CMDPOS + String.raw`rm\s+(-[^\s]*\s+)*`;
const PKG_OPTS = String.raw`(?:-[^\s]+(?:\s+[^-\s][^\s]*)?\s+)*`;

/** Accept the path fully quoted (`rm -rf "/"`) or bare with a terminator, so `$(rm -rf /)` is caught. */
function hardlineRmPath(pathAlt: string, tail = String.raw`(?:\s|$|[)\`;|&])`): string {
  return String.raw`(?:["'](?:${pathAlt})["']|(?:${pathAlt})${tail})`;
}

const HARDLINE_SYSTEM_DIRS =
  String.raw`/home|/home/\*|/root|/root/\*|/etc|/etc/\*|/usr|/usr/\*|` +
  String.raw`/var|/var/\*|/bin|/bin/\*|/sbin|/sbin/\*|/boot|/boot/\*|/lib|/lib/\*`;

const SSH_SENSITIVE_PATH = String.raw`(?:~|\$home|\$\{home\})/\.ssh(?:/|$)`;
const PROJECT_ENV_PATH = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*\.env(?:\.[^/\s"'\`]+)*)`;
const PROJECT_CONFIG_PATH = String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'\`]+/)*config\.yaml)`;
const SHELL_RC_FILES = String.raw`(?:~|\$home|\$\{home\})/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b`;
const CREDENTIAL_FILES = String.raw`(?:~|\$home|\$\{home\})/\.(?:netrc|pgpass|npmrc|pypirc)\b`;
const MACOS_PRIVATE_SYSTEM_PATH = String.raw`/private/(?:etc|var|tmp|home)/`;
const SYSTEM_CONFIG_PATH = String.raw`(?:/etc/|${MACOS_PRIVATE_SYSTEM_PATH})`;
const TRENT_SECRET_PATH = String.raw`(?:~/\.trent/|(?:\$home|\$\{home\})/\.trent/)(?:\.env\b|config\.yaml\b)`;
const SENSITIVE_WRITE_TARGET =
  String.raw`(?:${SYSTEM_CONFIG_PATH}|/dev/sd|${SSH_SENSITIVE_PATH}|${TRENT_SECRET_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`;
const USER_SENSITIVE_WRITE_TARGET = String.raw`(?:${SSH_SENSITIVE_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`;
const PROJECT_SENSITIVE_WRITE_TARGET = String.raw`(?:${PROJECT_ENV_PATH}|${PROJECT_CONFIG_PATH})`;
const COMMAND_TAIL = String.raw`(?:\s*(?:&&|\|\||;).*)?$`;
const WRITE_TARGET_BOUNDARY = String.raw`(?=[\s;&|<>"']|$)`;

export interface CommandPattern {
  readonly re: RegExp;
  readonly description: string;
  /** Positionless rules are matched against a QUOTE-MASKED variant so quoted prose cannot trip them. */
  readonly quoteMasked: boolean;
}

function compile(entries: ReadonlyArray<readonly [string, string]>, quoteMasked: ReadonlySet<string>): CommandPattern[] {
  return entries.map(([source, description]) => ({
    re: new RegExp(source, "is"),
    description,
    quoteMasked: quoteMasked.has(description),
  }));
}

/**
 * The floor below every approval mode: commands with no recovery path. Never runs, even with an
 * approval already granted for the seat loop.
 */
export const HARDLINE_PATTERNS: readonly CommandPattern[] = compile(
  [
    [RM_FLAG_PREFIX + hardlineRmPath(String.raw`/(?:(?:\.\.?)?/)*(?:\.\.?)?\**|/ \*`), "recursive delete of root filesystem"],
    [RM_FLAG_PREFIX + hardlineRmPath(HARDLINE_SYSTEM_DIRS), "recursive delete of system directory"],
    [RM_FLAG_PREFIX + hardlineRmPath(String.raw`(?:~|\$\{?HOME\}?)(?:/?|/\*)?`), "recursive delete of home directory"],
    [CMDPOS + String.raw`mkfs(\.[a-z0-9]+)?\b`, "format filesystem (mkfs)"],
    [CMDPOS + String.raw`dd\b[^\n]*\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*`, "dd to raw block device"],
    [String.raw`>\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`, "redirect to raw block device"],
    [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb"],
    [CMDPOS + String.raw`kill\s+(-[^\s]+\s+)*-1\b`, "kill all processes"],
    [CMDPOS + String.raw`(shutdown|reboot|halt|poweroff)\b`, "system shutdown/reboot"],
    [CMDPOS + String.raw`init\s+[06]\b`, "init 0/6 (shutdown/reboot)"],
    [CMDPOS + String.raw`systemctl\s+(poweroff|reboot|halt|kexec)\b`, "systemctl poweroff/reboot"],
    [CMDPOS + String.raw`telinit\s+[06]\b`, "telinit 0/6 (shutdown/reboot)"],
    // Hermes's sudo-stdin guard (`approval_detection.py:162-171`): an explicit `sudo -S` is the
    // model piping a guessed password. Trent never configures SUDO_PASSWORD, so it is unconditional.
    [String.raw`(?:^|[;&|\`\n]|&&|\|\||\$\()\s*sudo\s+-S\b`, "sudo password guessing via stdin (sudo -S)"],
  ],
  new Set(["redirect to raw block device", "fork bomb"]),
);

/** Recoverable but consequential: every finding is merged into ONE approval request. */
export const DANGEROUS_PATTERNS: readonly CommandPattern[] = compile(
  [
    [String.raw`\brm\s+(-[^\s]*\s+)*/`, "delete in root path"],
    [String.raw`\brm\s+-[^\s]*r`, "recursive delete"],
    [String.raw`\brm\s+--recursive\b`, "recursive delete (long flag)"],
    [
      String.raw`\brm\s+(?!--(?:\s|$))(?:(?!\s--(?:\s|$))[^\n"';|&])*\s(?:-[a-z]*r[a-z]*\b|--recursive\b)`,
      "recursive delete (flags after operands)",
    ],
    [String.raw`\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b`, "world/other-writable permissions"],
    [String.raw`\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)`, "recursive world/other-writable (long flag)"],
    [String.raw`\bchown\s+(-[^\s]*)?R\s+root`, "recursive chown to root"],
    [String.raw`\bchown\s+--recur[a-z]*\b.*root`, "recursive chown to root (long flag)"],
    [CMDPOS + String.raw`mkfs\b`, "format filesystem"],
    [CMDPOS + String.raw`dd\s+.*if=`, "disk copy"],
    [String.raw`>\s*/dev/sd`, "write to block device"],
    [String.raw`\bDROP\s+(TABLE|DATABASE)\b`, "SQL DROP"],
    [String.raw`\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)`, "SQL DELETE without WHERE"],
    [String.raw`\bTRUNCATE\s+(TABLE)?\s*\w`, "SQL TRUNCATE"],
    [String.raw`>\s*${SYSTEM_CONFIG_PATH}`, "overwrite system config"],
    [String.raw`\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b`, "stop/restart system service"],
    [String.raw`\bkill\s+-9\s+-1\b`, "kill all processes"],
    [String.raw`\bpkill\s+-9\b`, "force kill processes"],
    [String.raw`\bkillall\s+(-[^\s]*\s+)*-(9|KILL|SIGKILL)\b`, "force kill processes (killall -KILL)"],
    [String.raw`\bkillall\s+(-[^\s]*\s+)*-s\s+(KILL|SIGKILL|9)\b`, "force kill processes (killall -s KILL)"],
    [String.raw`\bkillall\s+(-[^\s]*\s+)*-r\b`, "kill processes by regex (killall -r)"],
    [String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb"],
    [String.raw`\b(curl|wget)\b.*\|\s*(?:[/\w]*/)?(?:ba)?sh(?:\s|$|-c)`, "pipe remote content to shell"],
    [String.raw`\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b`, "execute remote script via process substitution"],
    [String.raw`(?:\beval\b|\bsource\b|\.)\s*(?:\$\(\s*|\`\s*)(?:curl|wget)\b`, "execute remote content via command substitution"],
    [String.raw`\b(base64|base32|base16)\s+(?:-[dD]|--decode)\b.*\|\s*\b(bash|sh|zsh|ksh|dash)\b`, "pipe decoded content to shell (possible command obfuscation)"],
    [String.raw`\bxxd\s+-r\b.*\|\s*\b(bash|sh|zsh|ksh|dash)\b`, "pipe xxd-decoded content to shell (possible command obfuscation)"],
    [String.raw`\becho\b[^|]*\|\s*\btr\b[^|]*\|\s*\b(bash|sh|zsh|ksh|dash)\b`, "pipe tr-transformed output to shell (possible command obfuscation)"],
    [String.raw`\bopenssl\b.*\b(?:base64|enc)\b[^|]*\s+-[dD]\b[^|]*\|\s*\b(bash|sh|zsh|ksh|dash)\b`, "pipe openssl-decoded content to shell (possible command obfuscation)"],
    [String.raw`\btee\b.*["']?${SENSITIVE_WRITE_TARGET}`, "overwrite system file via tee"],
    [String.raw`>>?\s*["']?${SENSITIVE_WRITE_TARGET}`, "overwrite system file via redirection"],
    [String.raw`\btee\b.*["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${WRITE_TARGET_BOUNDARY}`, "overwrite project env/config via tee"],
    [String.raw`>>?\s*["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${WRITE_TARGET_BOUNDARY}`, "overwrite project env/config via redirection"],
    [String.raw`\bxargs\s+.*\brm\b`, "xargs with rm"],
    [String.raw`\bfind\b.*-exec(?:dir)?\s+(/\S*/)?rm\b`, "find -exec/-execdir rm"],
    [String.raw`\bfind\b.*-delete\b`, "find -delete"],
    [String.raw`\bdocker(?:-compose|\s+compose)\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(restart|stop|kill|down)\b`, "docker compose restart/stop/kill/down (container lifecycle)"],
    [String.raw`\bdocker\s+(?:-{1,2}\S+(?:[=\s]\S+)?\s+)*(restart|stop|kill)\b`, "docker restart/stop/kill (container lifecycle)"],
    [String.raw`\bkill\b.*\$\(\s*(pgrep|pidof)\b`, "kill process via pgrep/pidof expansion"],
    [String.raw`\b(cp|mv|install)\b.*\s${SYSTEM_CONFIG_PATH}`, "copy/move file into system config path"],
    [String.raw`\b(cp|mv|install)\b.*\s["']?${PROJECT_SENSITIVE_WRITE_TARGET}["']?${COMMAND_TAIL}`, "overwrite project env/config file"],
    [String.raw`\b(cp|mv|install)\b.*\s["']?${SENSITIVE_WRITE_TARGET}[^\s"']*["']?${COMMAND_TAIL}`, "copy/move file into sensitive credential/SSH/shell-rc path"],
    [String.raw`\bsed\s+-[^\s]*i.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path"],
    [String.raw`\bsed\s+--in-place\b.*(?:${USER_SENSITIVE_WRITE_TARGET})[^\s"']*`, "in-place edit of sensitive credential/SSH/shell-rc path (long flag)"],
    [String.raw`\bsed\s+-[^\s]*i.*\s${SYSTEM_CONFIG_PATH}`, "in-place edit of system config"],
    [String.raw`\bsed\s+--in-place\b.*\s${SYSTEM_CONFIG_PATH}`, "in-place edit of system config (long flag)"],
    [String.raw`\bsed\s+-[^\s]*i.*${TRENT_SECRET_PATH}`, "in-place edit of Trent config/env"],
    [String.raw`\b(bash|sh|zsh|ksh)\s+<<`, "shell execution via heredoc"],
    [String.raw`\bgit\s+reset\s+--h(?:a(?:r(?:d)?)?)?\b`, "git reset --hard (destroys uncommitted changes)"],
    [String.raw`\bgit\s+push\b.*--forc[a-z]*\b`, "git force push (rewrites remote history)"],
    [String.raw`\bgit\s+push\b.*-f\b`, "git force push short flag (rewrites remote history)"],
    [String.raw`\bgit\s+clean\s+-[^\s]*f`, "git clean with force (deletes untracked files)"],
    [String.raw`\bgit\s+branch\s+-D\b`, "git branch force delete"],
    [String.raw`\bgit\s+branch\b[^;|&\n]*?(?:-d\b|--delete\b)[^;|&\n]*?(?:-f\b|--force\b)`, "git branch force delete (long flags)"],
    [String.raw`\bgit\s+branch\b[^;|&\n]*?(?:-f\b|--force\b)[^;|&\n]*?(?:-d\b|--delete\b)`, "git branch force delete (long flags, force-first)"],
    [String.raw`\bchmod\s+\+x\b.*[;&|]+\s*\./`, "chmod +x followed by immediate execution"],
    [String.raw`\bsudo\b[^;|&\n]*?\s+(?:-s\b|--st[a-z]*\b|-a\b|--a[a-z]*\b)`, "sudo with privilege flag (stdin/askpass/shell/list)"],
    [String.raw`\bsudo\b[^;|&\n]*?\s+-[a-z]*[sa][a-z]*\b`, "sudo with combined-flag privilege escalation"],
    [CMDPOS + String.raw`npm\s+` + PKG_OPTS + String.raw`(?:uninstall|unlink|remove|rm|r|un)\b`, "package manager uninstall"],
    [CMDPOS + String.raw`pnpm\s+` + PKG_OPTS + String.raw`(?:uninstall|remove|rm|un)\b`, "package manager uninstall"],
    [CMDPOS + String.raw`yarn\s+` + PKG_OPTS + String.raw`(?:global\s+)?(?:uninstall|remove)\b`, "package manager uninstall"],
    [CMDPOS + String.raw`pip(?:3)?\s+` + PKG_OPTS + String.raw`uninstall\b`, "package manager uninstall"],
    [CMDPOS + String.raw`brew\s+` + PKG_OPTS + String.raw`(?:uninstall|remove|rm)\b`, "package manager uninstall"],
  ],
  new Set(["fork bomb", "write to block device"]),
);
