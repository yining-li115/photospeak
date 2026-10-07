# PhotoSpeak CI/CD

Every push to `main` runs the mobile and backend verification suites in
parallel. Production deployment begins only when both jobs pass. GitHub Actions
then invokes a forced-command SSH entry point over a host-key-pinned connection.
The server accepts only the exact current `origin/main` SHA and loads the
deployment script from that verified revision.

The deployment script checks out the exact GitHub SHA, installs locked
dependencies, builds, stops the singleton PM2 process, runs forward migrations
only when required, restarts the API, and runs the local production smoke test.
Concurrent deployments are serialized by both GitHub Actions and a server-side
`flock` lock.

## Required GitHub Actions secrets

Configure these repository Actions secrets:

- `PROD_SSH_HOST`: production SSH hostname, normally `api.dailyphotospeak.cn`.
- `PROD_SSH_USER`: the dedicated production deployment user.
- `PROD_SSH_PRIVATE_KEY`: an Ed25519 private key used only by GitHub Actions.
- `PROD_SSH_KNOWN_HOSTS`: a verified `known_hosts` line for the production
  hostname. The workflow deliberately does not trust a key scanned at runtime.
- `PROD_SSH_PORT`: optional; defaults to `22` when omitted.

The deploy key is restricted in `authorized_keys` to
`/usr/local/sbin/photospeak-github-deploy`, with shell, PTY, forwarding, agent,
X11, and user-rc access disabled. The wrapper accepts only
`photospeak-deploy <full SHA>` and requires that SHA to equal the current
`origin/main`. It does not belong in the repository and must not be reused for
ordinary personal SSH access. Provider, database, Apple, SMS, and signing
credentials remain only in the protected server environment; GitHub receives
none of them.

## Rollback behavior

Code-only releases automatically restore the previous commit, rebuild it,
restart PM2, and run the smoke test when deployment fails.

PostgreSQL migrations are forward-only. Once a migration attempt starts, the
service fails closed instead of launching old code against a potentially newer
schema. A persistent server-local marker forces an interrupted migration to be
retried on the next deployment. Resolve these incidents with a forward fix;
never clear the marker merely to make an old release start.

Successful deployments receive a server-local lightweight
`deploy-success-<UTC timestamp>` tag. Tags are not pushed back to GitHub.

## Initial server preparation

The current Alibaba Cloud installation runs the checkout and PM2 process as
`root` from `/root/photospeak`. The forced-command wrapper limits the dedicated
GitHub key instead of granting it a general-purpose root shell.

Initial preparation is:

- install `backend/scripts/github-deploy-wrapper.sh` as
  `/usr/local/sbin/photospeak-github-deploy`, owned by root and mode `0755`;
- append the dedicated public key to `/root/.ssh/authorized_keys` with the
  forced-command and forwarding restrictions shown in the wrapper header;
- pin the server's verified Ed25519 host key in `PROD_SSH_KNOWN_HOSTS`;
- verify both an accepted current-main deployment command and a rejected shell
  command before enabling the workflow.

After preparation, run the workflow manually once. A normal push to `main`
then uses the same path automatically.
