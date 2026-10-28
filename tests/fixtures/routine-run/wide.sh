#!/bin/sh
# UTF-8 und eine überlange Zeile; „ä" als Bytes, damit es nicht vom Locale abhängt (tr unter LC_ALL=C)
echo "Grüße aus der Routine 🎉"
printf '\303\244%.0s' $(seq 1 5000)
echo ""
