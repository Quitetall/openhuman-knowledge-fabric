#!/usr/bin/env python3
"""S8: a delegated token for a persona, by standard token exchange through the declared agent client
(KF ADR 0035; docs/deployment/identity-and-login.md "Using it"). Writes the exchanged token 0600.

  exchange-agent-token.py <username> <out-file>

The person's own token is minted by mint.mjs into a temporary 0600 file; the agent client's secret
is read from the realm admin API (admin password from the fixture state, 0600) and held in memory
only. Nothing secret is printed: only the token's non-secret claims act/azp/aud/exp.
"""
import base64, json, os, subprocess, sys, urllib.parse, urllib.request
from pathlib import Path

user, out = sys.argv[1], Path(sys.argv[2])
here = Path(__file__).resolve().parent
kc = os.environ.get("KF_VERACIER_KEYCLOAK", "http://localhost:18080")
realm = f"{kc}/realms/knowledge-fabric"
person_tok = out.with_name(out.name + ".person")
try:
    subprocess.run(["node", str(here / "mint.mjs"), user, str(person_tok)], check=True, stdout=subprocess.DEVNULL)
    subject = person_tok.read_text().strip()
    admin_pw = Path("~/.local/state/kf-veracier/keycloak-admin-password").expanduser().read_text().strip()
    post = lambda url, data, headers={}: json.load(urllib.request.urlopen(urllib.request.Request(
        url, data=urllib.parse.urlencode(data).encode(), headers=headers)))
    admin = post(f"{kc}/realms/master/protocol/openid-connect/token",
                 {"grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": admin_pw})["access_token"]
    get = lambda path: json.load(urllib.request.urlopen(urllib.request.Request(
        f"{kc}/admin/realms/knowledge-fabric{path}", headers={"authorization": "Bearer " + admin})))
    cid = [c for c in get("/clients?clientId=knowledge-fabric-agent")][0]["id"]
    secret = get(f"/clients/{cid}/client-secret")["value"]
    basic = base64.b64encode(f"knowledge-fabric-agent:{secret}".encode()).decode()
    exchanged = post(f"{realm}/protocol/openid-connect/token", {
        "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange", "subject_token": subject,
        "subject_token_type": "urn:ietf:params:oauth:token-type:access_token", "audience": "knowledge-fabric-api"},
        {"authorization": "Basic " + basic})["access_token"]
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.write(fd, (exchanged + "\n").encode()); os.close(fd)
    claims = json.loads(base64.urlsafe_b64decode(exchanged.split(".")[1] + "=="))
    print(json.dumps({k: claims.get(k) for k in ("act", "azp", "aud", "exp")}))
finally:
    person_tok.unlink(missing_ok=True)
