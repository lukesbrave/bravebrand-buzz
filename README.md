# Set up my Workrooms

**For the coding agent receiving this GitHub link.** The person in front of you is setting up a private workspace that they own: the app's source code on their Mac, the community on a server in their account, and a key that only their Mac holds. They may never have used a terminal. You are their guide for the whole setup.

How to guide:

- Run every command yourself, in a local macOS session. If this chat is running on a cloud machine, help them switch to a local session first.
- Open by telling them the plan: seven steps, you do most of them, and they do four small things (name the workspace, create the server, add one DNS record, create their key).
- Give one step at a time. Say which step it is ("Step 3 of 7"), what it does in plain words, and wait for their result before the next.
- Use plain names, and teach the real term once: "your server (a VPS)", "your key (it proves you are you, with no account or password)".
- When a step finishes, say what they now own.
- Never ask for, read or print a private key, a password, a recovery copy or the server's settings file. A private key starts with `nsec`. The only key they share with you starts with `npub`.
- If they are joining a workspace someone else set up, skip to **Joining with an invite**.

They need an Apple silicon Mac with about 16 GB of free disk, a domain whose DNS they control, and an account with a server provider. The course uses Cloudflare for DNS and Hetzner for the server.

## Step 1 of 7 · Name the workspace

Ask which address the workspace should have: an unused name on their domain, such as `team.example.com`. Everything else uses this name, so settle it first.

## Step 2 of 7 · Start building the app

Clone this repository into a fresh folder at the revision in the supplied link. For a commit link, verify that `git rev-parse HEAD` matches it. Tell them this folder is their own copy of the app's source code.

Check `xcode-select -p`. If the Command Line Tools are missing, run `xcode-select --install` and let them complete the macOS prompt. Then start the build in the background and move on while it runs:

```sh
bin/rustup toolchain install && ./scripts/bravebrand-client.sh --rehearsal
```

## Step 3 of 7 · Create the server

While the app builds, walk them through creating a server in their own provider account. On Hetzner: a new project, one Ubuntu 24.04 server, the small shared x86 plan with 4 GB of memory (CX23 at the time of writing; confirm the plan on the order screen).

The server is reached with an SSH key. If `~/.ssh` has no key they already use, create one for this server and show them only the public half to paste into the provider's SSH key field:

```sh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/workrooms_ed25519 -C workrooms && cat ~/.ssh/workrooms_ed25519.pub
```

With a dedicated key, add a `Host workrooms` entry to `~/.ssh/config` with the server's IP as `HostName`, `User root` and that `IdentityFile`, and use `root@workrooms` below. Ask them for the server's IPv4 address once it is running.

## Step 4 of 7 · Point the name at the server

Prepare the server. This installs Docker, fetches the community software and prints the DNS record to create. It is safe to run before a key exists:

```sh
bin/pnpm install --frozen-lockfile
bin/node scripts/workrooms-server/install.mjs root@SERVER team.example.com
```

Have them add that record in their DNS account: type **A**, their chosen name, the server's IPv4 address. In Cloudflare the proxy must be off (**DNS only**).

## Step 5 of 7 · Create the owner's key

When the build finishes, install the app. If Applications already contains a bundle of that name, verify its identifier and move the old bundle aside first. Use the user's own Applications folder if the system one needs an administrator.

```sh
app="Brave Agent Workrooms Rehearsal.app"
bundle="target/debug/bundle/macos/$app"
codesign --verify --deep --strict "$bundle" &&
  ditto "$bundle" "/Applications/$app" &&
  codesign --verify --deep --strict "/Applications/$app"
```

Tell them where the icon is and let them open it. They choose **Set up my workspace**, then **Create my key**. The next screen shows a code with a **Copy** button. Ask them to paste it to you. It is their public key and starts with `npub1`. Their private key stays in their Mac's Keychain and is never shown.

## Step 6 of 7 · Start the workspace

Create the community with their public key as its owner. The command waits until this Mac resolves the name, starts the community, and then checks it from this Mac over HTTPS: the public address must answer as this community, refuse an anonymous read and hide its operator routes.

```sh
bin/node scripts/workrooms-server/install.mjs root@SERVER team.example.com npub1…
```

If it stops, fix what it reports and run the same command again. It never replaces an existing community's owner or address.

## Step 7 of 7 · Walk in

Give them the address the command printed. They paste it in the app, still open on **Connect your workspace**, and choose **Connect**. They complete their name and picture. Have them confirm that the members list shows them as **Owner**.

Then, before anything else:

1. **Save a recovery copy of the key.** In **Settings → Identity** they save a recovery copy somewhere only they control, such as their password manager. Without it, a lost Mac means a lost owner key. Do not look at it.
2. **Write their ownership note.** Create `My Workrooms.md` beside this checkout listing: the workspace address; where the source code is and the revision built; the server provider, plan and IP; that the server's settings and data live in `/opt/workrooms` and its Docker volumes and need backing up; that the owner key is in their Mac's Keychain with a recovery copy they saved. No secrets go in this file.
3. **Invite someone.** They create an invite in the app and send it privately.

## Joining with an invite

Build and install the app as in steps 2 and 5. The person opens it, chooses **I have an invite**, pastes the invite link they were sent and chooses **Create my identity**. Keep invites and recovery copies out of the chat.

## Host my community on this Mac

The app and server can be set up independently. If the app is already building or installed from the earlier Mac guide, keep it. The coding agent can use a separate checkout of this revision for the server. A client needs Docker Desktop running on the **host Mac**. A member joining from another computer only needs the desktop client. The Mac must be awake and online for remote members.

1. Ask the owner to pick an unused hostname on a domain they control in Cloudflare, such as `team.example.com`. Use that same name locally and remotely. Check for Docker Desktop in Applications even when its CLI is absent from PATH, then start Docker Desktop. In a separate checkout, install this repo's dependencies with `bin/pnpm install --frozen-lockfile`.
2. Have the owner authorize creation of the local community and its owner identity. Run `bin/node scripts/local-community/setup.mjs team.example.com` with their chosen hostname. This starts the relay, database and file storage in their own Compose project. It generates an owner key file in a private directory on their Mac and prints only its path. Rerun with the same hostname after interruptions. Never read or print the private file or the server settings into the conversation.
3. Guide the owner through creating a **named Cloudflare Tunnel** in their account. Run its connector on this Mac. The owner handles Cloudflare sign-in and enters any connector credential privately. Add a published application route for the chosen hostname with service type **HTTP** and URL **127.0.0.1:18479**. Use a fresh DNS name. The gateway only listens on loopback and forwards permitted routes to the invite-only relay. [Cloudflare Tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
4. Before opening the app, check HTTPS discovery. Fetch both `http://127.0.0.1:18479/` (with the chosen Host header) and the public HTTPS URL with `Accept: application/nostr+json`. Require matching nonempty `self` public keys, anonymous POST to `/query` rejected, and public `/operator/communities` returning 404. Resolve any tunnel or DNS error before continuing.
5. The owner opens Workrooms and chooses **Set up my workspace**, then **Use an existing key**. Have them use the file picker to import `~/Library/Application Support/BraveBrand Workrooms Local Server/owner.txt` privately. They then enter the public HTTPS address on **Connect your workspace**. This is the identity the local relay recognizes as its owner. Complete the profile and verify Owner in membership. Create an invite in the app and send it privately to the employee. The employee pastes the invite in Workrooms and uses their own identity. Verify a message in both directions.
6. Keep the private server settings and owner file with your backups, alongside backups of the Docker volumes containing the database, uploads and git data. To pause the server, use Docker Desktop to stop the **bravebrand-workrooms-local** project. Starting it again preserves the community. Removing volumes erases community data.

# BraveBrand self-hosted client

Build the local macOS client with `scripts/bravebrand-client.sh`. Open `target/debug/bundle/macos/BraveBrand.app`. Choose **I have an invite**, enter your relay’s HTTPS address or invite link and choose **Create my identity**. Your server controls admission. For an invite-only relay, use an invite or have the administrator admit the public key shown during setup. Save a private recovery copy from **Settings → Identity**. This build stores its identity separately from Buzz and does not configure a Builderlab sign-in server.

To rehearse first launch on the same macOS login, run `scripts/bravebrand-client.sh --rehearsal` and open `target/debug/bundle/macos/Brave Agent Workrooms Rehearsal.app`. This separate installation owns its own identity, agents, plugin profile and URL scheme. Enter the new server’s HTTPS address or paste its invite into the app. Reopening the rehearsal app resumes that rehearsal. AI tools installed for the macOS user can still be available.

# BraveBrand Buzz pilot

This Mac pilot includes the Claude Code account sign-in from upstream [pull request 2995](https://github.com/block/buzz-app/pull/2995), pinned at `23a7fbdbc`. The client uses the account the owner signs into through Claude Code. The pilot build has its own app identifier and URL scheme.

From this branch, build the local Mac app with:

```sh
bin/just desktop-bundle --config src-tauri/tauri.bravebrand-pilot.conf.json
codesign --force --sign - --timestamp=none "target/debug/bundle/macos/BraveBrand Buzz Pilot.app"
codesign --verify --deep --strict "target/debug/bundle/macos/BraveBrand Buzz Pilot.app"
```

Open `target/debug/bundle/macos/BraveBrand Buzz Pilot.app`. The desktop community join screen requires an HTTPS address with trusted TLS. Once you have joined your community, choose Claude in agent setup and check the account shown before starting a conversation. Import Simon from your own BraveBrand agent card.

## Upstream Buzz

Your people, your agents, your projects — all in one place. Buzz is a desktop
app for team chat and AI agents: join a community, talk in channels and direct
messages, and run agents such as Claude, Codex, Goose or Pi on your own
computer that answer you right in the conversation.

![A Buzz chat with an agent replying](docs/assets/readme/solo-chat.png)

> [!IMPORTANT]
> **Buzz 1.0 is in beta.** Buzz 0.X is still available and supported in
> [block/buzz](https://github.com/block/buzz).

## Get started

### 1. Download

Get the newest build from the [releases page](https://github.com/block/buzz-app/releases).

| Platform | Download | Notes |
| --- | --- | --- |
| macOS (Apple Silicon) | `Buzz_…_aarch64.dmg` | Signed and notarized. |
| macOS (Intel) | `Buzz_…_x64.dmg` | Signed and notarized. |
| Windows (x64) | `Buzz_…_x64_unsigned.exe` | Not code-signed, so Windows SmartScreen warns you before it runs. |
| Linux (x64) | `Buzz_…_amd64.deb` or `Buzz_…_x86_64.AppImage` | Built on Ubuntu 24.04. |

Once installed, Buzz updates itself. You can also check from
**Settings → Software updates**.

### 2. Set up your identity

![The first-launch screen](docs/assets/readme/identity-setup.png)

Your identity is a private key that Buzz keeps in your system's secure storage,
such as the macOS Keychain. On first launch, pick one:

- **Create a new identity** to start fresh.
- **Continue with your Buzz identity** brings your identity over from Buzz 0.X
  in one click, so you can rejoin your communities. It only appears if Buzz 0.X
  is installed on this computer, and macOS may ask you to allow Keychain access.
- **Use an existing key** to paste a private key (`nsec1…`), for example from
  **Identity details** in Buzz 0.X on another computer.

**Save a copy of your key now.** Buzz doesn't back it up for you. Open
**Settings → Identity**, choose **Copy private key**, and store it somewhere
safe, such as a password manager. Without it you can't get your identity back
on another computer.

### 3. Join a community

Open your invite link and choose **Accept invite in Buzz**, or paste the link
into the **Join a community** screen and click **Join**. If the link opens
Buzz 0.X instead, paste it. Already a member from Buzz 0.X? Paste the
community's address, such as `https://feedback.communities.buzz.xyz`. Add more
communities later from the community button in the top-right corner →
**Join a community**.

**No invite?** Paste the Buzz feedback community's invite,
`https://feedback.communities.buzz.xyz/invite/v2.yC8ZZIz5vwWCZYo2RRheuY1a0IKZRTXvxTmK7vIFIIY`,
create one with **Create a community** (or at [buzz.xyz](https://buzz.xyz)), or
[run your own relay](https://github.com/block/buzz#i-want-my-own-hosted-relay)
from block/buzz.

![The Join a community screen](docs/assets/readme/join-community.png)

### 4. Add your first agent

Open **Agents** in the app dock and choose **Create your first agent** (or
**New agent → Create a new agent**). Agents belong to a community, so add yours
first. Give the agent a name, pick a **Harness**, and optionally choose a model
and write instructions. Then click **Create agent**.

![Creating an agent](docs/assets/readme/create-agent.png)

| Harness | Platforms | What you need |
| --- | --- | --- |
| Claude | macOS, Linux | A Claude account. Click **Install integration** to download Buzz's own copy (about 250 MB), then **Sign in** in your browser. It shares settings with the `claude` in your terminal but doesn't change it. |
| Codex | macOS, Linux | A ChatGPT or OpenAI account. Click **Install integration** (about 130 MB), then **Sign in** in your browser. |
| Goose | macOS, Linux, Windows | Included with Buzz. Choose a model provider and enter its key in **Settings → Agent setup → Harness defaults → Goose**. Providers that sign in through goose instead need `goose configure` from the separate goose CLI. |
| Pi | macOS, Linux, Windows | Node.js 22.19 or later. Turn on **Pi** in **Settings → Plugins** first. Click the model, choose a provider, paste its **API key**, and click **Save to Pi**. Providers that sign in another way need `pi`, then `/login`, in your terminal. |

The install and sign-in buttons appear in the create dialog's **Model** row, and
in **Settings → Agent setup → Harness defaults**. Agents run on your computer
while Buzz is open. They work in `~/.buzz` by default and can run commands and
edit files there.

### 5. Talk to it

- **New chat:** click **+** at the top of the Messages sidebar, beside
  **All / Solo / Team**, and choose **New chat**. Your default agent is tagged
  for you; type a message and send.
- **Direct message:** open the agent's profile and click **Message**.
- **In a channel:** @mention the agent. If it isn't in the channel yet, Buzz
  asks whether to **Invite** it.

### 6. Use the command line (optional)

Buzz includes the `buzz` command line client at
`/Applications/Buzz.app/Contents/Resources/bin/buzz`, so scripts and agents need
no separate install. To run it as `buzz`, link it into your `PATH`:

```sh
mkdir -p ~/.local/bin
ln -sf /Applications/Buzz.app/Contents/Resources/bin/buzz ~/.local/bin/buzz
```

## Preview limitations

- Builds come straight from `main`; there's no stable release channel yet.
- Updates can break plugins (see [Plugins](#plugins)).
- The Windows installer is unsigned, and Intel macOS, Windows and Linux get
  less testing than Apple Silicon macOS.
- Claude and Codex agents need macOS or Linux. Goose and Pi work everywhere.
- Buzz doesn't back up your key, so keep your own copy (see step 2).
- Bringing your identity over from Buzz 0.X doesn't bring your communities
  (rejoin them in step 3) or your agents. On the Agents page, bring agents
  with **Import them now** or **New agent → Import an agent**, and teams with
  **New team → Import a team**.

## Plugins

Much of Buzz is built from plugins, and you can add your own in
**Settings → Plugins**. The plugin API is a preview: Buzz changes fast, and an
update can break a plugin.

Some parts change less than others:

- **Steady:** the manifest, commands, network requests and file reads, agent
  tools, shortcuts, notifications, settings cards, and plugin pages and panels
  (though where they appear may move).
- **Likely to break:** reading relay data, anything added to conversations or
  the sidebar, agent hooks, and UI added to pages Buzz owns.

See [plugin architecture](docs/plugin-architecture.md) to build one.

## Build from source

```sh
git clone https://github.com/block/buzz-app.git
cd buzz-app
bin/just desktop
```

Hermit in `bin/` pins every tool. Desktop builds also need the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). See
[contributing](docs/contributing.md) for development setup, live relay
development, testing and hooks, and [plugin architecture](docs/plugin-architecture.md)
to build plugins.

## Project resources

- [Contributing](docs/contributing.md)
- [Plugin architecture and the `buzzodz` CLI](docs/plugin-architecture.md)
- [Contextual identity names: cross-client spec and fixtures](src/bundled/identity-naming/README.md)
- [Mention rules: cross-client spec and fixtures](src/bundled/mentions/README.md)
- [Buzz feedback community invite](https://feedback.communities.buzz.xyz/invite/v2.yC8ZZIz5vwWCZYo2RRheuY1a0IKZRTXvxTmK7vIFIIY)
- [@buzzdotxyz on X](https://x.com/buzzdotxyz)
- [Project leads](CODEOWNERS)
- [Governance](GOVERNANCE.md)
- [Apache-2.0 license](LICENSE)
- [Source attribution](NOTICE.md)
