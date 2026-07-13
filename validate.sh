#!/usr/bin/env bash
#
# Interactive menu for the SFCC translation validators.
#
#   ./validate.sh
#
# File paths you type are relative to your CURRENT directory (so run it from
# wherever your XML exports are). No Claude calls — local, read-only.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$SCRIPT_DIR/scripts"
DEFAULT_LOCALES="de-DE,es,fr-FR,it-IT,id-ID,ja-JP,ko-KR,nl-NL,pt-BR,th-TH,vi-VN,zh-TW"
CORE_LOCALES="de-DE,fr-FR,ja-JP,ko-KR" # 大多內容只翻了這四語
NODE="node --max-old-space-size=3072"

# ask <prompt> [default]  -> echoes the answer (default used on empty input)
ask() {
  local prompt="$1" def="${2:-}" ans
  if [ -n "$def" ]; then
    read -e -r -p "  $prompt [$def]: " ans
    printf '%s' "${ans:-$def}"
  else
    read -e -r -p "  $prompt: " ans
    printf '%s' "$ans"
  fi
}

need_file() {
  if [ ! -f "$1" ]; then
    echo "  ⚠️  找不到檔案：$1"
    return 1
  fi
}

# pick_file <prompt> -> echoes chosen path. Lists *.xml in the current dir so you
# can pick by number (avoids typing long/misspelled names); or type a path.
pick_file() {
  local prompt="$1" ans i=1
  local files=()
  while IFS= read -r f; do [ -n "$f" ] && files+=("$f"); done < <(ls -1 *.xml 2>/dev/null)
  {
    echo "  $prompt"
    if [ ${#files[@]} -gt 0 ]; then
      for f in "${files[@]}"; do printf '    %2d) %s\n' "$i" "$f"; i=$((i + 1)); done
      echo "    (輸入號碼選檔，或直接貼上其他路徑)"
    fi
  } >&2
  read -e -r -p "  選擇: " ans
  if printf '%s' "$ans" | grep -qE '^[0-9]+$' && [ "$ans" -ge 1 ] && [ "$ans" -le ${#files[@]} ]; then
    printf '%s' "${files[$((ans - 1))]}"
  else
    printf '%s' "$ans"
  fi
}

# pick_locales -> echoes a comma-separated locale list. Defaults to the core
# four (日韓德法) since most content is only translated into those.
pick_locales() {
  local ans
  {
    echo "  選擇語言範圍："
    echo "    1) 日韓德法  ($CORE_LOCALES)"
    echo "    2) 全部 12 種 ($DEFAULT_LOCALES)"
    echo "    3) 自訂 (逗號分隔，如 zh-TW,ja-JP)"
  } >&2
  read -e -r -p "  選擇 [1]: " ans
  case "${ans:-1}" in
    1) printf '%s' "$CORE_LOCALES" ;;
    2) printf '%s' "$DEFAULT_LOCALES" ;;
    3) read -e -r -p "  輸入語言: " ans >&2; printf '%s' "$ans" ;;
    *) printf '%s' "$ans" ;; # anything else: treat as a locale string typed directly
  esac
}

run_product() {
  echo ""
  echo "── Product 匯入前 diff ──"
  local orig trans ids loc
  orig=$(pick_file "原始/最新匯出 catalog (.xml)"); need_file "$orig" || return
  trans=$(pick_file "翻譯後 catalog (.xml)"); need_file "$trans" || return
  ids=$(ask "Product IDs (逗號分隔)")
  loc=$(pick_locales)
  echo ""
  $NODE "$SCRIPTS/validate-product-diff.js" "$orig" "$trans" --product-ids "$ids" --locales "$loc"
}

run_pd() {
  echo ""
  echo "── Page Designer 匯入前 diff ──"
  local orig trans ids loc
  orig=$(pick_file "原始/最新匯出 library (.xml)"); need_file "$orig" || return
  trans=$(pick_file "翻譯後 library (.xml)"); need_file "$trans" || return
  ids=$(ask "Product IDs (逗號分隔)")
  loc=$(pick_locales)
  echo ""
  $NODE "$SCRIPTS/validate-pagedesigner-diff.js" "$orig" "$trans" --product-ids "$ids" --locales "$loc"
}

run_coverage() {
  echo ""
  echo "── 漏翻 / 語言錯置掃描 ──"
  local xml loc ans mo
  xml=$(pick_file "要掃描的 catalog/library (.xml)"); need_file "$xml" || return
  loc=$(pick_locales)
  read -r -p "  只看完全沒值的 (missing-only)? [y/N]: " ans
  mo=""
  case "$ans" in [Yy]*) mo="--missing-only" ;; esac
  echo ""
  $NODE "$SCRIPTS/check-translation-coverage.js" "$xml" --locales "$loc" $mo
}

while true; do
  echo ""
  echo "======== SFCC 翻譯驗證選單 ========"
  echo "  1) Product XML       匯入前 diff (SAFE / NOT SAFE / BASELINE MISMATCH)"
  echo "  2) Page Designer XML 匯入前 diff"
  echo "  3) 漏翻 / 語言錯置掃描"
  echo "  q) 離開"
  read -r -p "選擇: " choice
  case "$choice" in
    1) run_product ;;
    2) run_pd ;;
    3) run_coverage ;;
    q | Q | "") echo "掰掰 👋"; exit 0 ;;
    *) echo "  無效選項，請輸入 1 / 2 / 3 / q" ;;
  esac
done
