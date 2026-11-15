#!/bin/bash
# battery.sh <tag> [questions.tsv]: run every question (id<TAB>question) as its own session; then: python3 analyze.py <tag>
HERE=$(cd "$(dirname "$0")" && pwd); tag=$1; file=${2:-$HERE/questions.tsv}
while IFS=$'\t' read -r id q; do
  [ -n "$id" ] || continue
  s=$(date +%s); "$HERE/ask.sh" "$tag-$id" "$q"; echo "$tag-$id $(( $(date +%s) - s ))s $(tail -1 "${EVAL_DIR:-./eval-runs}/runs/$tag-$id.err")"
done < "$file"
