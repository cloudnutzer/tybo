#!/bin/sh
# 50 Zeilen, dazwischen Leerzeilen, am Ende ein Rest ohne Zeilenumbruch
i=1
while [ "$i" -le 50 ]; do
  echo "zeile $i"
  echo ""
  i=$((i + 1))
done
printf 'rest-ohne-umbruch'
