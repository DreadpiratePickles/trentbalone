#!/bin/sh
# render.sh — render scripts/install.sh and scripts/install.ps1 from one set of sources.
#
#   scripts/installer/render.sh            # write both scripts in place
#   scripts/installer/render.sh --check    # exit 1 if either checked-in script is stale
#   scripts/installer/render.sh --out DIR  # render into DIR (used by the tests)
#
# Inputs (all in this directory):
#   stages.tsv               the ONE stage list; both --manifest outputs are built from it
#   install.sh.in            POSIX sh template          -> scripts/install.sh
#   install.ps1.in           PowerShell template        -> scripts/install.ps1
#   keys/minisign.pub        Ed25519 release key (minisign format), embedded in both scripts
#   keys/ecdsa-p256.pub.pem  ECDSA P-256 co-signing key, embedded in both scripts
#   banner.ansi              optional truecolour banner, embedded if present
#   banner-16.ansi           optional 16-colour banner, embedded if present
#
# Placeholders, one per line in the templates:
#   @@STAGES@@  @@MINISIGN_PUB@@  @@ED25519_PEM@@  @@ECDSA_PEM@@  @@ECDSA_XY@@
#   @@BANNER_TRUECOLOR@@  @@BANNER_16@@
set -eu
IFS=" 	
"   # space, tab, newline: the default field separator, explicitly
here=$(cd "$(dirname "$0")" && pwd)
scripts=$(cd "$here/.." && pwd)
mode=write
out="$scripts"
case "${1:-}" in
  --check) mode=check ;;
  --out) out="$2" ;;
  "") ;;
  *) echo "render.sh: unknown argument '$1'" >&2; exit 2 ;;
esac
command -v openssl >/dev/null 2>&1 || { echo "render.sh: openssl is required" >&2; exit 2; }
[ -f "$here/keys/minisign.pub" ] || { echo "render.sh: keys/minisign.pub missing (node keys/gen-keys.mjs)" >&2; exit 2; }
[ -f "$here/keys/ecdsa-p256.pub.pem" ] || { echo "render.sh: keys/ecdsa-p256.pub.pem missing" >&2; exit 2; }

rows() { grep -v '^#' "$here/stages.tsv" | grep -v '^[[:space:]]*$'; }
# Titles land inside single-quoted strings in both languages: no quotes allowed.
if rows | grep -q "['\"]"; then echo "render.sh: stage titles must not contain quotes" >&2; exit 2; fi

manifest_json() {
  rows | awk -F'\t' 'BEGIN { printf "{\"protocol_version\":1,\"stages\":[" }
    { if (NR > 1) printf ","; printf "{\"name\":\"%s\",\"title\":\"%s\",\"category\":\"%s\",\"needs_user_input\":%s}", $1, $2, $3, $4 }
    END { printf "]}" }'
}

sh_table() {
  echo "# BEGIN GENERATED FROM scripts/installer/stages.tsv — do not edit by hand"
  printf 'STAGE_NAMES="%s"\n' "$(rows | awk -F'\t' '{ printf "%s%s", (NR>1?" ":""), $1 }')"
  printf "MANIFEST_JSON='%s'\n" "$(manifest_json)"
  echo "stage_needs_input() {"
  echo "  case \"\$1\" in"
  rows | awk -F'\t' '$4 == "true" { printf "    %s) return 0 ;;\n", $1 }'
  echo "    *) return 1 ;;"
  echo "  esac"
  echo "}"
  echo "stage_title() {"
  echo "  case \"\$1\" in"
  rows | awk -F'\t' '{ printf "    %s) echo \"%s\" ;;\n", $1, $2 }'
  echo "    *) echo \"\$1\" ;;"
  echo "  esac"
  echo "}"
  echo "# END GENERATED"
}

ps1_table() {
  echo "# BEGIN GENERATED FROM scripts/installer/stages.tsv — do not edit by hand"
  echo '$StageNames = @('
  rows | awk -F'\t' '{ a[NR]=$1 } END { for (i=1;i<=NR;i++) printf "  \"%s\"%s\n", a[i], (i<NR?",":"") }'
  echo ')'
  printf "\$ManifestJson = '%s'\n" "$(manifest_json)"
  echo '$StageNeedsInput = @{'
  rows | awk -F'\t' '{ printf "  \"%s\" = $%s\n", $1, $4 }'
  echo '}'
  echo '$StageTitles = @{'
  rows | awk -F'\t' '{ printf "  \"%s\" = \"%s\"\n", $1, $2 }'
  echo '}'
  echo "# END GENERATED"
}

# ---- keys
minisign_pub_line() { sed -n 2p "$here/keys/minisign.pub"; }
# Ed25519 SubjectPublicKeyInfo PEM = fixed 12-byte DER prefix + the 32 raw key bytes from the
# minisign blob ("Ed" || key_id(8) || pk(32)). Built with printf + dd so LibreSSL can render it.
ed25519_pem() {
  raw=$(mktemp)
  minisign_pub_line | openssl base64 -d > "$raw"
  [ "$(wc -c < "$raw" | tr -d ' ')" = 42 ] || { echo "render.sh: minisign.pub is not 42 bytes" >&2; exit 2; }
  echo "-----BEGIN PUBLIC KEY-----"
  { printf '\060\052\060\005\006\003\053\145\160\003\041\000'; dd if="$raw" bs=1 skip=10 count=32 2>/dev/null; } | openssl base64
  echo "-----END PUBLIC KEY-----"
  rm -f "$raw"
}
ecdsa_pem() { cat "$here/keys/ecdsa-p256.pub.pem"; }
# X||Y hex (64 bytes) for the PowerShell CNG blob, from the uncompressed point 04||X||Y.
ecdsa_xy() {
  openssl ec -pubin -in "$here/keys/ecdsa-p256.pub.pem" -text -noout 2>/dev/null \
    | awk '/^pub:/ { grab = 1; next } /^ASN1 OID/ { grab = 0 } grab { gsub(/[ :]/, ""); printf "%s", $0 }' \
    | sed 's/^04//'
}

banner_file() { if [ -f "$here/$1" ]; then cat "$here/$1"; fi; }

# Whole-line placeholders are replaced by file contents (multi-line values); the two
# single-line values (MINISIGN_PUB, ECDSA_XY) are also substituted inline so they can sit
# inside a quoted assignment. base64/hex contain no & or \, so awk's gsub is safe.
render() { # $1 template; placeholders replaced from files in $2 dir
  awk -v dir="$2" -v pub="$(tr -d '\n' < "$2/minisign_pub")" -v xy="$(tr -d '\n' < "$2/ecdsa_xy")" '
    function insert(name,   f, line) { f = dir "/" name; while ((getline line < f) > 0) print line; close(f) }
    /^@@STAGES@@$/            { insert("stages"); next }
    /^@@ED25519_PEM@@$/       { insert("ed25519_pem"); next }
    /^@@ECDSA_PEM@@$/         { insert("ecdsa_pem"); next }
    /^@@BANNER_TRUECOLOR@@$/  { insert("banner_truecolor"); next }
    /^@@BANNER_16@@$/         { insert("banner_16"); next }
    { gsub(/@@MINISIGN_PUB@@/, pub); gsub(/@@ECDSA_XY@@/, xy); print }' "$1"
}

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
minisign_pub_line > "$tmp/minisign_pub"; printf '\n' >> "$tmp/minisign_pub"
ed25519_pem > "$tmp/ed25519_pem"
ecdsa_pem > "$tmp/ecdsa_pem"
ecdsa_xy > "$tmp/ecdsa_xy"; printf '\n' >> "$tmp/ecdsa_xy"
[ "$(tr -d '\n' < "$tmp/ecdsa_xy" | wc -c | tr -d ' ')" = 128 ] || { echo "render.sh: could not extract the ECDSA X||Y coordinates" >&2; exit 2; }
banner_file banner.ansi > "$tmp/banner_truecolor"
banner_file banner-16.ansi > "$tmp/banner_16"
sh_table > "$tmp/stages"
render "$here/install.sh.in" "$tmp" > "$tmp/install.sh"
ps1_table > "$tmp/stages"
render "$here/install.ps1.in" "$tmp" > "$tmp/install.ps1"
for f in install.sh install.ps1; do
  if grep -q '@@[A-Z0-9_]*@@' "$tmp/$f"; then echo "render.sh: unreplaced placeholder in $f" >&2; exit 1; fi
done

if [ "$mode" = check ]; then
  rc=0
  cmp -s "$tmp/install.sh" "$scripts/install.sh" || { echo "STALE: scripts/install.sh differs from a fresh render" >&2; rc=1; }
  cmp -s "$tmp/install.ps1" "$scripts/install.ps1" || { echo "STALE: scripts/install.ps1 differs from a fresh render" >&2; rc=1; }
  exit $rc
fi
mkdir -p "$out"
cp "$tmp/install.sh" "$out/install.sh"; chmod +x "$out/install.sh"
cp "$tmp/install.ps1" "$out/install.ps1"
echo "rendered $out/install.sh and $out/install.ps1"
