#!/usr/bin/env bash
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source "$script_dir/common.sh"
commit=${1:?Expected source commit}; destination=${2:?Expected bundle directory}
validate_sha "$commit"
origin=${ALIYUN_PUBLIC_ORIGIN:-https://www.treefund.asia}
validate_origin "$origin"
mkdir -p "$destination"
docker build -f selfhost/Dockerfile --build-arg "APP_COMMIT_SHA=$commit" --build-arg "SELFHOST_PUBLIC_ORIGIN=$origin" \
  --label "org.opencontainers.image.revision=$commit" -t "jiashu-test:$commit" .
docker image save "jiashu-test:$commit" | gzip -1 > "$destination/image.tar.gz"
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "jiashu-test:$commit")
ARCHIVE_SHA256=$(sha256sum "$destination/image.tar.gz" | awk '{print $1}')
export IMAGE_ID ARCHIVE_SHA256
node --input-type=module -e "import{writeFileSync}from'node:fs';writeFileSync(process.argv[1],JSON.stringify({version:1,commitSha:process.argv[2],imageId:process.env.IMAGE_ID,archiveSha256:process.env.ARCHIVE_SHA256})+'\n')" "$destination/manifest.json" "$commit"
cp "$script_dir/"*.sh "$script_dir/"*.mjs "$script_dir/compose.yml" "$destination/"
