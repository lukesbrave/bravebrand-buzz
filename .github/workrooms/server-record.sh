#!/usr/bin/env bash
# Prints what a workspace holds, for comparing it before and after a move:
# its address, its community's id, how many records each table has, its
# identity, and a checksum of every stored file. Takes the Docker project name.
set -euo pipefail
project=$1
one() {
	docker ps -q --filter "label=com.docker.compose.project=$project" \
		--filter "label=com.docker.compose.service=$1"
}
sql() {
	docker exec "$(one postgres)" sh -c \
		'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -c "$0"' "$1"
}
echo "host=$(sql 'SELECT host FROM communities WHERE deleted_at IS NULL')"
echo "community=$(sql 'SELECT id FROM communities WHERE deleted_at IS NULL')"
echo "communities=$(sql 'SELECT count(*) FROM communities')"
for table in events users relay_members relay_invites; do
	echo "$table=$(sql "SELECT count(*) FROM $table")"
done
echo "owner_member=$(sql "SELECT count(*) FROM relay_members WHERE role = 'owner'" 2>/dev/null || echo unknown)"
echo "identity=$(docker exec "$(one relay)" sh -c 'echo "$BUZZ_RELAY_PRIVATE_KEY"' | sha256sum | cut -c1-16)"
echo "owner=$(docker exec "$(one relay)" sh -c 'echo "$RELAY_OWNER_PUBKEY"')"
# The storage image has no find; read its volume from the database image.
# Top-level dot folders are each service's own scratch space, remade on start.
tree() {
	docker run --rm --network none --volumes-from "$(one "$1")" "$(docker inspect -f '{{.Config.Image}}' "$(one postgres)")" \
		sh -c 'cd "$0" && find . -type f ! -path "./.*" -exec sha256sum {} + | sort -k2' "$2"
}
echo "files_marker=$(docker exec "$(one minio)" cat /data/ci/marker.txt)"
echo "git=$(tree relay /data/git | sha256sum | cut -c1-16) ($(tree relay /data/git | wc -l) files)"
tree minio /data | sed 's/^/stored-file /'
echo "git_marker=$(docker exec -u 0 "$(one relay)" cat /data/git/ci/marker.txt)"
