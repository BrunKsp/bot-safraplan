#!/usr/bin/env bash
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Uso: npm run migration:generate -- <NomeDaMigration>"
  exit 1
fi

typeorm-ts-node-commonjs migration:generate "src/database/migrations/$1" -d src/database/data-source.ts
