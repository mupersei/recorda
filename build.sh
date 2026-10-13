#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="recoda-ext"
CONTAINER_DIR="/app"
HOST_DIR="${HOST_DIR:-$HOME/Documents/recoda-ext}"  # 필요 시 HOST_DIR 환경 변수로 지정
ARCHIVE_NAME="recoda-ext-$(date +%Y%m%d-%H%M%S).tar.gz"

# 1) 컨테이너 내부 /app 을 tar.gz로 압축 생성
docker exec "${CONTAINER_NAME}" \
  sh -c "cd '${CONTAINER_DIR}' && tar -czf /tmp/${ARCHIVE_NAME} ."

# 2) 컨테이너의 압축 파일을 호스트로 복사
docker cp "${CONTAINER_NAME}:/tmp/${ARCHIVE_NAME}" "${HOST_DIR}/"

# 3) 호스트에서 압축 해제
cd "${HOST_DIR}"
tar -xzf "${ARCHIVE_NAME}"

# 4) 컨테이너/호스트의 압축 파일 삭제
docker exec "${CONTAINER_NAME}" rm -f "/tmp/${ARCHIVE_NAME}"
rm -f "${HOST_DIR}/${ARCHIVE_NAME}"
