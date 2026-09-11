#!/usr/bin/env bash
#
# Obtain a bearer token for one person, by the same login the browser performs.
#
# Authorization code with PKCE (S256) against the realm's real login form — the flow
# docs/deployment/identity-and-login.md walked and falsified. No realm change, no
# direct-access-grants client, no admin impersonation: the token this prints is the token the
# person would hold after logging in themselves, carrying their `sub`, the realm `iss`, and the
# API audience the mapper adds. What the API then lets them see is decided by the record, not by
# how the token was obtained.
#
# usage: KF_LOGIN_PASSWORD=... scripts/deploy/login-token.sh <username> <token-file>
#
#   KF_OIDC_ISSUER   the realm, e.g. https://identity.kf.internal:8443/realms/knowledge-fabric
#                    (default: the OIDC_ISSUER of the environment, if set)
#   KF_OIDC_CLIENT   the public client (default: knowledge-fabric-web)
#   KF_REDIRECT_URI  the client's registered redirect (default: https://kf.internal/auth/callback)
#   CURL_CA_BUNDLE   the private CA, when the issuer is not publicly trusted
#
# The token file is written 0600. It is a credential: it expires by the realm's policy and is
# never printed to the terminal.

set -euo pipefail

username="${1:?usage: login-token.sh <username> <token-file>}"
token_file="${2:?usage: login-token.sh <username> <token-file>}"
: "${KF_LOGIN_PASSWORD:?set KF_LOGIN_PASSWORD — this script will not prompt or default a credential}"

issuer="${KF_OIDC_ISSUER:-${OIDC_ISSUER:-}}"
[ -n "$issuer" ] || { echo "KF_OIDC_ISSUER (or OIDC_ISSUER) is required" >&2; exit 2; }
client="${KF_OIDC_CLIENT:-knowledge-fabric-web}"
redirect="${KF_REDIRECT_URI:-https://kf.internal/auth/callback}"

case "$username" in
  '' | *[!A-Za-z0-9._@-]*) echo "username must be [A-Za-z0-9._@-]: $username" >&2; exit 2 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
jar="$work/cookies"

# PKCE: a random verifier, and its S256 challenge. Both from Python so the encoding is exact.
read -r verifier challenge < <(python3 -c '
import base64, hashlib, secrets
v = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
c = base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode()
print(v, c)
')
state="$(python3 -c 'import secrets; print(secrets.token_urlsafe(16))')"

# 1. The login page. Keycloak sets its session cookies here and embeds the form action URL,
#    which carries the session_code and execution the POST must return.
auth_url="$(KF_ISSUER="$issuer" KF_CLIENT="$client" KF_REDIRECT="$redirect" KF_CHALLENGE="$challenge" KF_STATE="$state" python3 -c '
import os, urllib.parse
q = urllib.parse.urlencode({
    "client_id": os.environ["KF_CLIENT"],
    "response_type": "code",
    "scope": "openid",
    "redirect_uri": os.environ["KF_REDIRECT"],
    "state": os.environ["KF_STATE"],
    "code_challenge": os.environ["KF_CHALLENGE"],
    "code_challenge_method": "S256",
})
print(os.environ["KF_ISSUER"].rstrip("/") + "/protocol/openid-connect/auth?" + q)
')"
curl -sS --fail-with-body --max-time 20 -c "$jar" -b "$jar" -o "$work/login.html" "$auth_url"

form_action="$(python3 - "$work/login.html" <<'PY'
import html, re, sys
page = open(sys.argv[1], encoding="utf-8", errors="replace").read()
m = re.search(r'<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"', page) or \
    re.search(r'<form[^>]*action="([^"]+)"[^>]*id="kc-form-login"', page)
if not m:
    sys.exit("no login form found on the authorization page; is the realm serving a login?")
print(html.unescape(m.group(1)))
PY
)"

# 2. The credential, as a request body on stdin — never in argv, where /proc would show it.
location="$(KF_USER="$username" KF_PASS="$KF_LOGIN_PASSWORD" python3 -c '
import os, urllib.parse
print(urllib.parse.urlencode({"username": os.environ["KF_USER"], "password": os.environ["KF_PASS"], "credentialId": ""}), end="")
' | curl -sS --max-time 20 -c "$jar" -b "$jar" -o "$work/post.html" -w '%{redirect_url}' -d @- "$form_action")"

code="$(KF_LOC="$location" KF_STATE="$state" python3 -c '
import os, sys, urllib.parse
loc = os.environ["KF_LOC"]
if not loc:
    sys.exit("login did not redirect: the credential was refused, or the account has a required action pending")
q = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
if q.get("state", [None])[0] != os.environ["KF_STATE"]:
    sys.exit("state mismatch on the redirect; refusing the code")
code = q.get("code", [None])[0]
if not code:
    sys.exit(f"redirect carried no code: {loc}")
print(code)
')"

# 3. The token, with the verifier that proves this process started the flow.
umask 077
KF_ISSUER="$issuer" KF_CLIENT="$client" KF_REDIRECT="$redirect" KF_CODE="$code" KF_VERIFIER="$verifier" python3 -c '
import os, urllib.parse
print(urllib.parse.urlencode({
    "grant_type": "authorization_code",
    "client_id": os.environ["KF_CLIENT"],
    "redirect_uri": os.environ["KF_REDIRECT"],
    "code": os.environ["KF_CODE"],
    "code_verifier": os.environ["KF_VERIFIER"],
}), end="")
' | curl -sS --fail-with-body --max-time 20 -d @- "${issuer%/}/protocol/openid-connect/token" \
  | python3 -c '
import json, sys
body = json.load(sys.stdin)
tok = body.pop("access_token", None)
if not tok:
    body.pop("refresh_token", None)
    body.pop("id_token", None)
    sys.exit("token endpoint returned no access_token: " + json.dumps(body))
sys.stdout.write(tok)
' > "$token_file"
chmod 0600 "$token_file"

# Report what the token says about itself, never the token.
python3 - "$token_file" <<'PY'
import base64, json, sys, time
tok = open(sys.argv[1]).read().strip()
payload = tok.split(".")[1]
payload += "=" * (-len(payload) % 4)
claims = json.loads(base64.urlsafe_b64decode(payload))
print(f"user     {claims.get('preferred_username')}")
print(f"subject  {claims.get('sub')}")
print(f"issuer   {claims.get('iss')}")
print(f"audience {claims.get('aud')}")
print(f"expires  in {int(claims.get('exp', 0) - time.time())}s")
print(f"token    {sys.argv[1]} (0600)")
PY
