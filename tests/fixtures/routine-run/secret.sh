#!/bin/sh
# Gibt ein Geheimnis aus $ROUTINE_TEST_SECRET in zwei getrennten Stücken aus
half=$(printf '%s' "$ROUTINE_TEST_SECRET" | cut -c1-8)
rest=$(printf '%s' "$ROUTINE_TEST_SECRET" | cut -c9-)
printf 'schluessel=%s' "$half"
sleep 0.2
printf '%s ende\n' "$rest"
