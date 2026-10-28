#!/bin/sh
# Routinen-Wrapper (Issue #285): eine Zeile auf stdout, eine auf stderr, Exit-Code aus $1
echo "aus-stdout"
echo "aus-stderr" >&2
exit "${1:-0}"
