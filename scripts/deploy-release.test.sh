#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
release=0123456789abcdef0123456789abcdef01234567
image="ghcr.io/example/vfs@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
previous_release=fedcba9876543210fedcba9876543210fedcba98
previous_image="ghcr.io/example/vfs@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

run_case() (
    set -Eeuo pipefail
    local free_kb=$1
    local root mock_bin deployment status
    root=$(mktemp -d "${TMPDIR:-/tmp}/deploy-release-regression.XXXXXX")
    trap 'chmod -R u+w -- "$root" 2>/dev/null || true; rm -rf -- "$root"' EXIT
    mock_bin="$root/bin"
    deployment="$root/deploy-release.sh"
    mkdir -p "$mock_bin" "$root/releases/$release"

    sed "s|/opt/vfs|$root|g" "$script_dir/deploy-release.sh" > "$deployment"
    chmod 755 "$deployment"
    printf '%s\n' 'services:' > "$root/releases/$release/docker-compose.yml"
    printf '%s\n' "$image" > "$root/releases/$release/image-ref"
    chmod 444 "$root/releases/$release/docker-compose.yml" "$root/releases/$release/image-ref"
    chmod 555 "$root/releases/$release"

    cat > "$mock_bin/docker" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
root='$root'
log="\$root/events"
if [[ "\$1" == ps ]]; then
    exit 0
fi
if [[ "\$1" == image && "\$2" == inspect ]]; then
    printf '%s\\n' '$release'
    exit 0
fi
if [[ "\$1" == image && "\$2" == ls ]]; then
    exit 0
fi
if [[ "\$1" == image && "\$2" == prune ]]; then
    exit 0
fi
if [[ "\$1" == system && "\$2" == df ]]; then
    exit 0
fi
if [[ "\$1" == exec ]]; then
    printf '%s\\n' '$release'
    exit 0
fi
if [[ "\$1" == compose ]]; then
    subcommand=''
    for argument in "\${@:2}"; do
        case "\$argument" in
            config|up|ps|down) subcommand="\$argument" ;;
        esac
    done
    case "\$subcommand" in
        config) ;;
        up) printf 'compose-up\\n' >> "\$log" ;;
        ps) printf 'container-id\\n' ;;
        down) printf 'compose-down\\n' >> "\$log" ;;
        *) echo "unexpected docker compose invocation" >&2; exit 1 ;;
    esac
    exit 0
fi
printf 'unexpected docker invocation:' >&2
printf ' %q' "\$@" >&2
printf '\\n' >&2
exit 1
EOF
    chmod 755 "$mock_bin/docker"

    cat > "$mock_bin/curl" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\\n' '$release'
EOF
    chmod 755 "$mock_bin/curl"

    cat > "$mock_bin/df" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "\$1" == -Pk ]]; then
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
    printf '/dev/mock 1000000 0 $free_kb 0%% $root\\n'
    printf 'df-check-current=%s\\n' "\$(readlink -f -- '$root/current' 2>/dev/null || printf missing)" >> '$root/events'
else
    printf 'Filesystem Size Used Avail Use%% Mounted on\\n/dev/mock 1G 0 1G 0%% $root\\n'
fi
EOF
    chmod 755 "$mock_bin/df"

    set +e
    PATH="$mock_bin:$PATH" \
        IMAGE_REF="$image" RELEASE="$release" \
        PRODUCTION_HOST=vfs.example.org PRODUCTION_URL=https://vfs.example.org \
        "$deployment" > "$root/stdout" 2> "$root/stderr"
    status=$?
    set -e

    if (( status != 0 )); then
        cat "$root/stdout" "$root/stderr" >&2
        echo "deployment failed for free-space case $free_kb" >&2
        exit 1
    fi
    [[ -L "$root/current" ]]
    [[ "$(readlink -f -- "$root/current")" == "$root/releases/$release" ]]
    [[ -f "$root/releases/$release/.successful" ]]
    [[ ! -e "$root/.rollback-$release" ]]
    grep -Fxq "df-check-current=$root/releases/$release" "$root/events"

    if (( free_kb < 1048576 )); then
        grep -Fq 'less than 1 GiB remains' "$root/stderr"
    else
        ! grep -Fq 'less than 1 GiB remains' "$root/stderr"
    fi
    echo "passed free-space case: $free_kb KiB"
)

run_case 100
run_case 1048576

run_no_running_container_rollback_case() (
    set -Eeuo pipefail
    local root mock_bin deployment status
    root=$(mktemp -d "${TMPDIR:-/tmp}/deploy-release-rollback.XXXXXX")
    trap 'chmod -R u+w -- "$root" 2>/dev/null || true; rm -rf -- "$root"' EXIT
    mock_bin="$root/bin"
    deployment="$root/deploy-release.sh"
    mkdir -p "$mock_bin" "$root/releases/$release" "$root/releases/$previous_release"

    sed "s|/opt/vfs|$root|g" "$script_dir/deploy-release.sh" > "$deployment"
    chmod 755 "$deployment"
    printf '%s\n' 'services:' > "$root/releases/$release/docker-compose.yml"
    printf '%s\n' "$image" > "$root/releases/$release/image-ref"
    printf '%s\n' 'services:' > "$root/releases/$previous_release/docker-compose.yml"
    printf '%s\n' "$previous_image" > "$root/releases/$previous_release/image-ref"
    printf '%s\n' > "$root/releases/$previous_release/.successful"
    chmod 444 "$root/releases/$release/docker-compose.yml" "$root/releases/$release/image-ref" \
        "$root/releases/$previous_release/docker-compose.yml" "$root/releases/$previous_release/image-ref" \
        "$root/releases/$previous_release/.successful"
    chmod 555 "$root/releases/$release" "$root/releases/$previous_release"
    ln -s "$root/releases/$previous_release" "$root/current"

    cat > "$mock_bin/docker" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
root='$root'
log="\$root/events"
if [[ "\$1" == ps ]]; then
    exit 0
fi
if [[ "\$1" == inspect ]]; then
    echo "unexpected running container inspect" >&2
    exit 1
fi
if [[ "\$1" == image && "\$2" == inspect ]]; then
    case "\$3" in
        '$image') printf '%s\\n' '$release' ;;
        '$previous_image') printf '%s\\n' '$previous_release' ;;
        *) echo "unexpected image inspect: \$3" >&2; exit 1 ;;
    esac
    exit 0
fi
if [[ "\$1" == image && "\$2" == ls ]]; then
    exit 0
fi
if [[ "\$1" == image && "\$2" == prune ]]; then
    exit 0
fi
if [[ "\$1" == system && "\$2" == df ]]; then
    exit 0
fi
if [[ "\$1" == exec ]]; then
    if [[ -f "\$root/running-image" && "\$(<"\$root/running-image")" == '$previous_image' ]]; then
        printf '%s\\n' '$previous_release'
    else
        printf '%s\\n' 'candidate-is-not-healthy'
    fi
    exit 0
fi
if [[ "\$1" == compose ]]; then
    subcommand=''
    for argument in "\${@:2}"; do
        case "\$argument" in
            config|up|ps|down) subcommand="\$argument" ;;
        esac
    done
    case "\$subcommand" in
        config) ;;
        up)
            printf '%s\\n' "\$DEPLOY_IMAGE" > "\$root/running-image"
            printf 'compose-up:%s\\n' "\$DEPLOY_IMAGE" >> "\$log"
            ;;
        ps) printf 'container-id\\n' ;;
        down) printf 'compose-down\\n' >> "\$log" ;;
        *) echo "unexpected docker compose invocation" >&2; exit 1 ;;
    esac
    exit 0
fi
printf 'unexpected docker invocation:' >&2
printf ' %q' "\$@" >&2
printf '\\n' >&2
exit 1
EOF
    chmod 755 "$mock_bin/docker"

    cat > "$mock_bin/curl" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ -f '$root/running-image' && "\$(<'$root/running-image')" == '$previous_image' ]]; then
    printf '%s\\n' '$previous_release'
else
    printf '%s\\n' 'candidate-is-not-healthy'
fi
EOF
    chmod 755 "$mock_bin/curl"

    set +e
    PATH="$mock_bin:$PATH" \
        IMAGE_REF="$image" RELEASE="$release" \
        PRODUCTION_HOST=vfs.example.org PRODUCTION_URL=https://vfs.example.org \
        "$deployment" > "$root/stdout" 2> "$root/stderr"
    status=$?
    set -e

    if (( status == 0 )); then
        cat "$root/stdout" "$root/stderr" >&2
        echo "deployment unexpectedly succeeded" >&2
        exit 1
    fi
    [[ -L "$root/current" ]]
    [[ "$(readlink -f -- "$root/current")" == "$root/releases/$previous_release" ]]
    [[ "$(<"$root/running-image")" == "$previous_image" ]]
    [[ ! -e "$root/.rollback-$release" ]]
    grep -Fq 'Deployment failed; restoring the previous complete release' "$root/stderr"
    grep -Fxq "compose-up:$image" "$root/events"
    grep -Fxq "compose-up:$previous_image" "$root/events"
    ! grep -Fq 'compose-down' "$root/events"
    echo 'passed no-running-container rollback case'
)

run_no_running_container_rollback_case
