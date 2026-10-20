# Your own Knowledge Fabric, on this computer

One click (or one command) gives a person their own, empty Knowledge Fabric for their own
organization: they sign in as themselves, add files, and search them. It is a workstation
workspace, not a host: everything listens on loopback, and the database, object store and
Keycloak use the public development credentials from `docker-compose.yml`.

## Start it

Install the icon once, from a checkout:

```sh
pnpm kf:install-launcher
```

Then click **Knowledge Fabric** in the applications menu.

- **No workspace yet:** a page opens in the browser asking for the organization's name, your
  full name, a username, a password (twice), optionally the full path of a folder of files to
  add, and who writes answers to your questions (see [AI answers](#ai-answers)). "Set up
  Knowledge Fabric" starts it; the page shows each step, then opens the sign-in, and after it
  Home. The first time takes several minutes (it builds the applications).
- **Stopped:** the page says "Starting Knowledge Fabric…" and opens Home when it is ready.
- **Running:** the click opens Home.

Clicking twice starts nothing twice. If something fails, the page says what went wrong and what
to do; the details are in the journal (`journalctl --user -u kf-local`).

For scripts, `pnpm kf:start -- --organization <name> --name <full name> --username <login>
[--email <address>] [--import <folder>]`, `pnpm kf:status`, `pnpm kf:stop` and
`pnpm kf:reset -- --yes` drive the same engine (`kf workspace ...` once `kf` is installed). A
command line never takes a password: the first start generates one into
`~/.local/state/kf-local/login-password` (mode 0600, never printed) and Keycloak asks for a new
one at the first sign-in, after which the file is stale and may be deleted. A later `--import`
signs in with that file's password while it is still the account's, and otherwise asks for the
password at the terminal.

## What it creates

| What                    | Where                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Containers and volumes  | compose project `kf-local`: PostgreSQL 18, SeaweedFS, Keycloak (`kf-local-*`)                                                                       |
| Applications            | attestor, API, worker and web, built from the checkout (`fixtures/veracier/stack/stack.sh`, under `KF_STACK_*`)                                     |
| Ports (loopback)        | web 3300, API 4300, Keycloak 18280, PostgreSQL 15632, S3 19200; a start refuses if anything else holds one                                          |
| State (0700)            | `~/.local/state/kf-local`: logins, keys, logs, `workspace.json` (ids; no secret), `answers.json` (AI answers; no secret), `provider-api-key` (0600) |
| Launcher                | `~/.local/state/kf-local-launcher` (its lock and page address, 0600); systemd user unit `kf-local`                                                  |
| Icon                    | `~/.local/share/applications/knowledge-fabric.desktop`, its icon, `~/.local/share/knowledge-fabric/launcher.json`                                   |
| In the Knowledge Fabric | the organization; you, as its first person; your Keycloak account; one role assignment                                                              |

**Your authority.** `kf grant-authority` gives you `technical_authority` over the organization,
cleared to `confidential`, as its founding grant: you read everything up to confidential, add
files, capture observations and verify records (verification and Needs you require
`technical_authority`). One role, so the sign-in's context picker has nothing to choose. To add
a colleague, use `kf invite` with the owner credential (`postgres://kf_owner@localhost:15632/kf`,
password `dev-only-not-a-secret` through `DATABASE_OWNER_URL_FILE`).

**Added files.** Each file of the folder is one `POST /ingest` act by you, classified
`internal`, after the same checks `kf ingest` makes: reference-only paths (vendor, supplier,
datasheet), the deny list (dot-files and dot-directories are never entered, keys, credential
stores), and the content scan (private keys, likely IBAN, SSN or card numbers). A refused file
is skipped and counted by its code; nothing else stops. A PDF, or another format KF does not
parse, is followed by its extracted text as a second artifact that names it (`derived_from`), as
the fixtures load theirs. At most 250 files per import, the ingest batch ceiling.

**Search.** Lexical always. Semantic too when an embedding server another stack runs on this
computer answers (`http://127.0.0.1:8021`, then `:8022`, or `KF_LOCAL_EMBED_URL`) and the
retrieval engine and prepared model are installed; nothing is downloaded. Which one you got is
printed, and recorded in `workspace.json`.

## AI answers

"Ask" can have a model write the answer from the records you may see, listing its sources. Who
writes it is chosen on the setup page and changed later by right-clicking the **Knowledge Fabric**
icon and choosing **AI answers** (the launcher's `ai` action; the same page). In Knowledge Fabric,
**More → AI answers** shows the choice in force and the organization's rule.

| Choice           | What answers                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| Off              | Nothing; Ask shows the search results and a link to turn answers on                                              |
| On this computer | A model served on this computer: LAMU, Ollama or LM Studio (OpenAI-compatible, loopback only); nothing leaves it |
| Cloud model      | Anthropic, OpenAI, Google Gemini, Mistral, OpenRouter, or another OpenAI-compatible provider (https), by API key |
| Both             | The cloud model for records cleared to leave; this computer for everything else                                  |

- **On this computer** is offered only when a model server answers at `http://127.0.0.1:11434`
  (Ollama) or `:1234` (LM Studio), or at `KF_LOCAL_MODEL_URL` (loopback only), with a model
  downloaded. Otherwise the page says "No model is running on this computer" and refuses the
  choice; nothing is downloaded or installed.
- **The API key** is typed into a password field and sent once to the launcher's page, which writes
  it to `~/.local/state/kf-local/provider-api-key` (mode 0600, created fresh, then renamed into
  place). It is never in an argv, an environment, a log, `answers.json` or any page: the page only
  learns that a key is saved. The web application is started with `KF_AGENT_PROVIDER` and the
  key's _file_ (`KF_AGENT_PROVIDER_KEY_FILE`) and reads it on each call. Leaving the field empty
  keeps the saved key for the same provider; choosing Off or On this computer deletes it.
- **Saving restarts the web application alone** (`stack.sh web-restart`); the API, worker,
  attestor and containers keep running. A workspace that is stopped uses the choice at its next
  start. A shell's own `KF_AGENT_*` or `ANTHROPIC_*` variables never reach the workspace.
- **What may leave is the organization's decision**, not this choice's: its provider ceiling
  (`GET /model-routing`), changed only by `set_model_routing_policy`, an institutional act. On the
  setup page the founder's choice records it as their own act: `internal` for a cloud model,
  `none` for on this computer, nothing for Off. Later, **More → AI answers** offers the matching
  change as one button for the signed-in person to press; the launcher never performs it. Neither
  ever asks for more than `internal`: confidential and restricted records are answered on this
  computer or not at all, whichever cloud model is chosen (ADR 0040, KF-SAS-RQ-271).

Not covered: whether a cloud provider keeps what it is sent is that provider's terms, accepted by
whoever pastes the key. A model in the reader's own browser is not offered.

## Stop it and remove it

`pnpm kf:stop` stops the applications and containers and keeps every record. The next click or
`pnpm kf:start` brings it back as it was.

`pnpm kf:reset -- --yes` deletes this workspace: the `kf-local` containers and volumes,
`~/.local/state/kf-local` and the launcher's state. It touches no other compose project, volume
or directory, whatever `KF_STACK_*` the shell exported. `pnpm kf:install-launcher -- --uninstall`
removes the icon.

## Use it on Windows

Knowledge Fabric installs from the browser as an app, with no installer:

1. Open your Knowledge Fabric address in Microsoft Edge (or Chrome).
2. Click the install icon at the right of the address bar (in Edge, "App available. Install
   Knowledge Fabric"), then **Install**.
3. Knowledge Fabric is now in the Start menu, and can be pinned to the taskbar. It opens in its own
   window.

What this needs, honestly: a Knowledge Fabric server the Windows PC can reach, at an `https://`
address (browsers offer the install only over HTTPS, or on `localhost`). The workspace on this page
runs on a Linux workstation's loopback, so another computer cannot reach it; for people at an
organization that server is the hosted one (roadmap M6), and there is no packaged installer that
puts the server itself on Windows (SAS §100.73). The installed app is the same site in its own
window: it works only while the server is reachable, every page is fetched and access-checked as
in a browser tab, and nothing — no page, no record — is kept on the PC for offline use. The
manifest is `apps/web/src/app/manifest.ts`; there is deliberately no service worker.

## What it is not

Not a hosted service, not multi-user beyond the people you invite on this computer, and not
installed software: it runs from a checkout and needs Docker, Node and pnpm. A packaged installer
for Windows or macOS would need to bundle a Node runtime and the built applications, provide
PostgreSQL, SeaweedFS and Keycloak without asking the person to install Docker (bundled binaries,
or a managed container runtime), run the launcher as a per-user service (Windows: a scheduled task
or service; macOS: a launchd agent), and sign the result (Authenticode, Apple notarization).
