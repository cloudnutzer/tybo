# Baut aus dem Asterisk-Quellbaum nur libasteriskpj.so.2 (pjproject mit den
# Patches aus third-party/pjproject/patches/), nicht den Rest von Asterisk.
# Aufruf im Quellbaum nach ./configure: make -f pjlib.mak pjlib
# Die Regel entspricht der für die Unterordner im Makefile von Asterisk,
# nur mit dem Ziel libasteriskpj.so.2 statt all.
include Makefile

pjlib: makeopts third-party .lastclean main/version.c include/asterisk/build.h defaults.h
	+@_ASTCFLAGS="$(OTHER_SUBDIR_CFLAGS) $(_ASTCFLAGS)" ASTCFLAGS="$(ASTCFLAGS)" _ASTLDFLAGS="$(_ASTLDFLAGS)" ASTLDFLAGS="$(ASTLDFLAGS)" $(SUBMAKE) --no-builtin-rules -C main SUBDIR=main libasteriskpj.so.2
