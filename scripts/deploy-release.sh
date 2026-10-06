#!/usr/bin/env bash
set -Eeuo pipefail

: "${IMAGE_REF:?IMAGE_REF is required}"
: "${RELEASE:?RELEASE is required}"
: "${PRODUCTION_HOST:?PRODUCTION_HOST is required}"
: "${PRODUCTION_URL:?PRODUCTION_URL is required}"

BASE=/opt/project-reader/releases
CURRENT=/opt/project-reader/current
ROLLBACK_FILE="/opt/project-reader/.rollback-$RELEASE"
LOCK_FILE=/opt/project-reader/deploy.lock
PROJECT=project-reader
KEEP_SUCCESSFUL_RELEASES=3
MIN_FREE_KB=1048576

[[ "$RELEASE" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid release: $RELEASE" >&2; exit 2; }
[[ "$IMAGE_REF" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$ ]] || {
    echo "IMAGE_REF must be an immutable GHCR digest" >&2
    exit 2
}
[[ "$PRODUCTION_HOST" =~ ^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$ ]] || {
    echo "Invalid production DNS name: $PRODUCTION_HOST" >&2
    exit 2
}
[[ "$PRODUCTION_URL" == "https://$PRODUCTION_HOST" || "$PRODUCTION_URL" == "https://$PRODUCTION_HOST/" ]] || {
    echo "PRODUCTION_URL must be https://PRODUCTION_HOST" >&2
    exit 2
}
PRODUCTION_URL="${PRODUCTION_URL%/}"

install -d -m 700 "$BASE"
exec 9>"$LOCK_FILE"
if ! flock --exclusive --timeout 900 9; then
    echo "Another deployment holds $LOCK_FILE" >&2
    exit 1
fi

release_dir="$BASE/$RELEASE"
compose_file="$release_dir/docker-compose.yml"
image_file="$release_dir/image-ref"
compose=(docker compose --project-name "$PROJECT" --file "$compose_file")

validate_release_dir() {
    local directory=$1 expected_revision=$2 expected_image=$3 resolved compose_path stored_image image_revision
    resolved="$(readlink -f -- "$directory")"
    [[ "$resolved" == "$BASE/"* && "$resolved" != "$BASE" ]]
    [[ "$(basename "$resolved")" =~ ^[0-9a-f]{40}$ ]]
    compose_path="$resolved/docker-compose.yml"
    [[ -f "$compose_path" && ! -L "$compose_path" && ! -w "$compose_path" ]]
    [[ -f "$resolved/image-ref" && ! -L "$resolved/image-ref" && ! -w "$resolved/image-ref" ]]
    IFS= read -r stored_image < "$resolved/image-ref"
    [[ "$stored_image" == "$expected_image" ]]
    image_revision="$(docker image inspect "$stored_image" \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
    [[ "$image_revision" == "$expected_revision" ]]
}

migrate_legacy_release_metadata() {
    local directory=$1 image=$2 revision=$3 resolved image_revision
    resolved="$(readlink -f -- "$directory")"
    [[ "$resolved" == "$BASE/"* && "$(basename "$resolved")" == "$revision" ]]
    [[ -f "$resolved/docker-compose.yml" && ! -L "$resolved/docker-compose.yml" ]]
    [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]]
    image_revision="$(docker image inspect "$image" \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
    [[ "$image_revision" == "$revision" ]]
    chmod u+w "$resolved"
    printf '%s\n' "$image" > "$resolved/image-ref"
    chmod 444 "$resolved/docker-compose.yml" "$resolved/image-ref"
    chmod 555 "$resolved"
}

verify_release() {
    local directory=$1 image=$2 expected_revision=$3 container_id actual
    local previous_compose=(docker compose --project-name "$PROJECT" --file "$directory/docker-compose.yml")
    container_id="$(PRODUCTION_HOST="$PRODUCTION_HOST" DEPLOY_IMAGE="$image" \
        "${previous_compose[@]}" ps --quiet web)"
    [[ -n "$container_id" ]]
    actual="$(docker exec "$container_id" wget --quiet -O - \
        --header="Host: $PRODUCTION_HOST" http://127.0.0.1/health/version)"
    [[ "$actual" == "$expected_revision" ]]

    actual="$(curl --fail --silent --show-error --retry 10 --retry-all-errors \
        --retry-delay 3 --max-time 10 "$PRODUCTION_URL/health/version")"
    [[ "$actual" == "$expected_revision" ]]
}

previous_image=""
previous_dir=""
previous_revision=""
previous_container="$(docker ps --quiet \
    --filter "label=com.docker.compose.project=$PROJECT" \
    --filter 'label=com.docker.compose.service=web' | head -n 1)"
if [[ -n "$previous_container" ]]; then
    previous_image="$(docker inspect "$previous_container" --format '{{.Config.Image}}')"
    previous_revision="$(docker image inspect "$previous_image" \
        --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
    previous_dir="$(readlink -f "$CURRENT" 2>/dev/null || true)"
    if [[ -n "$previous_dir" && ! -e "$previous_dir/image-ref" ]]; then
        migrate_legacy_release_metadata "$previous_dir" "$previous_image" "$previous_revision"
    fi
    if ! validate_release_dir "$previous_dir" "$previous_revision" "$previous_image"; then
        echo "The active release is not a valid rollback target" >&2
        exit 1
    fi
    if [[ ! -f "$previous_dir/.successful" ]]; then
        chmod u+w "$previous_dir"
        touch "$previous_dir/.successful"
        chmod 444 "$previous_dir/.successful"
        chmod 555 "$previous_dir"
    fi
elif [[ -e "$CURRENT" ]]; then
    previous_dir="$(readlink -f "$CURRENT")"
    previous_revision="$(basename "$previous_dir")"
    if [[ ! -f "$previous_dir/image-ref" ]] || ! IFS= read -r previous_image < "$previous_dir/image-ref"; then
        echo "The active release is not a valid rollback target" >&2
        exit 1
    fi
    if ! validate_release_dir "$previous_dir" "$previous_revision" "$previous_image"; then
        echo "The active release is not a valid rollback target" >&2
        exit 1
    fi
fi

printf '%s\n%s\n%s\n' "$previous_image" "$previous_dir" "$previous_revision" > "$ROLLBACK_FILE.tmp"
chmod 600 "$ROLLBACK_FILE.tmp"
mv "$ROLLBACK_FILE.tmp" "$ROLLBACK_FILE"

rollback() {
    local status=$?
    trap - ERR INT TERM
    echo "Deployment failed; restoring the previous complete release" >&2
    if [[ -z "$previous_image" ]]; then
        PRODUCTION_HOST="$PRODUCTION_HOST" DEPLOY_IMAGE="$IMAGE_REF" \
            "${compose[@]}" down --remove-orphans || true
        echo "No previous release exists; the failed candidate was stopped" >&2
        return "$status"
    fi

    if ! validate_release_dir "$previous_dir" "$previous_revision" "$previous_image"; then
        echo "Rollback metadata is invalid; preserving $ROLLBACK_FILE" >&2
        return 1
    fi

    local previous_compose=(docker compose --project-name "$PROJECT" --file "$previous_dir/docker-compose.yml")
    if ! PRODUCTION_HOST="$PRODUCTION_HOST" DEPLOY_IMAGE="$previous_image" \
        "${previous_compose[@]}" up --detach --remove-orphans --wait; then
        echo "Rollback startup failed; preserving $ROLLBACK_FILE" >&2
        return 1
    fi
    if ! verify_release "$previous_dir" "$previous_image" "$previous_revision"; then
        echo "Rollback verification failed; preserving $ROLLBACK_FILE" >&2
        return 1
    fi

    next_link="/opt/project-reader/.rollback-current-$RELEASE"
    rm -f "$next_link"
    ln -s "$previous_dir" "$next_link"
    mv -Tf "$next_link" "$CURRENT"
    rm -f "$ROLLBACK_FILE"
    return "$status"
}
trap rollback ERR INT TERM

image_revision="$(docker image inspect "$IMAGE_REF" \
    --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}')"
[[ "$image_revision" == "$RELEASE" ]]
[[ -f "$compose_file" && ! -L "$compose_file" && ! -w "$compose_file" ]]
[[ -f "$image_file" && ! -L "$image_file" && ! -w "$image_file" ]]
[[ "$(<"$image_file")" == "$IMAGE_REF" ]]

PRODUCTION_HOST="$PRODUCTION_HOST" DEPLOY_IMAGE="$IMAGE_REF" "${compose[@]}" config --quiet
PRODUCTION_HOST="$PRODUCTION_HOST" DEPLOY_IMAGE="$IMAGE_REF" \
    "${compose[@]}" up --detach --remove-orphans --wait
verify_release "$release_dir" "$IMAGE_REF" "$RELEASE"

next_link="/opt/project-reader/.current-$RELEASE"
rm -f "$next_link"
ln -s "$release_dir" "$next_link"
mv -Tf "$next_link" "$CURRENT"
chmod u+w "$release_dir"
touch "$release_dir/.successful"
chmod 444 "$release_dir/.successful"
chmod 555 "$release_dir"
rm -f "$ROLLBACK_FILE"
trap - ERR INT TERM

echo "Disk usage before retention cleanup:"
df -h /opt/project-reader
docker system df

mapfile -t successful_dirs < <(
    find "$BASE" -mindepth 2 -maxdepth 2 -type f -name .successful -printf '%T@ %h\n' \
        | sort -nr | head -n "$KEEP_SUCCESSFUL_RELEASES" | cut -d' ' -f2-
)
declare -A retained=()
retained["$(readlink -f "$CURRENT")"]=1
for directory in "${successful_dirs[@]}"; do retained["$directory"]=1; done

while IFS= read -r directory; do
    [[ -n "${retained[$directory]:-}" ]] && continue
    chmod -R u+w "$directory"
    rm -rf -- "$directory"
done < <(find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' -print)

mapfile -t retained_images < <(
    for directory in "${!retained[@]}"; do
        [[ -f "$directory/image-ref" ]] && cat "$directory/image-ref"
    done | sort -u
)
while IFS= read -r local_image; do
    [[ "$local_image" == *@sha256:* ]] || continue
    keep=false
    for retained_image in "${retained_images[@]}"; do
        [[ "$local_image" == "$retained_image" ]] && keep=true
    done
    $keep || docker image rm "$local_image" >/dev/null 2>&1 || true
done < <(docker image ls --digests --format '{{.Repository}}@{{.Digest}}' \
    | grep '^ghcr\.io/' | sort -u || true)
docker image prune --force >/dev/null

find "$BASE" -mindepth 1 -maxdepth 1 -type d -name '.incoming-*' -mtime +1 -exec rm -rf -- {} +
find /opt/project-reader -maxdepth 1 -type l \( -name '.current-*' -o -name '.rollback-current-*' \) -mtime +1 -delete
find /opt/project-reader -maxdepth 1 -type f -name '.rollback-*' -mtime +7 -delete

echo "Disk usage after retention cleanup:"
df -h /opt/project-reader
docker system df
free_kb="$(df -Pk /opt/project-reader | awk 'NR == 2 {print $4}')"
if (( free_kb < MIN_FREE_KB )); then
    echo "Deployment succeeded, but less than 1 GiB remains; manual cleanup is required" >&2
fi
