# Production deployment runbook

## Selected operating policy

The repository implements these conservative defaults until maintainers deliberately change them:

- a successful CI run for the current protected `master` tip deploys automatically;
- brief downtime while the single application container is recreated is acceptable, so blue/green deployment is not enabled;
- fixable `CRITICAL` image vulnerabilities block publication;
- production runs with a rootless Docker daemon. The container keeps only `NET_BIND_SERVICE`; all other capabilities are dropped.

GitHub environment reviewers can be enabled later without changing the workflow. Tighten the scanner to `HIGH,CRITICAL` only after the exception process in `.github/VULNERABILITY_EXCEPTIONS.md` has been exercised.

## GitHub configuration

Create a `production` environment restricted to the `master` branch. Set:

| Kind                 | Name                 | Value                                                           |
| -------------------- | -------------------- | --------------------------------------------------------------- |
| Environment variable | `PRODUCTION_HOST`    | Project-controlled DNS name, for example `reader.example.org`   |
| Environment variable | `PRODUCTION_URL`     | Matching HTTPS origin, for example `https://reader.example.org` |
| Environment secret   | `DEPLOY_HOST`        | SSH host name or address                                        |
| Environment secret   | `DEPLOY_USER`        | Rootless Docker account                                         |
| Environment secret   | `DEPLOY_SSH_KEY`     | Dedicated private deployment key                                |
| Environment secret   | `DEPLOY_KNOWN_HOSTS` | Pinned `known_hosts` entry for `DEPLOY_HOST`                    |

Point the production DNS `A`/`AAAA` record at the host before the first deployment. Configure the host Caddy reverse proxy described below before the first public verification; it terminates HTTPS and obtains and renews the certificate. The Caddy process inside the application container has `auto_https` disabled and serves only internal HTTP. `PRODUCTION_HOST` must be a DNS name; IP literals and shell metacharacters are rejected.

After `Production container check` has run on the default branch, protect `master` with a ruleset that:

- requires pull requests and one approval;
- requires CODEOWNER review, dismisses stale approvals, and requires approval of the latest push;
- requires branches to be current and the checks `Tests, checks, formatting, and linting` and `Production container check`;
- blocks force pushes and deletion;
- applies to administrators or has a narrowly controlled bypass list.

Ensure the owner in `.github/CODEOWNERS` is valid, then add a second repository member or team to every entry. GitHub cannot enforce this from a committed file. Verify protection with:

```sh
gh api repos/OWNER/REPOSITORY/branches/master/protection
gh api repos/OWNER/REPOSITORY/environments/production
```

The responses must show at least one required approval, `require_code_owner_reviews: true`, both required check names, and a production deployment branch policy restricted to `master`.

## Host prerequisites

- Linux host with current security updates
- rootless Docker Engine 27 or newer and Compose v2.30 or newer
- `bash`, `curl`, `flock`, `find`, `awk`, and OpenSSH
- a host Caddy installation managed separately from the rootless Docker daemon
- inbound TCP 22 from the runner path and TCP 80/443 for host Caddy (allow UDP 443 if HTTP/3 is enabled)
- outbound DNS and HTTPS access for GHCR and the host Caddy's ACME issuer
- `/opt/project-reader` owned by the deployment user with mode `0700`
- at least 1 GiB free after retained releases and images

For rootless Docker, install it for `DEPLOY_USER`, enable lingering, and select the user's rootless Docker context. The Compose service publishes only `127.0.0.1:8000`, so it does not require permission to bind public ports:

```sh
sudo loginctl enable-linger DEPLOY_USER
```

Confirm with `docker info` that the daemon is rootless. The application container serves HTTP behind the host Caddy and has a read-only root filesystem, no-new-privileges, a 128 PID limit, 256 MiB memory limit, one CPU, and only `NET_BIND_SERVICE`.

Configure the host Caddy instance to proxy the public name to the loopback-only container port. For example, add this site to the host Caddy configuration (not to the repository `Caddyfile`):

```caddyfile
reader.example.org {
    reverse_proxy 127.0.0.1:8000
}
```

Replace the hostname, validate the host configuration, and reload host Caddy before deployment. Confirm that it owns TCP 80/443 and that `https://PRODUCTION_HOST/health/version` reaches the application after the container starts. The repository `Caddyfile` intentionally disables automatic HTTPS because this host instance owns public TLS.

Bootstrap the top-level directory once as an administrator, then create releases as the deployment user:

```sh
sudo install -d -o DEPLOY_USER -g DEPLOY_USER -m 700 /opt/project-reader
sudo -u DEPLOY_USER install -d -m 700 /opt/project-reader/releases
```

## Deployment and rollback behavior

CI builds one image, verifies its release endpoint, generates and attests an SPDX SBOM, blocks fixable critical vulnerabilities, and publishes by digest. Deployment then:

1. pulls that exact digest;
2. stores immutable `docker-compose.yml` and `image-ref` files in the release directory;
3. acquires `/opt/project-reader/deploy.lock` with `flock`;
4. records and validates the previous image, release directory, Compose file, and image revision;
5. starts the candidate with `docker compose up --wait`;
6. verifies the expected revision internally and through public HTTPS;
7. atomically updates `current` only after verification;
8. retains the latest three successful releases and all images they reference.

A failed candidate is rolled back with the previous release's Compose file. Rollback metadata is deleted only after rollback verifies successfully. If rollback fails, preserve `/opt/project-reader/.rollback-*` and inspect it before taking manual action.

Manual rollback to a retained release:

```sh
release=/opt/project-reader/releases/COMMIT_SHA
image=$(cat "$release/image-ref")
revision=$(basename "$release")
PRODUCTION_HOST=reader.example.org DEPLOY_IMAGE="$image" \
  docker compose --project-name project-reader -f "$release/docker-compose.yml" \
  up --detach --remove-orphans --wait
container=$(PRODUCTION_HOST=reader.example.org DEPLOY_IMAGE="$image" \
  docker compose --project-name project-reader -f "$release/docker-compose.yml" ps -q web)
test "$(docker exec "$container" wget -qO- --header='Host: reader.example.org' \
  http://127.0.0.1/health/version)" = "$revision"
ln -sfn "$release" /opt/project-reader/current
```

Use the deployment lock for manual Compose changes:

```sh
flock --exclusive /opt/project-reader/deploy.lock bash -c 'your maintenance command'
```

## Backup and disaster recovery

Back up the host Caddy configuration and its persistent data directory; the data directory contains the ACME account and certificate state. For packaged systemd installations this is commonly `/var/lib/caddy/.local/share/caddy`, but verify the active service's configured data directory with `systemctl cat caddy` and `caddy environ`. Also back up `/opt/project-reader/releases`. Never copy live certificate state inconsistently: stop host Caddy or use a filesystem snapshot.

Recovery sequence:

1. restore the host Caddy configuration/data and `/opt/project-reader/releases`;
2. restore DNS and firewall rules;
3. choose a retained release and pull the digest in its `image-ref` if absent;
4. run the manual rollback commands above;
5. verify `https://PRODUCTION_HOST/health/version` and the host Caddy certificate expiry;
6. verify restart recovery by recreating the service and rebooting during a maintenance window.

Useful diagnostics:

```sh
docker compose --project-name project-reader -f /opt/project-reader/current/docker-compose.yml ps
docker logs project-reader-web-1
docker system df
df -h /opt/project-reader
curl -fsS https://reader.example.org/health/version
```
