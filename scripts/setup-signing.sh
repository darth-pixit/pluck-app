#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Pluks macOS signing setup — run this AFTER installing your
# "Developer ID Application" certificate from Apple Developer portal.
# Usage: bash scripts/setup-signing.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO="darth-pixit/pluck-app"
TEAM_ID="7RC3Q3BU3V"
APPLE_ID="parth.dixit@alumni.iitd.ac.in"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       Pluks macOS Code Signing Setup                ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── 1. Find the Developer ID Application identity ────────────────────────────
echo "→ Looking for Developer ID Application certificate..."
IDENTITY=$(security find-identity -v -p codesigning \
  | grep "Developer ID Application" \
  | head -1 \
  | sed 's/.*"\(.*\)"/\1/')

if [[ -z "$IDENTITY" ]]; then
  echo ""
  echo "✗ No 'Developer ID Application' certificate found in Keychain."
  echo ""
  echo "  Steps to create one:"
  echo "  1. Go to: https://developer.apple.com/account/resources/certificates/add"
  echo "  2. Select 'Developer ID Application' → Continue"
  echo "  3. Upload /tmp/pluks_dev_id.csr (already generated for you)"
  echo "  4. Download the .cer file and double-click it to install in Keychain"
  echo "  5. Re-run this script"
  echo ""
  exit 1
fi

echo "  ✓ Found: $IDENTITY"

# ── 2. Export .p12 ────────────────────────────────────────────────────────────
P12_PATH="$RUNNER_TEMP/pluks_dist.p12" 2>/dev/null || P12_PATH="/tmp/pluks_dist.p12"
echo ""
echo "→ Exporting certificate as .p12 (you will be prompted for a password)..."
security export \
  -t identities \
  -f pkcs12 \
  -o "$P12_PATH" \
  -k login.keychain-db

echo "  ✓ Exported to $P12_PATH"

# ── 3. Encode .p12 as base64 ─────────────────────────────────────────────────
CERT_B64=$(base64 -i "$P12_PATH")

# ── 4. Prompt for passwords ───────────────────────────────────────────────────
echo ""
read -s -p "Enter the password you just set for the .p12 export: " CERT_PASS
echo ""
read -s -p "Enter your app-specific password (appleid.apple.com → App-Specific Passwords): " APP_PASS
echo ""
KEYCHAIN_PASS=$(openssl rand -base64 16)

# ── 5. Set all 7 GitHub secrets ──────────────────────────────────────────────
echo ""
echo "→ Setting GitHub secrets on $REPO..."

gh secret set APPLE_CERTIFICATE          --body "$CERT_B64"    --repo "$REPO"
gh secret set APPLE_CERTIFICATE_PASSWORD --body "$CERT_PASS"   --repo "$REPO"
gh secret set APPLE_SIGNING_IDENTITY     --body "$IDENTITY"    --repo "$REPO"
gh secret set APPLE_ID                   --body "$APPLE_ID"    --repo "$REPO"
gh secret set APPLE_PASSWORD             --body "$APP_PASS"    --repo "$REPO"
gh secret set APPLE_TEAM_ID              --body "$TEAM_ID"     --repo "$REPO"
gh secret set KEYCHAIN_PASSWORD          --body "$KEYCHAIN_PASS" --repo "$REPO"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  ✓ All 7 secrets set. Next release will be signed & ║"
echo "║    notarized automatically by GitHub Actions.       ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  To trigger a new release:"
echo "    git tag v0.1.1 && git push origin v0.1.1"
echo ""

# Cleanup
rm -f "$P12_PATH"
